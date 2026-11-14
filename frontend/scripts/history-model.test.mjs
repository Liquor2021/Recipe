import assert from "node:assert/strict"
import test from "node:test"
import { mergeSavedRecord, parsePhotos, isDayRatingConflict } from "../src/pages/history/model.ts"

test("记录同步覆盖数组、普通分页、计划快照和无限分页，并保留其它行", () => {
  const row = { id: 1, dish_id: 8, status: "planned", dish_name: "原菜名", meal_date: "2026-11-14" }
  const other = { id: 2, status: "completed" }
  const saved = { ...row, status: "completed", rating: 5 }
  for (const wrap of [a => a, a => ({ items: a, total: 2 }), a => ({ records: a, version: "v1" }), a => ({ pages: [{ items: a, total: 2 }], pageParams: [1] })]) {
    const input = wrap([row, other])
    const before = structuredClone(input)
    assert.deepEqual(mergeSavedRecord(input, saved), wrap([saved, other]))
    assert.deepEqual(input, before, "不能修改调用方的缓存")
  }
})

test("损坏的照片 JSON 不影响手账显示，过滤非字符串和空地址", () => {
  for (const value of ["", "{", "null", "{}", "123"]) assert.deepEqual(parsePhotos(value), [])
  assert.deepEqual(parsePhotos('["/a.webp",null,3,"",false,"/b.png"]'), ["/a.webp", "/b.png"])
})

test("评价版本冲突与普通网络失败继续分开处理", () => {
  assert.equal(isDayRatingConflict({ response: { status: 409 } }), true)
  for (const error of [null, new Error("network"), { response: { status: 500 } }]) assert.equal(isDayRatingConflict(error), false)
})
