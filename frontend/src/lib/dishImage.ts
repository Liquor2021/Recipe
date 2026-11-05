// 菜品图片/emoji 的取值规则（DishImage 组件与菜品详情、记录列表共用）
import type { Dish } from "@/types"
import { asArray } from "@/lib/utils"

const categoryEmojis: Record<string, string> = {
  川菜: "🌶", 粤菜: "🐟", 家常菜: "🍳", 快手菜: "⚡",
  汤品: "🍲", 主食: "🍚", 小食: "🥟",
}

// 菜系 emoji；image_url 里存的若是 emoji 文本（不是图片地址）也用它，否则用默认的盘子
export function getDishEmoji(d: Dish): string {
  return categoryEmojis[d.category] || (d.image_url && !isImageUrl(d.image_url) ? d.image_url : "") || "🍽"
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

// 列表/卡片用的缩略图地址：/uploads/… → /thumbs/…（后端第一次请求时按原图生成，约为原图的 1/3 大小）。
// 外链和非上传图原样返回；大图（详情头图、照片查看器、首页推荐大卡片）继续用原图
export function thumbUrl(url: string): string
export function thumbUrl(url: string | null | undefined): string | null | undefined
export function thumbUrl(url: string | null | undefined): string | null | undefined {
  return url && url.startsWith("/uploads/") ? "/thumbs/" + url.slice("/uploads/".length) : url
}
