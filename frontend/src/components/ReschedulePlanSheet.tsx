import { useId, useState } from "react"
import { CalendarDays } from "lucide-react"
import type { MealRecord } from "@/types"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import KitchenSheet from "@/components/KitchenSheet"
import { planDateShortcuts, localDateKey } from "@/lib/planDate"

export default function ReschedulePlanSheet({ record, pending, error, onSubmit, onClose }: {
  record: MealRecord
  pending: boolean
  error?: string
  onSubmit: (data: { meal_date: string; meal_type: string }) => void
  onClose: () => void
}) {
  const theme = useKitchenTheme((state) => state.theme)
  const formId = useId()
  const today = localDateKey(new Date())
  const [mealDate, setMealDate] = useState(record.meal_date < today ? today : record.meal_date)
  const [mealType, setMealType] = useState(record.meal_type)
  const unchanged = mealDate === record.meal_date && mealType === record.meal_type
  const disabled = pending || unchanged || !mealDate || mealDate < today

  return (
    <KitchenSheet title="调整做菜计划" icon={<CalendarDays size={19} />} theme={theme} onClose={onClose} closeDisabled={pending} closeLabel="关闭改期" footer={<>
      <button type="button" disabled={pending} onClick={onClose}>暂不调整</button>
      <button type="submit" form={formId} disabled={disabled} className="is-ink">{pending ? "正在保存…" : "保存改期"}</button>
    </>}>
      <form id={formId} onSubmit={(event) => { event.preventDefault(); if (!disabled) onSubmit({ meal_date: mealDate, meal_type: mealType }) }}>
        <p className="kitchen-sheet-context"><strong>{record.dish_name}</strong><span>原计划 {record.meal_date} {record.meal_type === "lunch" ? "午市" : "晚市"} · 原量 × {record.portion_scale || 1}</span></p>
        <div className="kitchen-date-shortcuts">
          {planDateShortcuts(new Date()).map(({ label, date }) => <button key={label} type="button" disabled={pending} aria-pressed={mealDate === date} onClick={() => setMealDate(date)}>{label}</button>)}
        </div>
        <label htmlFor={formId + "-date"} className="block mb-2 text-xs text-text2 font-semibold">日期</label>
        <input id={formId + "-date"} type="date" min={today} required value={mealDate} disabled={pending} onChange={(event) => setMealDate(event.target.value)} className="kitchen-date-input" />
        <fieldset disabled={pending} className="mt-4">
          <legend className="mb-2 text-xs text-text2 font-semibold">餐次</legend>
          <div className="grid grid-cols-2 gap-3">
            {[["lunch", "午餐"], ["dinner", "晚餐"]].map(([value, label]) => (
              <label key={value} className={`min-h-10 flex items-center justify-center gap-2 rounded border text-[13px] cursor-pointer ${mealType === value ? "border-primary bg-primary-light text-primary" : "border-border text-text2"}`}>
                <input type="radio" name="plan-meal-type" value={value} checked={mealType === value} onChange={() => setMealType(value)} className="accent-primary" />{label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="kitchen-sheet-hint mt-4">选好日期和餐次后保存，会保留份量、已买和已入库的标记。</p>
        {error && <p role="alert" className="mt-3 text-sm text-red">{error}</p>}
      </form>
    </KitchenSheet>
  )
}
