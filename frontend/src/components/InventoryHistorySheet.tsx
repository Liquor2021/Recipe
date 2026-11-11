import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Refrigerator } from "lucide-react"
import { recordsApi, getUploadErrorMessage } from "@/api"
import KitchenSheet from "@/components/KitchenSheet"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import type { MealRecord } from "@/types"
import toast from "react-hot-toast"

export default function InventoryHistorySheet({ record, onClose, onSupplement }: {
  record: MealRecord | null
  onClose: () => void
  onSupplement: (record: MealRecord) => void
}) {
  return record ? <InventoryHistoryBody key={record.id} record={record} onClose={onClose} onSupplement={onSupplement} /> : null
}

function InventoryHistoryBody({ record, onClose, onSupplement }: {
  record: MealRecord
  onClose: () => void
  onSupplement: (record: MealRecord) => void
}) {
  const qc = useQueryClient()
  const theme = useKitchenTheme((state) => state.theme)
  const [confirmEntryId, setConfirmEntryId] = useState<number | null>(null)
  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["record-consumption", record.id],
    queryFn: () => recordsApi.consumption(record.id),
    staleTime: 0,
  })
  const activeEntryId = data?.entries.find(entry => entry.status === "applied")?.id
  const undoMut = useMutation({
    mutationFn: (entryId: number) => recordsApi.undoConsumption(record.id, entryId),
    onSuccess: () => {
      setConfirmEntryId(null)
      toast.success("已撤销扣减，库存已恢复")
      for (const key of ["record-consumption", "records", "record", "fridge", "fridge-recipes", "fridge-urgent", "shopping-list", "fridge-consumption"]) {
        void qc.invalidateQueries({ queryKey: [key] })
      }
    },
    onError: (err) => toast.error(getUploadErrorMessage(err, "撤销失败")),
  })

  return <KitchenSheet
    title="库存扣减记录"
    theme={theme}
    icon={<Refrigerator size={18} />}
    onClose={onClose}
    closeLabel="关闭库存记录"
    closeDisabled={undoMut.isPending}
    footer={!isPending && !isError && data && (data.applied ? confirmEntryId !== null ? <>
      <button disabled={undoMut.isPending} onClick={() => setConfirmEntryId(null)}>返回</button>
      <button className="is-danger" disabled={undoMut.isPending || isFetching || activeEntryId !== confirmEntryId} onClick={() => undoMut.mutate(confirmEntryId)}>{undoMut.isPending ? "正在撤销…" : "确认撤销扣减"}</button>
    </> : <button disabled={isFetching || !activeEntryId} onClick={() => { if (activeEntryId) setConfirmEntryId(activeEntryId) }}>撤销本次扣减</button> : (
      <button className="is-ink" disabled={isFetching} onClick={() => { onClose(); onSupplement(record) }}>补扣库存</button>
    ))}
  >
      <div className="kitchen-sheet-context break-words">
        <strong>{record.dish_name}</strong>
        <span>{record.meal_date} · {record.meal_type === "lunch" ? "午市" : "晚市"}</span>
      </div>
      {isPending ? <p className="py-5 text-center text-sm text-text3" role="status">正在读取扣减记录…</p> : isError ? (
        <button className="w-full min-h-11 text-sm text-primary" onClick={() => void refetch()}>读取失败，点此重试</button>
      ) : data ? <>
        <p className="text-sm text-text2 mb-4">{data.applied ? "这顿已扣过库存，可查看每批食材的变化。" : data.entries.length > 0 ? "之前的扣减已撤销，可按实际用量重新扣减。" : "暂未记录这顿的库存扣减。补扣前请确认实际库存，避免重复。"}</p>
        <div className="space-y-3 mb-4">
          {data.entries.map(entry => <div key={entry.id} className="rounded border border-border bg-bg p-3">
            <div className="flex items-start justify-between gap-2 text-xs mb-2">
              <time className="text-text3" dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
              <span className={entry.status === "applied" ? "text-primary font-semibold" : "text-text3"}>{entry.status === "applied" ? "已扣减" : "已撤销"}</span>
            </div>
            <ul className="space-y-2 text-sm">
              {entry.items.map(item => <li key={item.batch_id} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <span className="font-medium break-words">{item.item_name}</span>
                <span className="text-text2">{item.before_quantity || "未记数量"} → {item.removed ? "用完移出" : item.after_quantity || "未记数量"}</span>
              </li>)}
            </ul>
          </div>)}
          {data.entries.length === 0 && <div className="rounded border border-dashed border-border py-5 text-center text-sm text-text3">还没有这顿的扣减明细</div>}
        </div>
        {undoMut.isError && <div className="mb-3">
          <p className="text-sm text-red" role="alert">{getUploadErrorMessage(undoMut.error, "撤销失败")}</p>
          <button disabled={isFetching} onClick={() => { setConfirmEntryId(null); undoMut.reset(); void refetch() }} className="min-h-11 text-sm text-primary disabled:opacity-50">重新读取扣减记录</button>
        </div>}
        {data.applied && confirmEntryId !== null && <div className="kitchen-sheet-context" role="status">
          <p className="text-sm text-text2">将恢复这次扣减的库存。如果相关批次后来又被修改，将保留现状并提示你处理。</p>
          {activeEntryId !== confirmEntryId && <p className="mt-2 text-sm text-red" role="alert">扣减记录已变动，请返回后重新查看。</p>}
        </div>}
      </> : null}
  </KitchenSheet>
}
