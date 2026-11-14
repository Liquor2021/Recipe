import { recordsApi } from "@/api"
import type { Dish, MealRecord } from "@/types"
import type { TomorrowDraftState, TomorrowProfile } from "@/lib/tomorrowDraft"
import { ChefHat, Flame, Heart, Leaf, Moon, Sparkles, Zap, type LucideIcon } from "lucide-react"
export type MealType = "lunch" | "dinner"
export type PlanProfile = TomorrowProfile
export const mealOrder: MealType[] = ["lunch", "dinner"]
export const defaultTargets: Record<MealType, number> = { lunch: 2, dinner: 2 }
export const maxPerMeal = 5
export const profileOptions: Array<{
  key: PlanProfile
  label: string
  hint: string
  Icon: LucideIcon
}> = [
  { key: "balanced", label: "均衡", hint: "正常搭配", Icon: Sparkles },
  { key: "quick", label: "快手", hint: "省时间", Icon: Zap },
  { key: "light", label: "清淡", hint: "少负担", Icon: Leaf },
  { key: "spicy", label: "想吃辣", hint: "重口味", Icon: Flame },
  { key: "favorite", label: "收藏", hint: "优先常吃", Icon: Heart }
]
export const mealMeta: Record<
  MealType,
  {
    label: string
    shortLabel: string
    helper: string
    accent: string
    soft: string
    text: string
    Icon: LucideIcon
  }
> = {
  lunch: {
    label: "明天午餐",
    shortLabel: "午餐",
    helper: "中午吃得稳一点",
    accent: "bg-primary",
    soft: "bg-primary-light",
    text: "text-primary",
    Icon: ChefHat
  },
  dinner: {
    label: "明天晚餐",
    shortLabel: "晚餐",
    helper: "晚上吃得舒服一点",
    accent: "bg-mint",
    soft: "bg-mint-light",
    text: "text-mint",
    Icon: Moon
  }
}
export function diffLabel(difficulty: string) {
  if (difficulty === "easy") return "简单"
  if (difficulty === "medium") return "中等"
  return "费点劲"
}
export function uniqueById(items: Dish[]) {
  const seen = new Set<number>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}
export function mealRecords(records: MealRecord[], meal: MealType) {
  return records
    .filter((r) => r.meal_type === meal && r.status !== "cancelled")
    .slice()
    .sort((a, b) => a.id - b.id)
}
export function keyFromRecords(records: MealRecord[]) {
  return mealOrder
    .map(
      (meal) =>
        `${meal}:${mealRecords(records, meal)
          .map((r) => r.dish_id)
          .sort((a, b) => a - b)
          .join(",")}`
    )
    .join("|")
}
export function keyFromDishes(lunch: Dish[], dinner: Dish[]) {
  return `lunch:${lunch
    .map((d) => d.id)
    .sort((a, b) => a - b)
    .join(",")}|dinner:${dinner
    .map((d) => d.id)
    .sort((a, b) => a - b)
    .join(",")}`
}
export function recordToDish(record: MealRecord): Dish {
  return {
    id: record.dish_id,
    name: record.dish_name,
    image_url: record.dish_image_url || "",
    video_url: "",
    images: [],
    category: "",
    meal_type: record.meal_type,
    taste: "",
    ingredients: [],
    seasonings: [],
    steps: [],
    cook_time: 0,
    difficulty: "easy",
    remark: "",
    favorite: false,
    enabled: true,
    tags: [],
    sort_order: 0,
    created_at: record.created_at,
    updated_at: record.created_at
  }
}
// 用完整菜品替换同 id 的占位菜（找不到的保持原样，如菜已被删除）
export function hydrateDishes(dishes: Dish[], full: Dish[] | undefined) {
  if (!full || full.length === 0) return dishes
  const byId = new Map(full.map((d) => [d.id, d]))
  return dishes.map((d) => byId.get(d.id) ?? d)
}
export interface SavePlanPayload {
  date: string
  draft: TomorrowDraftState
  version: string
  requestID: string
  dishes: {
    dish_id: number
    meal_type: string
  }[]
  wasSaved: boolean
}
export type PlanSnapshot = Awaited<ReturnType<typeof recordsApi.plan>>
export type PlanConflict = {
  latest: PlanSnapshot | null
  reason: "changed" | "unconfirmed"
}
