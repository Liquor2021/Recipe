import type { Dish, MealRecord } from "../types/index.ts"

export type TomorrowProfile = "balanced" | "quick" | "light" | "spicy" | "favorite"

export interface TomorrowDraftState {
  lunch: Dish[]
  dinner: Dish[]
  targets: { lunch: number; dinner: number }
  profile: TomorrowProfile
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
type DraftDish = Pick<Dish, "id" | "name" | "image_url" | "category" | "cook_time" | "difficulty">

const storageKey = "ninimenu:tomorrow-draft:v1"
const profiles: TomorrowProfile[] = ["balanced", "quick", "light", "spicy", "favorite"]

function sessionStorageOrNull(): DraftStorage | null {
  try { return window.sessionStorage } catch { return null }
}

// Include record identity and state: cancelling/recreating the same dish is still a new plan.
export function tomorrowPlanBaseline(records: MealRecord[]): string {
  return JSON.stringify(records
    .filter(record => record.status !== "cancelled")
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(record => [record.id, record.dish_id, record.meal_date, record.meal_type, record.status, record.portion_scale, record.inventory_applied]))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isDraftDish(value: unknown): value is DraftDish {
  return isObject(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0
    && typeof value.name === "string" && typeof value.image_url === "string"
    && typeof value.category === "string" && typeof value.difficulty === "string"
    && typeof value.cook_time === "number" && Number.isFinite(value.cook_time)
}

function isDishList(value: unknown): value is DraftDish[] {
  return Array.isArray(value) && value.length <= 100 && value.every(isDraftDish)
    && new Set(value.map(dish => dish.id)).size === value.length
}

function isTarget(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 5
}

function restoreDish(dish: DraftDish, meal: "lunch" | "dinner"): Dish {
  return {
    ...dish, meal_type: meal, video_url: "", images: [], taste: "", ingredients: [],
    seasonings: [], steps: [], remark: "", favorite: false, enabled: true, tags: [],
    sort_order: 0, created_at: "", updated_at: "",
  }
}

function compactDish({ id, name, image_url, category, cook_time, difficulty }: Dish): DraftDish {
  return { id, name, image_url, category, cook_time, difficulty }
}

export function clearTomorrowDraft(storage: DraftStorage | null = sessionStorageOrNull()) {
  try { storage?.removeItem(storageKey) } catch { /* Storage may be unavailable in private mode. */ }
}

export function writeTomorrowDraft(
  date: string,
  baseline: string,
  draft: TomorrowDraftState,
  storage: DraftStorage | null = sessionStorageOrNull(),
) {
  try {
    storage?.setItem(storageKey, JSON.stringify({
      version: 1, date, baseline, profile: draft.profile, targets: draft.targets,
      lunch: draft.lunch.map(compactDish), dinner: draft.dinner.map(compactDish),
    }))
  } catch { /* A storage failure must not prevent editing or saving a plan. */ }
}

export function readTomorrowDraft(
  date: string,
  baseline: string,
  storage: DraftStorage | null = sessionStorageOrNull(),
): { kind: "missing" | "expired" | "conflict" } | { kind: "restored"; draft: TomorrowDraftState } {
  try {
    const raw = storage?.getItem(storageKey)
    if (!raw) return { kind: "missing" }
    const value: unknown = JSON.parse(raw)
    if (!isObject(value) || value.version !== 1 || typeof value.date !== "string"
      || typeof value.baseline !== "string" || !profiles.includes(value.profile as TomorrowProfile)
      || !isObject(value.targets) || !isTarget(value.targets.lunch) || !isTarget(value.targets.dinner)
      || !isDishList(value.lunch) || !isDishList(value.dinner)) {
      clearTomorrowDraft(storage)
      return { kind: "missing" }
    }
    // Tomorrow changes at local midnight; yesterday's draft must never migrate to the new date.
    if (value.date !== date) {
      clearTomorrowDraft(storage)
      return { kind: "expired" }
    }
    if (value.baseline !== baseline) {
      clearTomorrowDraft(storage)
      return { kind: "conflict" }
    }
    return {
      kind: "restored",
      draft: {
        lunch: value.lunch.map(dish => restoreDish(dish, "lunch")),
        dinner: value.dinner.map(dish => restoreDish(dish, "dinner")),
        targets: { lunch: value.targets.lunch, dinner: value.targets.dinner },
        profile: value.profile as TomorrowProfile,
      },
    }
  } catch {
    clearTomorrowDraft(storage)
    return { kind: "missing" }
  }
}
