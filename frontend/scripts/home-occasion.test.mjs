import assert from "node:assert/strict"
import test from "node:test"
import { homeOccasion, occasionDismissalKey } from "../src/lib/homeOccasion.ts"

const holiday = (name, date, extra = {}) => ({ id: 1, name, date, greeting: "", dish_ids: "[]", created_at: "", ...extra })

test("节日优先，忽略过期/过远项并选最近一项，不修改接口数据", () => {
  const input = [holiday("已过节日", "2026-11-14"), holiday("远期节日", "2027-01-01"), holiday("三天后的节日", "2026-11-18"), holiday("明日节日", "2026-11-16")]
  const before = structuredClone(input)
  const note = homeOccasion(input, "2026-11-15")
  assert.equal(note.kind, "holiday")
  assert.equal(note.date, "2026-11-16")
  assert.equal(note.message, "明天就是明日节日，安排顿好的？")
  assert.deepEqual(input, before)
})

test("当天祝福只在节日当天显示，7 天内可预告但不无限倒数", () => {
  const item = holiday("冬日聚餐", "2026-11-15", { greeting: "一家人好好吃饭" })
  assert.equal(homeOccasion([item], item.date).message, "今天是冬日聚餐，一家人好好吃饭")
  assert.match(homeOccasion([item], "2026-11-08").message, /再过 7 天/)
  assert.equal(homeOccasion([item], "2026-11-07").kind, "weekend")
  assert.equal(homeOccasion([item], "2026-11-16"), null)
})

test("接口空或失败时只做周末轻提醒；周一/周二不打扰", () => {
  for (const data of [undefined, null, []]) {
    assert.equal(homeOccasion(data, "2026-11-09"), null)
    assert.equal(homeOccasion(data, "2026-11-10"), null)
    assert.equal(homeOccasion(data, "2026-11-11").message, "再过 3 天就是周末，安排顿好的？")
    assert.equal(homeOccasion(data, "2026-11-13").date, "2026-11-14")
    assert.equal(homeOccasion(data, "2026-11-14").message, "周末到了，慢慢做顿喜欢的吧。")
    assert.equal(homeOccasion(data, "2026-11-15").date, "2026-11-15")
  }
})

test("跨月/跨年/闰日按日历计天，不受宿主时区和夏令时影响", () => {
  for (const [today, date, days] of [["2026-12-30", "2027-01-01", 2], ["2028-02-28", "2028-03-01", 2], ["2026-03-07", "2026-03-09", 2], ["2026-10-31", "2026-11-02", 2]]) {
    const note = homeOccasion([holiday("节日", date)], today)
    assert.equal(note.date, date)
    assert.match(note.message, new RegExp(`再过 ${days} 天`))
  }
})

test("损坏的日期和空节日名不生成误导提示，超长文案有界", () => {
  const invalid = [null, holiday("", "2026-11-10"), holiday("假的", "2026-02-30"), holiday("假的", "2026-2-03"), { name: 3, date: "2026-11-10" }]
  assert.equal(homeOccasion(invalid, "2026-11-10"), null)
  for (const date of ["", "2026-02-30", "2026-13-01", "2026-1-01", "not-a-date"]) assert.equal(homeOccasion([], date), null)
  assert.ok(homeOccasion([holiday("节".repeat(1000), "2026-11-10", { greeting: "好".repeat(1000) })], "2026-11-10").message.length < 150)
})

test("关闭键同时隔离日期和提示对象，次日不会永远被隐藏", () => {
  const weekend = homeOccasion([], "2026-11-15")
  const event = homeOccasion([holiday("节日", "2026-11-15")], "2026-11-15")
  assert.notEqual(occasionDismissalKey("2026-11-15", weekend), occasionDismissalKey("2026-11-16", weekend))
  assert.notEqual(occasionDismissalKey("2026-11-15", weekend), occasionDismissalKey("2026-11-15", event))
})
