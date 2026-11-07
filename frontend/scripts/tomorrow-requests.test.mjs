import assert from "node:assert/strict"
import test from "node:test"
import { createTomorrowRequestGate, isMealPlanConflict } from "../src/lib/tomorrowRequests.ts"

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("slow older preference cannot overwrite a newer recommendation or clear its loading state", async () => {
  const gate = createTomorrowRequestGate()
  const older = deferred(), newer = deferred()
  let selected = [], loading = false
  async function recommend(request) {
    const token = gate.begin()
    loading = true
    try {
      const dishes = await request.promise
      if (gate.current(token)) selected = dishes
    } finally {
      if (gate.current(token)) loading = false
    }
  }
  const a = recommend(older), b = recommend(newer)
  older.resolve([1, 2]); await a
  assert.deepEqual(selected, [])
  assert.equal(loading, true)
  newer.resolve([3]); await b
  assert.deepEqual(selected, [3])
  assert.equal(loading, false)
})

test("manual selection, quantity change and page exit all discard pending request effects", async () => {
  for (const change of ["manual", "quantity", "exit"]) {
    const gate = createTomorrowRequestGate()
    const request = deferred()
    const token = gate.begin()
    let dishes = [8], shownError = false
    const applied = request.promise.then(value => { if (gate.current(token)) dishes = value }).catch(() => { if (gate.current(token)) shownError = true })
    if (change === "exit") gate.dispose()
    else gate.invalidate()
    if (change === "quantity") request.reject(new Error("late failure"))
    else request.resolve([1, 2, 3])
    await applied
    assert.deepEqual(dishes, [8])
    assert.equal(shownError, false)
  }
})

test("react effect remount can start work but cannot revive the prior effect's response", () => {
  const gate = createTomorrowRequestGate()
  const oldToken = gate.begin()
  gate.dispose()
  gate.activate()
  const newToken = gate.begin()
  assert.equal(gate.current(oldToken), false)
  assert.equal(gate.current(newToken), true)
  assert.equal(isMealPlanConflict({ response: { status: 409 } }), true)
  assert.equal(isMealPlanConflict(new Error("network")), false)
})
