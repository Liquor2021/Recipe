import type { MealRecord, DayRating } from "@/types"
import { type RatingSession, mergeSavedRecord } from "@/pages/history/model"
import type { QueryClient } from "@tanstack/react-query"
export function createHistoryCache(qc: QueryClient) {
  function refreshMealQueries() {
    return Promise.all(
      [
        ["records"],
        ["record"],
        ["stats"],
        ["report"],
        ["achievements"],
        ["favorites"],
        ["dish-records"],
        ["shopping-list"],
        ["photo-wall"],
        ["admin", "records"],
        ["admin", "dashboard"],
        ["fridge"],
        ["fridge-recipes"],
        ["fridge-urgent"],
        ["fridge-consumption"],
        ["record-consumption"]
      ].map((queryKey) => qc.invalidateQueries({ queryKey }))
    )
  }
  // 写入状态存于 QueryClient，关闭弹窗甚至卸载页面都不会提前释放同一目标的锁。
  function ratingWritePending(kind: "record" | "day", target: string): boolean {
    return qc
      .getMutationCache()
      .findAll({ mutationKey: ["history-rating", kind], status: "pending" })
      .some((mutation) => {
        const variables = mutation.state.variables as
          | {
              session?: RatingSession
              meal_date?: string
            }
          | undefined
        return (variables?.session?.target ?? variables?.meal_date) === target
      })
  }
  async function syncSavedRecord(saved: MealRecord) {
    await Promise.all(
      ["records", "record", "dish-records"].map((key) => qc.cancelQueries({ queryKey: [key] }))
    )
    qc.setQueryData<MealRecord>(["record", saved.id], (old) => ({ ...old, ...saved }))
    for (const key of ["records", "dish-records"]) {
      qc.setQueriesData({ queryKey: [key] }, (old: unknown) => mergeSavedRecord(old, saved))
    }
  }
  async function syncSavedDayRating(saved: DayRating) {
    await Promise.all([
      qc.cancelQueries({ queryKey: ["day-rating", saved.meal_date], exact: true }),
      qc.cancelQueries({ queryKey: ["day-ratings"] })
    ])
    // 保留其他功能刚更新的字段（如首页心情），只同步本次请求拥有的字段。
    const merge = (old?: DayRating): DayRating => ({
      ...saved,
      ...old,
      photos: saved.photos,
      version: saved.version,
      mood: saved.mood,
      remark: saved.remark
    })
    qc.setQueryData<DayRating>(["day-rating", saved.meal_date], merge)
    qc.setQueriesData<DayRating[]>({ queryKey: ["day-ratings"] }, (old) =>
      old?.map((rating) => (rating.meal_date === saved.meal_date ? merge(rating) : rating))
    )
  }
  return { refreshMealQueries, ratingWritePending, syncSavedRecord, syncSavedDayRating }
}
