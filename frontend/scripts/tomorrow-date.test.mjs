import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { getTomorrow, nextLocalMidnightDelay } from "../src/lib/tomorrowDate.ts"

test("tomorrow changes at local midnight including month, year and leap-day boundaries", () => {
  for (const [now, expected] of [
    [new Date(2026, 10, 8, 23, 59, 59, 999), "2026-11-09"],
    [new Date(2026, 10, 9), "2026-11-10"],
    [new Date(2026, 11, 31, 23, 59), "2027-01-01"],
    [new Date(2028, 1, 28), "2028-02-29"],
  ]) {
    const timestamp = now.getTime()
    assert.equal(getTomorrow(now).str, expected)
    assert.equal(now.getTime(), timestamp)
  }
})

test("rollover is scheduled just after local midnight without a fixed 24-hour interval", () => {
  assert.equal(nextLocalMidnightDelay(new Date(2026, 10, 8, 23, 59, 59, 900)), 200)
  assert.equal(nextLocalMidnightDelay(new Date(2026, 10, 8, 12)), 12 * 60 * 60 * 1000 + 100)
  assert.equal(nextLocalMidnightDelay(new Date(2026, 10, 8)), 24 * 60 * 60 * 1000 + 100)
})

test("short and long daylight-saving days still refresh at the next local midnight", () => {
  const moduleURL = new URL("../src/lib/tomorrowDate.ts", import.meta.url).href
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { nextLocalMidnightDelay } from ${JSON.stringify(moduleURL)};
    console.log(JSON.stringify([
      nextLocalMidnightDelay(new Date(2026, 2, 8)),
      nextLocalMidnightDelay(new Date(2026, 10, 1)),
    ]));
  `], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" })
  assert.deepEqual(JSON.parse(result), [23 * 60 * 60 * 1000 + 100, 25 * 60 * 60 * 1000 + 100])
})
