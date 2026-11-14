import type { MealRecord, DayRating } from "@/types"
import type { MealMood } from "@/lib/mealRating"
export const weekdays = ["日", "一", "二", "三", "四", "五", "六"]
export const moodOptions = [
  { key: "yum", emoji: "😋", label: "好吃" },
  { key: "ok", emoji: "😐", label: "一般" },
  { key: "no", emoji: "😵", label: "不想再吃" }
]
export const moodEmojiMap: Record<string, string> = {
  yum: "😋",
  ok: "😐",
  no: "😵",
  great: "😋",
  meh: "😕"
}
export const homeMoodEmojiMap: Record<string, string> = {
  happy: "😊",
  tired: "😫",
  lazy: "😌",
  spicy: "🤤",
  healthy: "🌿"
}
export const homeMoodLabelMap: Record<string, string> = {
  happy: "开心",
  tired: "疲惫",
  lazy: "想偷懒",
  spicy: "想吃辣",
  healthy: "想养生"
}
export const todayStr = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
export const statusLabels = { planned: "计划", completed: "已吃", cancelled: "已取消" }
// 每次打开评价都是独立会话；关闭或切换后，旧上传/保存不能改动新的草稿。
export type RatingSession = {
  target: string
  photos: string[]
  uploading: boolean
  saving: boolean
}
export type DayRatingSession = RatingSession & {
  version: string
  readToken: number
  initialMood?: MealMood
}
export type DayRatingConflict = {
  latest: DayRating | null
  reason: "changed" | "unconfirmed"
}
export function isDayRatingConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    error.response.status === 409
  )
}
// 记录查询既有普通分页，也有日历数组和无限分页；只替换已在缓存中的该条记录。
export function mergeSavedRecord(value: unknown, saved: MealRecord): unknown {
  if (Array.isArray(value))
    return value.map((record: MealRecord) =>
      record.id === saved.id ? { ...record, ...saved } : record
    )
  if (!value || typeof value !== "object") return value
  const data = value as {
    items?: MealRecord[]
    records?: MealRecord[]
    pages?: unknown[]
  }
  if (Array.isArray(data.items)) return { ...data, items: mergeSavedRecord(data.items, saved) }
  if (Array.isArray(data.records))
    return { ...data, records: mergeSavedRecord(data.records, saved) }
  if (Array.isArray(data.pages))
    return { ...data, pages: data.pages.map((page) => mergeSavedRecord(page, saved)) }
  return value
}
export function parsePhotos(photosStr: string): string[] {
  try {
    const arr = JSON.parse(photosStr)
    return Array.isArray(arr)
      ? arr.filter((photo): photo is string => typeof photo === "string" && photo !== "")
      : []
  } catch {
    return []
  }
}
