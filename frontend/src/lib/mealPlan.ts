import type { QueryClient } from "@tanstack/react-query"
import type { MealRecord } from "@/types"
import { localDateKey } from "./planDate.ts"

export type PlanMeal = "lunch" | "dinner"
export type PlanSnapshot = { records: MealRecord[]; version: string }
export type PlanDay = PlanSnapshot & { date: string }
export type PlanWeek = { days: PlanDay[]; version: string; replayed?: boolean }
export type PlanSelection = { dish_id: number; meal_type: string; pinned?: boolean }
export const planMeals: PlanMeal[] = ["lunch", "dinner"]
export const planMealLabels = { lunch: "午市", dinner: "晚市" }
export function planSelections(records: MealRecord[]): PlanSelection[] {
  return records.map(row => ({ dish_id: row.dish_id, meal_type: row.meal_type, pinned: !!row.plan_pinned }))
}
export function planRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `plan_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`
}
export function validPlanDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T12:00:00`)
  return !Number.isNaN(date.getTime()) && localDateKey(date) === value ? value : null
}
export function planWeekStart(date: string) {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() - (d.getDay() + 6) % 7)
  return localDateKey(d)
}
export function shiftPlanDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return localDateKey(d)
}
export async function refreshMealPlans(qc: QueryClient) {
  await Promise.all(["records", "shopping-list", "record", "dish-records", "achievements", "stats"].map(key => qc.invalidateQueries({ queryKey: [key] })))
  await qc.invalidateQueries({ queryKey: ["admin", "records"] })
}
