import { api, apiFresh } from "@/api/client"
import type { PlanWeek } from "@/lib/mealPlan"

export const mealPlanWeekApi = {
  get: (date: string) => apiFresh<PlanWeek>("GET", `/meal-plan-weeks/${date}`),
  regenerate: (date: string, data: { expected_version: string; request_id: string }) => api<PlanWeek>("POST", `/meal-plan-weeks/${date}/regenerate`, data),
}
