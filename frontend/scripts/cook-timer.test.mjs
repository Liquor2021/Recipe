import assert from "node:assert/strict"
import test from "node:test"
import {
  createCookTimer,
  pauseCookTimer,
  remainingCookTimerMs,
  startCookTimer,
  syncCookTimer,
} from "../src/lib/cookTimer.ts"

test("remaining time follows the deadline after delayed callbacks", () => {
  const started = startCookTimer(createCookTimer(60_000), 1_000)
  assert.equal(remainingCookTimerMs(started, 16_000), 45_000)
  assert.equal(syncCookTimer(started, 16_000).remainingMs, 45_000)
  assert.equal(syncCookTimer(started, 61_000).status, "elapsed")
})

test("pause freezes the exact remaining time and resume keeps total duration", () => {
  const started = startCookTimer(createCookTimer(60_000), 1_000)
  const paused = pauseCookTimer(started, 21_250)
  assert.equal(paused.status, "paused")
  assert.equal(paused.remainingMs, 39_750)
  assert.equal(paused.totalMs, 60_000)
  assert.equal(syncCookTimer(paused, 90_000), paused)
  const resumed = startCookTimer(paused, 99_000)
  assert.equal(resumed.deadlineMs, 138_750)
  assert.equal(resumed.totalMs, 60_000)
  assert.equal(remainingCookTimerMs(resumed, 138_750), 0)
})

test("expiry is stable and pausing after the deadline cannot revive the timer", () => {
  const started = startCookTimer(createCookTimer(1_500), 10_000)
  assert.equal(syncCookTimer(started, 11_499).remainingMs, 1)
  const elapsed = pauseCookTimer(started, 11_500)
  assert.equal(elapsed.status, "elapsed")
  assert.equal(elapsed.remainingMs, 0)
  assert.equal(elapsed.deadlineMs, null)
  assert.equal(syncCookTimer(elapsed, 99_000), elapsed)
})

test("restarting an elapsed timer restores its full original duration", () => {
  const started = startCookTimer(createCookTimer(60_000), 1_000)
  const paused = pauseCookTimer(started, 21_000)
  const resumed = startCookTimer(paused, 80_000)
  const restarted = startCookTimer(syncCookTimer(resumed, 120_000), 130_000)
  assert.equal(restarted.status, "running")
  assert.equal(restarted.remainingMs, 60_000)
  assert.equal(restarted.deadlineMs, 190_000)
})

test("reset starts a fresh timer after an old timer has elapsed", () => {
  const elapsed = syncCookTimer(startCookTimer(createCookTimer(30_000), 5_000), 35_001)
  assert.equal(elapsed.status, "elapsed")
  const reset = createCookTimer(30_000)
  assert.equal(reset.status, "idle")
  assert.equal(reset.remainingMs, 30_000)
  assert.equal(startCookTimer(reset, 100_000).deadlineMs, 130_000)
})

test("a zero-duration timer never becomes running", () => {
  const timer = startCookTimer(createCookTimer(0), 123)
  assert.equal(timer.status, "elapsed")
  assert.equal(timer.remainingMs, 0)
  assert.equal(timer.deadlineMs, null)
})

test("invalid durations are disabled and clock rollback cannot overfill progress", () => {
  for (const value of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(createCookTimer(value).totalMs, 0)
  }
  const started = startCookTimer(createCookTimer(60_000), 10_000)
  assert.equal(syncCookTimer(started, 9_000).remainingMs, 60_000)
})
