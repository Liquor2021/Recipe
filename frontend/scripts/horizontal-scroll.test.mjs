import assert from "node:assert/strict"
import test from "node:test"
import { horizontalWheelTarget } from "../src/lib/horizontalScroll.ts"

const strip = { scrollLeft: 100, clientWidth: 300, scrollWidth: 900 }
const wheel = (values) => ({ ctrlKey: false, shiftKey: false, deltaX: 0, deltaY: 40, deltaMode: 0, ...values })

test("a vertical mouse wheel moves the strip in either direction", () => {
  assert.equal(horizontalWheelTarget(wheel({}), strip), 140)
  assert.equal(horizontalWheelTarget(wheel({ deltaY: -40 }), strip), 60)
})

test("line and page wheel units use their intended distances", () => {
  assert.equal(horizontalWheelTarget(wheel({ deltaMode: 1, deltaY: 3 }), strip), 148)
  assert.equal(horizontalWheelTarget(wheel({ deltaMode: 2, deltaY: 1 }), strip), 400)
})

test("large wheel steps stop at the last or first item", () => {
  assert.equal(horizontalWheelTarget(wheel({ deltaY: 900 }), strip), 600)
  assert.equal(horizontalWheelTarget(wheel({ deltaY: -900 }), strip), 0)
})

test("at either edge the wheel is released so the page can scroll", () => {
  assert.equal(horizontalWheelTarget(wheel({}), { ...strip, scrollLeft: 600 }), null)
  assert.equal(horizontalWheelTarget(wheel({ deltaY: -40 }), { ...strip, scrollLeft: 0 }), null)
  assert.equal(horizontalWheelTarget(wheel({ deltaY: -40 }), { ...strip, scrollLeft: 600 }), 560)
})

test("zoom, shift-wheel and horizontal trackpad gestures stay native", () => {
  assert.equal(horizontalWheelTarget(wheel({ ctrlKey: true }), strip), null)
  assert.equal(horizontalWheelTarget(wheel({ shiftKey: true }), strip), null)
  assert.equal(horizontalWheelTarget(wheel({ deltaX: 80 }), strip), null)
  assert.equal(horizontalWheelTarget(wheel({ deltaX: 80, deltaY: 0 }), strip), null)
})

test("strips with no overflow do not capture the wheel", () => {
  assert.equal(horizontalWheelTarget(wheel({}), { ...strip, scrollLeft: 0, scrollWidth: 300 }), null)
  assert.equal(horizontalWheelTarget(wheel({}), { ...strip, scrollLeft: 0, scrollWidth: 180 }), null)
})
