import type { MealRecord } from "../types"

function calendarDay(date: string) {
  const [year, month, day] = date.split("-").map(Number)
  // 日期字符串代表本地日历日，用 UTC 序号求差，避免夏令时的 23/25 小时影响。
  return Date.UTC(year, month - 1, day) / 86_400_000
}

export function getPlanDateLabel(date: string, today: string) {
  const days = calendarDay(date) - calendarDay(today)
  if (days < 0) return `已逾期 ${-days} 天`
  if (days === 0) return "今天"
  if (days === 1) return "明天"
  if (days === 2) return "后天"
  const [year, month, day] = date.split("-")
  return `${year === today.slice(0, 4) ? "" : year + "年"}${Number(month)}月${Number(day)}日`
}

type SummaryRecord = Pick<MealRecord, "id" | "dish_id" | "dish_name" | "meal_date" | "meal_type" | "status">

export function getHistoryMonthSummary(records: readonly SummaryRecord[], monthStart: string, monthEnd: string) {
  const seen = new Set<number>()
  const lunches = new Set<string>()
  const dinners = new Set<string>()
  const dishes = new Map<number, { name: string; count: number }>()
  for (const record of records) {
    if (record.status !== "completed" || record.meal_date < monthStart || record.meal_date > monthEnd || seen.has(record.id)) continue
    seen.add(record.id)
    if (record.meal_type === "lunch") lunches.add(record.meal_date)
    if (record.meal_type === "dinner") dinners.add(record.meal_date)
    const dish = dishes.get(record.dish_id) ?? { name: record.dish_name, count: 0 }
    dish.count++
    dishes.set(record.dish_id, dish)
  }
  const topDish = [...dishes.values()].sort((a, b) => b.count - a.count)[0]?.name
  return { meals: lunches.size + dinners.size, dishes: seen.size, lunches: lunches.size, dinners: dinners.size, topDish }
}
