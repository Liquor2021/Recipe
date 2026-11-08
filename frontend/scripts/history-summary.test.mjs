import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { getHistoryMonthSummary, getPlanDateLabel } from "../src/lib/historySummary.ts"

test("相对日期按日历日计算，支持跨月、跨年和闰日", () => {
  for (const [date, today, expected] of [
    ["2026-11-08", "2026-11-08", "今天"],
    ["2026-12-01", "2026-11-30", "明天"],
    ["2027-01-01", "2026-12-30", "后天"],
    ["2028-02-28", "2028-03-01", "已逾期 2 天"],
    ["2026-11-05", "2026-11-08", "已逾期 3 天"],
    ["2026-11-20", "2026-11-08", "11月20日"],
    ["2027-01-01", "2026-11-08", "2027年1月1日"],
  ]) assert.equal(getPlanDateLabel(date, today), expected)
})

test("夏令时变化不会把逾期天数算成小数或漏一天", () => {
  const moduleURL = new URL("../src/lib/historySummary.ts", import.meta.url).href
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { getPlanDateLabel } from ${JSON.stringify(moduleURL)};
    console.log(JSON.stringify([
      getPlanDateLabel("2026-03-08", "2026-03-09"),
      getPlanDateLabel("2026-11-01", "2026-11-02"),
    ]));
  `], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" })
  assert.deepEqual(JSON.parse(result), ["已逾期 1 天", "已逾期 1 天"])
})

const record = (id, meal_date, meal_type, overrides = {}) => ({
  id, dish_id: 1, dish_name: "番茄炒蛋", meal_date, meal_type, status: "completed", ...overrides,
})

test("月度顿数按日期和餐别去重，菜品道数保留同餐不同菜", () => {
  const records = [
    record(1, "2026-11-08", "lunch"),
    record(2, "2026-11-08", "lunch", { dish_id: 2, dish_name: "肉末茄子" }),
    record(3, "2026-11-08", "dinner"),
    record(4, "2026-11-09", "lunch"),
  ]
  assert.deepEqual(getHistoryMonthSummary(records, "2026-11-01", "2026-11-30"), {
    meals: 3, dishes: 4, lunches: 2, dinners: 1, topDish: "番茄炒蛋",
  })
})

test("计划、取消、其他月份与分页重复记录不计入月度小结", () => {
  const records = [
    record(1, "2026-11-01", "lunch"),
    record(1, "2026-11-01", "lunch"),
    record(2, "2026-11-30", "dinner"),
    record(3, "2026-11-08", "dinner", { status: "planned" }),
    record(4, "2026-11-09", "lunch", { status: "cancelled" }),
    record(5, "2026-10-31", "lunch"),
    record(6, "2026-12-01", "lunch"),
  ]
  assert.deepEqual(getHistoryMonthSummary(records, "2026-11-01", "2026-11-30"), {
    meals: 2, dishes: 2, lunches: 1, dinners: 1, topDish: "番茄炒蛋",
  })
  assert.deepEqual(getHistoryMonthSummary(records, "2027-01-01", "2027-01-31"), {
    meals: 0, dishes: 0, lunches: 0, dinners: 0, topDish: undefined,
  })
})

test("常吃菜按菜品标识汇总，不把同名菜误合并", () => {
  const records = [
    record(1, "2026-11-01", "lunch", { dish_id: 1, dish_name: "同名菜" }),
    record(2, "2026-11-02", "lunch", { dish_id: 2, dish_name: "同名菜" }),
    record(3, "2026-11-03", "lunch", { dish_id: 3, dish_name: "常吃菜" }),
    record(4, "2026-11-04", "lunch", { dish_id: 3, dish_name: "常吃菜" }),
  ]
  assert.equal(getHistoryMonthSummary(records, "2026-11-01", "2026-11-30").topDish, "常吃菜")
})
