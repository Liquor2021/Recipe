import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { recordsApi, dishesApi, getUploadErrorMessage } from "@/api"
import type { MealRecord, Dish } from "@/types"
import toast from "react-hot-toast"
import { createHistoryCache } from "@/pages/history/cache"
export function useHistoryRecordActions() {
  const qc = useQueryClient()
  const { refreshMealQueries } = createHistoryCache(qc)
  const [rescheduleRecord, setRescheduleRecord] = useState<MealRecord | null>(null)
  const [inventoryRecord, setInventoryRecord] = useState<MealRecord | null>(null)
  const [undoRecord, setUndoRecord] = useState<MealRecord | null>(null)
  const [consumption, setConsumption] = useState<{
    dish: Dish
    portionScale: number
    recordId: number
  } | null>(null)
  const statusMut = useMutation({
    mutationFn: ({ record, status }: { record: MealRecord; status: MealRecord["status"] }) =>
      recordsApi.update(record.id, { status }),
    onSuccess: async (saved, { record, status }) => {
      toast.success(
        status === "completed" ? "已记为吃过" : status === "cancelled" ? "已取消计划" : "已恢复计划"
      )
      const refreshing = refreshMealQueries()
      if (status === "completed") {
        try {
          const dish = await qc.fetchQuery({
            queryKey: ["dish", record.dish_id],
            queryFn: () => dishesApi.get(record.dish_id)
          })
          setConsumption({
            dish,
            portionScale: saved.portion_scale || record.portion_scale || 1,
            recordId: saved.id
          })
        } catch {
          toast.error("已记为吃过，暂时无法读取菜谱用量，可稍后点击补扣库存")
        }
      }
      await refreshing
    },
    onError: (err) => toast.error(getUploadErrorMessage(err, "更新计划失败，请稍后重试"))
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => recordsApi.delete(id),
    onSuccess: () => {
      void refreshMealQueries()
      toast.success("已删除")
    },
    onError: (err) => {
      toast.error(getUploadErrorMessage(err, "删除失败"))
    }
  })
  const rescheduleMut = useMutation({
    mutationFn: ({
      record,
      meal_date,
      meal_type
    }: {
      record: MealRecord
      meal_date: string
      meal_type: string
    }) => recordsApi.update(record.id, { meal_date, meal_type }),
    onSuccess: async () => {
      setRescheduleRecord(null)
      toast.success("计划已改期，份量和购物状态已保留")
      await refreshMealQueries()
    }
  })
  const undoMut = useMutation({
    mutationFn: ({ record, entryId }: { record: MealRecord; entryId: number | null }) =>
      recordsApi.undoCompletion(record.id, entryId),
    onSuccess: async (_, { entryId }) => {
      setUndoRecord(null)
      toast.success(entryId !== null ? "已恢复为计划，库存扣减已撤销" : "已恢复为待完成计划")
      await refreshMealQueries()
    }
  })
  const supplementMut = useMutation({
    mutationFn: async (record: MealRecord) => {
      const [current, dish] = await Promise.all([
        recordsApi.get(record.id),
        qc.fetchQuery({
          queryKey: ["dish", record.dish_id],
          queryFn: () => dishesApi.get(record.dish_id)
        })
      ])
      if (current.status !== "completed") throw new Error("这条记录已不再是已吃状态，请刷新后重试")
      if (current.inventory_applied) throw new Error("这顿已经扣过库存，可在库存记录中查看")
      return { dish, portionScale: current.portion_scale || 1, recordId: current.id }
    },
    onSuccess: (next) => {
      setInventoryRecord(null)
      setConsumption(next)
    },
    onError: (err) => toast.error(getUploadErrorMessage(err, "读取库存用量失败，请稍后重试"))
  })
  function requestDelete(record: MealRecord) {
    if (recordActionPending) return
    if (record.inventory_applied) {
      toast.error("请先在库存记录中撤销扣减，再删除这条记录")
      setInventoryRecord(record)
      return
    }
    deleteMut.mutate(record.id)
  }
  function openReschedule(record: MealRecord) {
    rescheduleMut.reset()
    setRescheduleRecord(record)
  }
  function openUndo(record: MealRecord) {
    undoMut.reset()
    setUndoRecord(record)
  }
  const recordActionPending =
    statusMut.isPending ||
    rescheduleMut.isPending ||
    undoMut.isPending ||
    supplementMut.isPending ||
    deleteMut.isPending
  return {
    rescheduleRecord,
    setRescheduleRecord,
    inventoryRecord,
    setInventoryRecord,
    undoRecord,
    setUndoRecord,
    consumption,
    setConsumption,
    statusMut,
    deleteMut,
    rescheduleMut,
    undoMut,
    supplementMut,
    requestDelete,
    openReschedule,
    openUndo,
    recordActionPending
  }
}
