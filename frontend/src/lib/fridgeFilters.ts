import type { InventoryBatch } from "../types/index.ts"

export type FridgeFilter = "all" | "soon" | "expired"

export function parseFridgeFilter(value: string | null): FridgeFilter {
  return value === "soon" || value === "expired" ? value : "all"
}

function dateOrdinal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(value + "T00:00:00Z")
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
  return date.getTime() / 86400000
}

// 日期按日历天比较，避免夏令时让相邻两天只差 23 或 25 小时。
export function fridgeDaysLeft(expiry: string, today: string): number | null {
  const expiryDay = dateOrdinal(expiry)
  const todayDay = dateOrdinal(today)
  return expiryDay === null || todayDay === null ? null : expiryDay - todayDay
}

export function matchesFridgeFilter(batch: InventoryBatch, filter: FridgeFilter, today: string): boolean {
  if (filter === "all") return true
  const left = fridgeDaysLeft(batch.expiry_date, today)
  if (left === null) return false
  return filter === "expired" ? left < 0 : left >= 0 && left <= 2
}

export function searchFridge(items: InventoryBatch[], search: string): InventoryBatch[] {
  const keyword = search.trim().toLocaleLowerCase()
  return keyword ? items.filter((item) => item.item_name.toLocaleLowerCase().includes(keyword)) : items
}
