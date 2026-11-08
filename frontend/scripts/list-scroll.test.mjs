import assert from "node:assert/strict"
import test from "node:test"
import { restoreListScroll } from "../src/lib/listScroll.ts"

function scroller(height, contentHeight) {
  let top = 0
  return {
    clientHeight: height,
    scrollHeight: contentHeight,
    get scrollTop() { return top },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
  }
}

test("a remounted list restores the saved position with cached rows", () => {
  const list = scroller(500, 4000)
  assert.equal(restoreListScroll(list, 1200, true), true)
  assert.equal(list.scrollTop, 1200)
})

test("a hidden list keeps its target until the layout becomes measurable", () => {
  const list = scroller(0, 0)
  assert.equal(restoreListScroll(list, 1200, false), false)
  list.clientHeight = 500
  list.scrollHeight = 4000
  assert.equal(restoreListScroll(list, 1200, false), true)
  assert.equal(list.scrollTop, 1200)
})

test("expired pages keep the original target while pagination refills", () => {
  const list = scroller(500, 1000)
  assert.equal(restoreListScroll(list, 4200, true), false)
  assert.equal(list.scrollTop, 500)
  list.scrollHeight = 3000
  assert.equal(restoreListScroll(list, 4200, true), false)
  list.scrollHeight = 6000
  assert.equal(restoreListScroll(list, 4200, true), true)
  assert.equal(list.scrollTop, 4200)
})

test("a shortened final result stops restoring at its new bottom", () => {
  const list = scroller(500, 900)
  assert.equal(restoreListScroll(list, 1200, false), true)
  assert.equal(list.scrollTop, 400)
})

test("a rejected scroll assignment is not mistaken for a completed restore", () => {
  const list = { clientHeight: 500, scrollHeight: 4000, get scrollTop() { return 0 }, set scrollTop(_) {} }
  assert.equal(restoreListScroll(list, 1200, false), false)
})
