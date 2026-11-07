import { useState } from "react"
import { createPortal } from "react-dom"
import type { MealRecord } from "@/types"

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export default function ReschedulePlanSheet({ record, pending, error, onSubmit, onClose }: {
  record: MealRecord
  pending: boolean
  error?: string
  onSubmit: (data: { meal_date: string; meal_type: string }) => void
  onClose: () => void
}) {
  const today = dateKey(new Date())
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowKey = dateKey(tomorrow)
  const [mealDate, setMealDate] = useState(record.meal_date < today ? today : record.meal_date)
  const [mealType, setMealType] = useState(record.meal_type)
  const unchanged = mealDate === record.meal_date && mealType === record.meal_type

  return createPortal(
    <div className="fixed inset-0 z-[400] bg-black/45 backdrop-blur-sm flex items-end justify-center" onClick={() => !pending && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-title"
        className="bg-card w-full max-w-[640px] rounded-t-2xl p-5 max-h-[90dvh] overflow-y-auto animate-slide-in-up"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape" && !pending) onClose() }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!pending && mealDate >= today && !unchanged) onSubmit({ meal_date: mealDate, meal_type: mealType })
        }}
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 id="reschedule-title" className="text-base font-bold">调整做菜计划</h2>
          <button type="button" aria-label="关闭改期" disabled={pending} onClick={onClose} className="w-11 h-11 flex-shrink-0 rounded-full text-text3 active:bg-bg disabled:opacity-50">✕</button>
        </div>
        <p className="text-sm font-semibold">{record.dish_name}</p>
        <p className="mt-1 mb-4 text-xs text-text2">原计划 {record.meal_date} {record.meal_type === "lunch" ? "午餐" : "晚餐"} · 原量 × {record.portion_scale || 1}</p>
        <button type="button" disabled={pending || (record.meal_date === tomorrowKey && mealType === record.meal_type)} onClick={() => onSubmit({ meal_date: tomorrowKey, meal_type: mealType })} className="min-h-11 px-4 mb-4 rounded-xl bg-primary-light text-primary text-sm font-semibold disabled:opacity-50">移到明天</button>
        <label htmlFor="plan-date" className="block mb-2 text-xs text-text2 font-semibold">日期</label>
        <input autoFocus id="plan-date" type="date" min={today} required value={mealDate} disabled={pending} onChange={(event) => setMealDate(event.target.value)} className="w-full min-h-11 min-w-0 px-3 rounded-xl border border-border bg-bg text-sm outline-none focus:border-primary disabled:opacity-50" />
        <fieldset disabled={pending} className="mt-4">
          <legend className="mb-2 text-xs text-text2 font-semibold">餐次</legend>
          <div className="grid grid-cols-2 gap-3">
            {[["lunch", "午餐"], ["dinner", "晚餐"]].map(([value, label]) => (
              <label key={value} className={`min-h-11 flex items-center justify-center gap-2 rounded-xl border text-sm font-medium cursor-pointer ${mealType === value ? "border-primary bg-primary-light text-primary" : "border-border bg-bg text-text2"}`}>
                <input type="radio" name="plan-meal-type" value={value} checked={mealType === value} onChange={() => setMealType(value)} className="accent-primary" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-4 text-xs text-text3 leading-relaxed">改期会保留份量、已买和已入库的标记。</p>
        {error && <p role="alert" className="mt-3 text-sm text-red">{error}</p>}
        <button type="submit" disabled={pending || unchanged || !mealDate || mealDate < today} className="w-full min-h-11 mt-5 rounded-full bg-primary text-white text-sm font-semibold disabled:opacity-40 active:scale-95">{pending ? "正在保存…" : "保存改期"}</button>
      </form>
    </div>,
    document.body,
  )
}
