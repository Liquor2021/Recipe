import assert from "node:assert/strict"
import test from "node:test"
import { fridgeDaysLeft, matchesFridgeFilter, parseFridgeFilter, searchFridge } from "../src/lib/fridgeFilters.ts"

const today = "2026-11-07"
const batches = ["2026-11-06", today, "2026-11-08", "2026-11-09", "2026-11-10", ""].map((expiry_date, index) => ({
  id: index + 1, item_name: "番茄", expiry_date,
}))

test("临期只含今天至两天后，同名新鲜、过期和无日期批次分开", () => {
  assert.deepEqual(batches.filter(item => matchesFridgeFilter(item, "soon", today)).map(item => item.id), [2, 3, 4])
  assert.deepEqual(batches.filter(item => matchesFridgeFilter(item, "expired", today)).map(item => item.id), [1])
  assert.equal(batches.filter(item => matchesFridgeFilter(item, "all", today)).length, 6)
})

test("名称搜索可叠加保质期，忽略首尾空白和英文大小写", () => {
  const items = [...batches, { id: 7, item_name: "Baby 菠菜", expiry_date: today }]
  assert.equal(searchFridge(items, "  ").length, 7)
  assert.deepEqual(searchFridge(items, "  BABY ").map(item => item.id), [7])
  assert.deepEqual(searchFridge(items, "茄").filter(item => matchesFridgeFilter(item, "expired", today)).map(item => item.id), [1])
  assert.equal(searchFridge(items, "不存在").length, 0)
})

test("未设日期和非法日期不归入临期或过期", () => {
  for (const expiry_date of ["", "bad", "2026-02-30", "2026-13-01"]) {
    assert.equal(fridgeDaysLeft(expiry_date, today), null)
    assert.equal(matchesFridgeFilter({ expiry_date }, "soon", today), false)
    assert.equal(matchesFridgeFilter({ expiry_date }, "expired", today), false)
  }
})

test("日历天比较覆盖跨月、跨年、闰日和夏令时边界", () => {
  assert.equal(fridgeDaysLeft("2027-01-01", "2026-12-31"), 1)
  assert.equal(fridgeDaysLeft("2028-03-01", "2028-02-28"), 2)
  assert.equal(fridgeDaysLeft("2026-03-09", "2026-03-08"), 1)
  assert.equal(fridgeDaysLeft("2026-11-02", "2026-11-01"), 1)
})

test("编辑日期及跨日后重新判断，不改变原始批次和顺序", () => {
  const edited = batches.map(item => item.id === 2 ? { ...item, expiry_date: "2026-11-14" } : item)
  assert.deepEqual(edited.filter(item => matchesFridgeFilter(item, "soon", today)).map(item => item.id), [3, 4])
  assert.deepEqual(batches.filter(item => matchesFridgeFilter(item, "expired", "2026-11-08")).map(item => item.id), [1, 2])
  assert.equal(batches[1].expiry_date, today)
})

test("未知或缺失的 URL 筛选参数回退到全部", () => {
  assert.equal(parseFridgeFilter("soon"), "soon")
  assert.equal(parseFridgeFilter("expired"), "expired")
  for (const value of [null, "", "all", "invalid"]) assert.equal(parseFridgeFilter(value), "all")
})
