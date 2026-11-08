import { useState, type ReactNode } from "react"
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Check, Pin, Plus, RefreshCw, Pencil, X } from "lucide-react"
import { getUploadErrorMessage, pickApi, recordsApi } from "@/api"
import DishPickerModal from "@/components/DishPickerModal"
import { localDateKey } from "@/lib/planDate"
import { planMealLabels, planMeals, planRequestId, planSelections, refreshMealPlans } from "@/lib/mealPlan"
import type { PlanMeal, PlanSelection, PlanSnapshot } from "@/lib/mealPlan"
import type { Dish, MealRecord } from "@/types"
import "@/styles/kitchen-planner.css"

type Picker = { meal: PlanMeal; replace?: number }
export default function DayPlanEditor({ date, snapshot, excludeIds = [], renderRecord }: {
  date: string; snapshot?: PlanSnapshot; excludeIds?: number[]; renderRecord?: (record: MealRecord) => ReactNode
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [picker, setPicker] = useState<Picker | null>(null)
  const [error, setError] = useState("")
  const pending = useMutationState({ filters: { mutationKey: ["meal-plan-edit"], status: "pending" } }).length > 0
  const query = useQuery({ queryKey: ["records", "meal-plan", date], queryFn: () => recordsApi.plan(date), enabled: !snapshot })
  const plan = snapshot ?? query.data
  const records = plan?.records ?? []
  const editable = date >= localDateKey(new Date())
  const busy = pending || (!snapshot && query.isFetching)

  const edit = useMutation({
    mutationKey: ["meal-plan-edit", date],
    mutationFn: async (operation: { dishes?: PlanSelection[]; random?: MealRecord; baseline: PlanSnapshot }) => {
      let dishes = operation.dishes ?? planSelections(operation.baseline.records)
      if (operation.random) {
        const row = operation.random
        const excluded = [...new Set([...excludeIds, ...operation.baseline.records.map(r => r.dish_id)])]
        const result = await pickApi.tomorrow({ meal_type: row.meal_type as PlanMeal, profile: "balanced", count: 1, exclude_ids: excluded })
        const next = result.dishes?.find(dish => !excluded.includes(dish.id))
        if (!next) throw new Error("暂时没有其他合适的菜，可以试试手选")
        dishes = dishes.map(item => item.meal_type === row.meal_type && item.dish_id === row.dish_id ? { dish_id: next.id, meal_type: row.meal_type, pinned: false } : item)
      }
      return recordsApi.savePlan(date, { expected_version: operation.baseline.version, request_id: planRequestId(), dishes })
    },
    onSuccess: async (saved) => {
      qc.setQueryData(["records", "meal-plan", date], saved)
      setError("")
      if (picker?.replace) setPicker(null)
      await refreshMealPlans(qc)
    },
    onError: async (err) => {
      setError(getUploadErrorMessage(err, "保存结果未确认，请刷新菜单后核对"))
      setPicker(null)
      await refreshMealPlans(qc)
    },
  })
  function save(dishes: PlanSelection[]) {
    if (!plan || !editable || busy || qc.isMutating({ mutationKey: ["meal-plan-edit"] })) return
    edit.mutate({ dishes, baseline: plan })
  }
  function add(dish: Dish) {
    if (!picker || !plan) return
    const selection = planSelections(records)
    if (picker.replace) {
      save(selection.map(item => item.meal_type === picker.meal && item.dish_id === picker.replace ? { dish_id: dish.id, meal_type: picker.meal, pinned: false } : item))
    } else if (records.filter(row => row.meal_type === picker.meal).length < 5) {
      save([...selection, { dish_id: dish.id, meal_type: picker.meal }])
    }
  }
  function remove(meal: PlanMeal, id: number) {
    const record = records.find(row => row.dish_id === id && row.meal_type === meal)
    if (!record || record.status !== "planned" || record.plan_pinned) return
    save(planSelections(records).filter(item => item.meal_type !== meal || item.dish_id !== id))
  }
  if (!plan) return <div className="planner-feedback" role="status">{query.isError ? <button onClick={() => void query.refetch()}>菜单读取失败，点此重试</button> : "正在读取菜单…"}</div>
  return <div className="planner-day-editor" aria-label={`${date}菜单`} aria-busy={edit.isPending}>
    {(error || (!snapshot && query.isError)) && <p className="planner-feedback is-error" role="alert">{error || "菜单更新失败，请重新读取后再修改"}<button disabled={busy} onClick={() => void refreshMealPlans(qc)}>刷新菜单</button></p>}
    {planMeals.map(meal => {
      const rows = records.filter(row => row.meal_type === meal)
      return <section className={`planner-meal is-${meal}`} key={meal} aria-label={`${date}${planMealLabels[meal]}`}>
        <div className="planner-meal-heading"><span className="planner-meal-stamp">{planMealLabels[meal]}</span><small>{rows.length ? `${rows.length} 道` : "留个位置"}</small></div>
        <div className="planner-meal-rows">
          {rows.map(row => <div className={`planner-dish ${row.plan_pinned ? "is-pinned" : ""} ${renderRecord ? "has-record" : ""}`} key={row.id}>
            {renderRecord ? renderRecord(row) : <><button type="button" className="planner-dish-name" onClick={() => navigate(`/dishes/${row.dish_id}`)}>{row.dish_name}</button>{row.status === "completed" && <span className="planner-eaten"><Check size={12} />已吃</span>}</>}
            {editable && row.status === "planned" && <div className="planner-actions">
              <button type="button" title={row.plan_pinned ? "先取消钉住再换菜" : "随机换一道"} aria-label={`随机替换${row.dish_name}`} disabled={busy || row.plan_pinned} onClick={() => { if (!qc.isMutating({ mutationKey: ["meal-plan-edit"] })) edit.mutate({ random: row, baseline: plan }) }}><RefreshCw size={14} /></button>
              <button type="button" title="手选替换" aria-label={`手选替换${row.dish_name}`} disabled={busy || row.plan_pinned} onClick={() => setPicker({ meal, replace: row.dish_id })}><Pencil size={14} /></button>
              <button type="button" title={row.plan_pinned ? "取消钉住" : "钉住，重排时保留"} aria-label={`${row.plan_pinned ? "取消钉住" : "钉住"}${row.dish_name}`} aria-pressed={!!row.plan_pinned} disabled={busy} onClick={() => save(planSelections(records).map(item => item.dish_id === row.dish_id && item.meal_type === meal ? { ...item, pinned: !row.plan_pinned } : item))}><Pin size={14} /></button>
              <button type="button" title="移除这道菜" aria-label={`移除${row.dish_name}`} disabled={busy || row.plan_pinned} onClick={() => remove(meal, row.dish_id)}><X size={14} /></button>
            </div>}
          </div>)}
          {editable && <button className="planner-add" type="button" disabled={busy || rows.length >= 5} onClick={() => setPicker({ meal })}><Plus size={14} />{rows.length >= 5 ? "本餐已满 · 5 道" : rows.length ? "加一道" : `安排${planMealLabels[meal]}`}</button>}
          {!editable && !rows.length && <p className="planner-blank">这餐没有记录</p>}
        </div>
      </section>
    })}
    {edit.isPending && <p className="planner-feedback" role="status">正在保存菜单…</p>}
    {picker && <DishPickerModal key={`${date}-${picker.meal}-${picker.replace ?? "add"}`} date={date} meal={picker.meal} singlePick={!!picker.replace} busy={busy}
      selectedMealById={new Map([...records.filter(row => row.meal_type !== picker.meal), ...records.filter(row => row.meal_type === picker.meal)].map(row => [row.dish_id, row.meal_type as PlanMeal]))}
      lockedIds={records.filter(row => row.meal_type === picker.meal && (row.plan_pinned || row.status !== "planned")).map(row => row.dish_id)}
      onAdd={add} onRemove={remove} onClose={() => setPicker(null)} />}
  </div>
}
