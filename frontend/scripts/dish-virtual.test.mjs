import assert from "node:assert/strict"
import test from "node:test"
import { Virtualizer } from "@tanstack/react-virtual"
import { buildDishVirtualRows, includeFocusedNeighbours, resetDishMeasurements } from "../src/lib/dishVirtualRows.ts"

const dish = (id, category = "家常菜") => ({ id, category, name: `菜品${id}` })

function virtualList(rows, snapshot = []) {
  return new Virtualizer({
    count: rows.length,
    getScrollElement: () => null,
    getItemKey: index => rows[index].key,
    estimateSize: index => rows[index].kind === "category" ? 31 : 138,
    initialMeasurementsCache: snapshot,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  })
}

test("分散在多页的同类菜仍归在一个标题下，空分类保留其他组", () => {
  const rows = buildDishVirtualRows([dish(1), dish(2, "汤品"), dish(3), dish(4, "")], true)
  assert.deepEqual(rows.map(row => row.key), ["category:家常菜", "dish:1", "dish:3", "category:汤品", "dish:2", "category:其他", "dish:4"])
  assert.equal(rows[0].count, 2)
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length)
})

test("筛选结果保留接口顺序，去掉分类标题且不丢菜", () => {
  const dishes = [dish(3), dish(1, "汤品"), dish(2)]
  assert.deepEqual(buildDishVirtualRows(dishes, false).map(row => row.dish), dishes)
  assert.deepEqual(buildDishVirtualRows([], true), [])
})

test("后续分页插入前面的组时，菜品的键和照片朝向保持不变", () => {
  const before = buildDishVirtualRows([dish(1), dish(2, "汤品")], true)
  const after = buildDishVirtualRows([dish(1), dish(2, "汤品"), dish(3)], true)
  assert.notEqual(before.findIndex(row => row.key === "dish:2"), after.findIndex(row => row.key === "dish:2"))
  assert.deepEqual(before.find(row => row.key === "dish:2"), after.find(row => row.key === "dish:2"))
})

test("混合标题与换行菜名的测量快照在重挂载后恢复同一道菜及相对位置", () => {
  const rows = buildDishVirtualRows(Array.from({ length: 30 }, (_, i) => dish(i + 1)), true)
  const original = virtualList(rows)
  original.getTotalSize()
  original.resizeItem(0, 27)
  original.resizeItem(1, 176)
  original.resizeItem(2, 152)
  original.resizeItem(16, 205)
  const top = 2300
  const anchor = original.getVirtualItemForOffset(top)
  const restored = virtualList(rows, original.takeSnapshot())
  assert.equal(restored.getTotalSize(), original.getTotalSize())
  assert.deepEqual(restored.getVirtualItemForOffset(top), anchor)
  assert.equal(top - restored.getVirtualItemForOffset(top).start, top - anchor.start)
})

test("分类导致索引移动后，实测行高仍按菜品键复用", () => {
  const rows = buildDishVirtualRows([dish(1), dish(2, "汤品")], true)
  const original = virtualList(rows)
  original.getTotalSize()
  original.resizeItem(3, 205)
  const nextRows = buildDishVirtualRows([dish(1), dish(2, "汤品"), dish(3)], true)
  const restored = virtualList(nextRows, original.takeSnapshot())
  restored.getTotalSize()
  assert.equal(restored.measurementsCache.find(row => row.key === "dish:2").size, 205)
})

test("离屏焦点只额外保留相邻行，键盘可前后跨边界且不会挂载整段列表", () => {
  assert.deepEqual(includeFocusedNeighbours([90, 91, 92], 2, 100), [1, 2, 3, 90, 91, 92])
  assert.deepEqual(includeFocusedNeighbours([0, 1, 2], 0, 3), [0, 1, 2])
  assert.deepEqual(includeFocusedNeighbours([0, 1], 9, 10), [0, 1, 8, 9])
  assert.deepEqual(includeFocusedNeighbours([4, 5], -1, 20), [4, 5])
})

test("宽度变化后，先到达的行高通知不会在清空缓存时丢失，换行菜名不重叠", () => {
  const rows = buildDishVirtualRows([dish(1), dish(2), dish(3)], false)
  const list = virtualList(rows)
  list.getTotalSize()
  list.resizeItem(1, 148) // The row ResizeObserver can fire before the container's.
  list.getTotalSize()
  resetDishMeasurements(list, [{ index: 0, size: 138 }, { index: 1, size: 148 }, { index: 2, size: 138 }])
  assert.equal(list.getTotalSize(), 424)
  assert.equal(list.measurementsCache[2].start, 286)
  resetDishMeasurements(list, [{ index: 0, size: 138 }, { index: 1, size: 138 }, { index: 2, size: 138 }])
  assert.equal(list.getTotalSize(), 414)
})
