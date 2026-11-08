import assert from "node:assert/strict"
import test from "node:test"
import { parseMoney, money, shiftMonth, comparisonLabel } from "../src/lib/ledger.ts"

test("金额精确转分并拒绝截断、指数和越界输入", () => {
  assert.equal(parseMoney("0.29"), 29)
  assert.equal(parseMoney("12.5"), 1250)
  assert.equal(parseMoney("999999.99"), 99999999)
  assert.equal(parseMoney("0", true), 0)
  for (const value of ["", "0", "-1", "1e2", ".2", "1.234", "1000000", "NaN", "12abc", "1."]) assert.equal(parseMoney(value), null, value)
  assert.equal(money(29), "0.29")
})
test("跨年月份切换与零基数环比不会产生无穷大", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12")
  assert.equal(shiftMonth("2026-12", 1), "2027-01")
  assert.equal(comparisonLabel(88, 100), "↓ 比上月 12.0%")
  assert.equal(comparisonLabel(100, 0), "上月无支出，暂不比较")
  assert.equal(comparisonLabel(0, 0), "上月也没有支出")
})
