import type { QueryClient, QueryKey } from "@tanstack/react-query"
import type { MealRecord, PaginatedData } from "../types/index.ts"

export const mealSelectionMutationKey = ["meal-selection"] as const

export type MealSelection = Pick<MealRecord, "dish_id" | "meal_date" | "meal_type">

export function mealSelectionKey(selection: MealSelection): string {
  return `${selection.meal_date}:${selection.meal_type}:${selection.dish_id}`
}

export function pendingMealSelectionKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const item = value as Partial<MealSelection>
  if (typeof item.dish_id !== "number" || typeof item.meal_date !== "string" || typeof item.meal_type !== "string") return
  return mealSelectionKey(item as MealSelection)
}

// The mutation cache survives page unmounts; callers also hold a synchronous ref lock.
export function hasPendingMealSelection(client: QueryClient, selection: MealSelection): boolean {
  const key = mealSelectionKey(selection)
  return client.getMutationCache().findAll({ mutationKey: mealSelectionMutationKey, status: "pending" })
    .some(mutation => pendingMealSelectionKey(mutation.state.variables) === key)
}

// Update only the server-confirmed row. In particular, a failed cancellation must
// never restore an old snapshot over successful edits to other dishes.
export function mergeMealSelectionRecord(
  current: PaginatedData<MealRecord> | undefined,
  saved: MealRecord,
): PaginatedData<MealRecord> | undefined {
  if (!current) return current
  const items = current.items ?? []
  const index = items.findIndex(record => record.id === saved.id)
  if (index < 0) return { ...current, items: [saved, ...items], total: current.total + 1 }
  return { ...current, items: items.map((record, i) => i === index ? { ...record, ...saved } : record) }
}

// Keep cancellation, confirmed-row merging and the replacement read in one
// synchronous turn. Awaiting cancellation in onSuccess and starting the read
// later in onSettled leaves an idle gap that can release another row's lock.
export async function reconcileMealSelection(client: QueryClient, date: string, saved?: MealRecord): Promise<void> {
  const queryKey = ["records", "today", date]
  const cancelled = client.cancelQueries({ queryKey, exact: true })
  if (saved) client.setQueryData<PaginatedData<MealRecord>>(queryKey, current => mergeMealSelectionRecord(current, saved))
  const refreshed = client.invalidateQueries({ queryKey, exact: true, refetchType: "all" })
  await Promise.all([cancelled, refreshed])
  await waitForMealSelectionRefresh(client, queryKey)
}

// An overlapping mutation may cancel our refetch and immediately start a newer
// one. Wait for that replacement too, so the toggle cannot briefly unlock with
// a stale selected/unselected state. Errors are surfaced by the page query.
export async function waitForMealSelectionRefresh(client: QueryClient, queryKey: QueryKey): Promise<void> {
  while (client.getQueryState(queryKey)?.fetchStatus === "fetching") {
    await new Promise<void>(resolve => {
      const unsubscribe = client.getQueryCache().subscribe(() => {
        if (client.getQueryState(queryKey)?.fetchStatus !== "fetching") {
          unsubscribe()
          resolve()
        }
      })
    })
  }
}
