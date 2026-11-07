import assert from "node:assert/strict"
import test from "node:test"
import { readTomorrowDraft, tomorrowPlanBaseline, writeTomorrowDraft } from "../src/lib/tomorrowDraft.ts"

const date = "2026-11-08"
const key = "ninimenu:tomorrow-draft:v1"
const record = (id = 1, overrides = {}) => ({
  id, dish_id: id, meal_date: date, meal_type: "lunch", status: "planned",
  portion_scale: 1, inventory_applied: false, ...overrides,
})
const dish = id => ({
  id, name: `菜品 ${id}`, image_url: `/uploads/${id}.jpg`, category: "家常菜", cook_time: 15, difficulty: "easy",
  ingredients: ["不需要暂存的长食材表"], steps: ["不需要暂存的详细步骤"],
})
const draft = (overrides = {}) => ({
  lunch: [dish(2)], dinner: [dish(3)], targets: { lunch: 2, dinner: 1 }, profile: "quick", ...overrides,
})
function memoryStorage() {
  const data = new Map()
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  }
}

test("recipe round trip restores the unsaved menu, counts and preference", () => {
  const storage = memoryStorage()
  const baseline = tomorrowPlanBaseline([record()])
  writeTomorrowDraft(date, baseline, draft(), storage)
  const result = readTomorrowDraft(date, baseline, storage)
  assert.equal(result.kind, "restored")
  assert.deepEqual(result.draft.lunch.map(item => item.id), [2])
  assert.deepEqual(result.draft.dinner.map(item => item.id), [3])
  assert.deepEqual(result.draft.targets, { lunch: 2, dinner: 1 })
  assert.equal(result.draft.profile, "quick")
  assert.equal(result.draft.lunch[0].cook_time, 15)
  assert.ok(!storage.getItem(key).includes("详细步骤"))
})

test("recommendations retain an empty server baseline and are not a saved plan", () => {
  const storage = memoryStorage()
  const baseline = tomorrowPlanBaseline([])
  writeTomorrowDraft(date, baseline, draft(), storage)
  assert.equal(JSON.parse(storage.getItem(key)).baseline, "[]")
  assert.equal(readTomorrowDraft(date, baseline, storage).kind, "restored")
  assert.equal(readTomorrowDraft(date, tomorrowPlanBaseline([record(2)]), storage).kind, "conflict")
})

test("empty unsaved and saved menus survive returning without new recommendations", () => {
  for (const records of [[record()], []]) {
    const storage = memoryStorage()
    const baseline = tomorrowPlanBaseline(records)
    writeTomorrowDraft(date, baseline, draft({ lunch: [], dinner: [], targets: { lunch: 0, dinner: 0 } }), storage)
    const result = readTomorrowDraft(date, baseline, storage)
    assert.equal(result.kind, "restored")
    assert.deepEqual(result.draft.lunch, [])
    assert.deepEqual(result.draft.dinner, [])
    assert.deepEqual(result.draft.targets, { lunch: 0, dinner: 0 })
  }
})

test("cancellation, rescheduling, completion, portion changes and replacement preserve drafts for explicit reconciliation", () => {
  const changes = [
    [], [record(1, { status: "cancelled" })], [record(1, { status: "completed" })],
    [record(1, { meal_date: "2026-11-09" })], [record(1, { meal_type: "dinner" })],
    [record(1, { portion_scale: 2 })], [record(2, { dish_id: 1 })],
  ]
  for (const records of changes) {
    const storage = memoryStorage()
    writeTomorrowDraft(date, tomorrowPlanBaseline([record()]), draft(), storage)
    const result = readTomorrowDraft(date, tomorrowPlanBaseline(records), storage)
    assert.equal(result.kind, "conflict")
    assert.deepEqual(result.draft.lunch.map(item => item.id), [2])
    assert.deepEqual(result.draft.dinner.map(item => item.id), [3])
    assert.notEqual(storage.getItem(key), null)
  }
})

test("record ordering and unrelated cancelled records do not create false conflicts", () => {
  const before = tomorrowPlanBaseline([record(1), record(2)])
  const after = tomorrowPlanBaseline([record(3, { status: "cancelled" }), record(2), record(1)])
  assert.equal(before, after)
})

test("saving updates the baseline so the next visit restores against the new server state", () => {
  const storage = memoryStorage()
  writeTomorrowDraft(date, tomorrowPlanBaseline([record()]), draft(), storage)
  const savedBaseline = tomorrowPlanBaseline([record(2), record(3, { meal_type: "dinner" })])
  writeTomorrowDraft(date, savedBaseline, draft(), storage)
  assert.equal(readTomorrowDraft(date, savedBaseline, storage).kind, "restored")
})

test("a draft never transfers to another target date", () => {
  const storage = memoryStorage()
  writeTomorrowDraft(date, "[]", draft(), storage)
  assert.equal(readTomorrowDraft("2026-11-09", "[]", storage).kind, "expired")
  assert.equal(storage.getItem(key), null)
})

test("invalid or obsolete drafts are discarded", () => {
  const storage = memoryStorage()
  writeTomorrowDraft(date, "[]", draft(), storage)
  const valid = JSON.parse(storage.getItem(key))
  for (const value of ["not json", null, { ...valid, version: 2 }, { ...valid, lunch: [{}] },
    { ...valid, targets: { lunch: -1, dinner: 2 } }, { ...valid, lunch: [dish(2), dish(2)] }]) {
    storage.setItem(key, typeof value === "string" ? value : JSON.stringify(value))
    assert.equal(readTomorrowDraft(date, "[]", storage).kind, "missing")
    assert.equal(storage.getItem(key), null)
  }
})

test("unavailable browser storage cannot break menu editing", () => {
  const unavailable = {
    getItem() { throw new Error("storage blocked") },
    setItem() { throw new Error("storage full") },
    removeItem() { throw new Error("storage blocked") },
  }
  assert.doesNotThrow(() => writeTomorrowDraft(date, "[]", draft(), unavailable))
  assert.equal(readTomorrowDraft(date, "[]", unavailable).kind, "missing")
  assert.equal(readTomorrowDraft(date, "[]", null).kind, "missing")
})
