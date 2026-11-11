import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gsap } from "gsap"
import { createTabStripMotion } from "../src/lib/tabStripMotion.ts"

after(() => gsap.ticker.sleep())

function setup(index = 0) {
  const strip = { x: 0, xPercent: -index * 100 / 6, force3D: true }
  const motion = createTabStripMotion(strip, 100 / 6)
  return { strip, motion }
}

function onlyTween(strip) {
  const tweens = gsap.getTweensOf(strip)
  assert.equal(tweens.length, 1, "条带只能有一个活动动画")
  return tweens[0]
}

function atTab(strip, index) {
  assert.equal(strip.x, 0)
  assert.ok(Math.abs(strip.xPercent + index * 100 / 6) < 0.00001)
}

test("属性级 auto 覆盖仍可保留旧导航，接管必须完整取消条带动画", () => {
  const { strip, motion } = setup(1)
  strip.x = 70
  const navigation = gsap.to(strip, { xPercent: -3 * 100 / 6, x: 0, duration: 0.32, overwrite: "auto" })
  navigation.progress(0.3)
  const rebound = gsap.to(strip, { x: 0, duration: 0.18, overwrite: "auto" })
  rebound.progress(0.1)
  assert.equal(gsap.getTweensOf(strip).length, 2, "只覆盖 x 时，旧导航的 xPercent 仍在运行")
  motion.slideTo(4, 0.32)
  onlyTween(strip).progress(1)
  atTab(strip, 4)
  assert.equal(motion.isAnimating, false)
})

test("拖动接管正在运行的导航时，旧 tween 和忙碌状态都被清除", () => {
  const { strip, motion } = setup()
  motion.slideTo(3, 0.32)
  onlyTween(strip).progress(0.2)
  motion.dragTo(23)
  assert.equal(strip.x, 23)
  assert.equal(gsap.getTweensOf(strip).length, 0)
  assert.equal(motion.isAnimating, false)
  motion.slideTo(2, 0.25)
  onlyTween(strip).progress(1)
  atTab(strip, 2)
})

test("回弹中切页：从当前位置接续，完整取消回弹，只落到最后选择的页", () => {
  const { strip, motion } = setup(2)
  motion.dragTo(70)
  motion.slideTo(2, 0.18)
  onlyTween(strip).progress(0.4)
  const before = strip.x
  motion.slideTo(4, 0.32)
  assert.equal(strip.x, before, "接管时不能跳回原点")
  assert.equal(motion.isAnimating, true)
  onlyTween(strip).progress(1)
  atTab(strip, 4)
  assert.equal(motion.isAnimating, false)
})

test("快速来回切换：每次只有一个动画，最终位置与最后页签一致", () => {
  const { strip, motion } = setup()
  for (const index of [5, 1, 4, 0, 3, 2, 5, 0]) {
    motion.slideTo(index, 0.32)
    onlyTween(strip).progress(0.2)
    assert.equal(motion.isAnimating, true)
  }
  onlyTween(strip).progress(1)
  atTab(strip, 0)
  assert.equal(motion.isAnimating, false)
})

test("新目标在当前位置两侧时，条带都单向到达而不反向回跳", () => {
  const { strip, motion } = setup(3)
  for (const index of [1, 5, 0]) {
    const direction = Math.sign(-index * 100 / 6 - strip.xPercent)
    motion.slideTo(index, 0.32)
    const tween = onlyTween(strip)
    let previous = strip.xPercent
    for (const progress of [0.2, 0.4, 0.6, 0.8, 1]) {
      tween.progress(progress)
      assert.ok((strip.xPercent - previous) * direction >= 0)
      previous = strip.xPercent
    }
    atTab(strip, index)
  }
})

test("旧动画的完成或中断回调，不能清掉新动画的忙碌状态", () => {
  const { strip, motion } = setup()
  motion.slideTo(2, 0.32)
  const oldTween = onlyTween(strip)
  const oldComplete = oldTween.eventCallback("onComplete")
  const oldInterrupt = oldTween.eventCallback("onInterrupt")
  oldTween.progress(0.2)
  motion.slideTo(5, 0.32)
  oldComplete()
  oldInterrupt()
  assert.equal(motion.isAnimating, true)
  onlyTween(strip).progress(1)
  assert.equal(motion.isAnimating, false)
})

test("外部取消动画也能解除忙碌状态，后续拖动和回弹仍可用", () => {
  const { strip, motion } = setup(1)
  motion.slideTo(3, 0.32)
  onlyTween(strip).progress(0.3)
  gsap.killTweensOf(strip)
  assert.equal(motion.isAnimating, false)
  motion.dragTo(-40)
  assert.equal(strip.x, -40)
  motion.slideTo(1, 0.25)
  onlyTween(strip).progress(1)
  atTab(strip, 1)
})

test("首屏和减少动态效果使用零时长，立即对齐且不会锁住手势", () => {
  const { strip, motion } = setup()
  motion.slideTo(4, 0.32)
  onlyTween(strip).progress(0.3)
  motion.slideTo(2, 0)
  atTab(strip, 2)
  assert.equal(motion.isAnimating, false)
  assert.equal(gsap.getTweensOf(strip).length, 0)
})

test("卸载清理可重复执行，不遗留动画，再次挂载可正确定位", () => {
  const { strip, motion } = setup()
  motion.slideTo(5, 0.32)
  onlyTween(strip).progress(0.3)
  motion.stop()
  motion.stop()
  assert.equal(motion.isAnimating, false)
  assert.equal(gsap.getTweensOf(strip).length, 0)
  const remounted = createTabStripMotion(strip, 100 / 6)
  remounted.slideTo(3, 0)
  atTab(strip, 3)
  assert.equal(remounted.isAnimating, false)
})
