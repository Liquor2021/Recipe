import assert from "node:assert/strict"
import test from "node:test"
import { isCurrentMoodChoice, savedHomeMood, selectedHomeMood } from "../src/lib/homeMood.ts"

const today = "2026-11-07"
const tomorrow = "2026-11-08"
const choice = (id, mood, date = today) => ({ id, date, mood })

test("a cold load picks up the asynchronously read saved mood", () => {
  assert.equal(selectedHomeMood(null, today, undefined), null)
  assert.equal(selectedHomeMood(null, today, "happy"), "happy")
})

test("an initial read finishing after a click cannot replace the pending choice", () => {
  const pending = choice(1, "spicy")
  assert.equal(selectedHomeMood(pending, today, undefined), "spicy")
  assert.equal(selectedHomeMood(pending, today, "tired"), "spicy")
})

test("rapid choices keep the last selection while earlier requests settle", () => {
  const first = choice(1, "happy")
  const second = choice(2, "spicy")
  const latest = choice(3, "healthy")
  assert.equal(isCurrentMoodChoice(latest, first, today), false)
  assert.equal(selectedHomeMood(latest, today, first.mood), "healthy")
  assert.equal(isCurrentMoodChoice(latest, second, today), false)
  assert.equal(selectedHomeMood(latest, today, second.mood), "healthy")
  assert.equal(isCurrentMoodChoice(latest, latest, today), true)
  assert.equal(selectedHomeMood(null, today, latest.mood), "healthy")
})

test("a failed latest choice falls back to the last confirmed server mood", () => {
  const failed = choice(2, "spicy")
  const lastSaved = "happy"
  assert.equal(selectedHomeMood(failed, today, lastSaved), "spicy")
  assert.equal(isCurrentMoodChoice(failed, failed, today), true)
  assert.equal(selectedHomeMood(null, today, lastSaved), "happy")
  assert.equal(selectedHomeMood(null, today, undefined), null)
})

test("midnight ignores yesterday's pending mood and late save notification", () => {
  const yesterdayRequest = choice(1, "spicy")
  assert.equal(selectedHomeMood(yesterdayRequest, tomorrow, undefined), null)
  assert.equal(selectedHomeMood(yesterdayRequest, tomorrow, "happy"), "happy")
  assert.equal(isCurrentMoodChoice(yesterdayRequest, yesterdayRequest, tomorrow), false)
  const nextRequest = choice(2, "tired", tomorrow)
  assert.equal(isCurrentMoodChoice(nextRequest, yesterdayRequest, tomorrow), false)
  assert.equal(selectedHomeMood(nextRequest, tomorrow, "happy"), "tired")
})

test("invalid persisted moods never produce a selected state", () => {
  for (const value of [undefined, null, "", "unknown", 1, {}]) assert.equal(savedHomeMood(value), null)
  for (const value of ["happy", "tired", "lazy", "spicy", "healthy"]) assert.equal(savedHomeMood(value), value)
})
