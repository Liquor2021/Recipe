// 菜品图片/emoji 的取值规则（DishImage 组件与菜品详情、记录列表共用）
import type { Dish } from "@/types"
import { asArray } from "@/lib/utils"

const categoryEmojis: Record<string, string> = {
  川菜: "🌶", 粤菜: "🐟", 家常菜: "🍳", 快手菜: "⚡",
  汤品: "🍲", 主食: "🍚", 小食: "🥟",
}

export function getDishEmoji(d: Dish): string {
  return categoryEmojis[d.category] || d.image_url || "🍽"
}

export function isImageUrl(url: string | undefined): boolean {
  if (!url) return false
  return url.startsWith("/uploads/") || url.startsWith("http") || /\.(jpg|jpeg|png|webp|gif|svg)(\?|$)/i.test(url)
}

export function getDishImageUrl(d: Dish): string | null {
  if (isImageUrl(d.image_url)) return d.image_url
  const arr = asArray<string>(d.images)
  if (arr.length > 0 && typeof arr[0] === "string" && isImageUrl(arr[0])) return arr[0]
  return null
}
