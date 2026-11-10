import type { Dish } from "../types/index.ts"
import type { TomorrowProfile } from "./tomorrowDraft.ts"

type DishIdentity = Pick<Dish, "id">
type PickRequest = {
  meal_type: string
  profile: string
  count: number
  exclude_ids: number[]
  avoid_ids: number[]
}

export class InsufficientTomorrowDishesError extends Error {
  constructor(count: number) {
    super(count === 1 ? "没有其他合适的菜了，原菜单已保留" : `可换的菜不够凑齐 ${count} 道，原菜单已保留，可以手动选菜`)
  }
}

// 每个日期的编辑器独立保留最近看过的菜，只在请求被采纳后记入历史。
export function createTomorrowRecommendations(request: (data: PickRequest) => Promise<{ dishes?: Dish[] }>) {
  let recentIds: number[] = []
  return {
    remember(dishes: readonly DishIdentity[]) {
      const ids = dishes.map(dish => dish.id)
      recentIds = [...new Set([...recentIds.filter(id => !ids.includes(id)), ...ids])].slice(-40)
    },
    async pick({ meal, count, profile, current, allowPartial = false }: {
      meal: "lunch" | "dinner"
      count: number
      profile: TomorrowProfile
      current: readonly DishIdentity[]
      allowPartial?: boolean
    }): Promise<Dish[]> {
      if (count <= 0) return []
      const excluded = new Set(current.map(dish => dish.id))
      let dishes: Dish[] = []
      try {
        const result = await request({
          meal_type: meal, profile, count,
          exclude_ids: [...excluded],
          avoid_ids: recentIds.filter(id => !excluded.has(id)),
        })
        dishes = result.dishes || []
      } catch (error) {
        // 接口用 404 表示无候选；网络或服务故障仍交给页面报告失败。
        if ((error as { response?: { status?: number } })?.response?.status !== 404) throw error
      }
      // 防止旧版服务返回当前菜或重复菜，让“换一批”看起来没有变化。
      const seen = new Set(excluded)
      const picks = dishes.filter(dish => {
        if (seen.has(dish.id)) return false
        seen.add(dish.id)
        return true
      }).slice(0, count)
      if (!allowPartial && picks.length < count) throw new InsufficientTomorrowDishesError(count)
      return picks
    },
  }
}
