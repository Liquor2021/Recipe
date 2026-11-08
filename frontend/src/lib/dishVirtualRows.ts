import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual"
import type { Dish } from "../types/index"

export type DishVirtualRow =
  | { kind: "category"; key: string; category: string; count: number }
  | { kind: "dish"; key: string; dish: Dish; alternate: boolean }

export interface DishVirtualSnapshot {
  width: number
  measurements: VirtualItem[]
  anchor: { key: string; offset: number } | null
}

export function buildDishVirtualRows(dishes: Dish[], grouped: boolean): DishVirtualRow[] {
  const dishRow = (dish: Dish, alternate: boolean): DishVirtualRow => ({ kind: "dish", key: `dish:${dish.id}`, dish, alternate })
  if (!grouped) return dishes.map((dish, index) => dishRow(dish, index % 2 === 1))

  const groups = new Map<string, Dish[]>()
  for (const dish of dishes) {
    const category = dish.category || "其他"
    const group = groups.get(category) ?? []
    group.push(dish)
    groups.set(category, group)
  }
  return Array.from(groups, ([category, items]) => [
    { kind: "category" as const, key: `category:${category}`, category, count: items.length },
    ...items.map((dish, index) => dishRow(dish, index % 2 === 0)),
  ]).flat()
}

// Keep the focused row and its neighbours mounted so Tab can cross the edge
// of the visible window without losing focus or skipping the next recipe.
export function includeFocusedNeighbours(indices: number[], focusedIndex: number, count: number): number[] {
  if (focusedIndex < 0) return indices
  const kept = new Set(indices)
  for (let index = Math.max(0, focusedIndex - 1); index <= Math.min(count - 1, focusedIndex + 1); index++) kept.add(index)
  return [...kept].sort((a, b) => a - b)
}

export function resetDishMeasurements(
  virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLDivElement>, "measure" | "getTotalSize" | "resizeItem">,
  visible: { index: number; size: number }[],
) {
  virtualizer.measure()
  // Rebuild the cleared layout before seeding current DOM sizes. Otherwise a
  // size equal to the old layout is treated as unchanged and lost on rebuild.
  virtualizer.getTotalSize()
  for (const { index, size } of visible) virtualizer.resizeItem(index, size)
}
