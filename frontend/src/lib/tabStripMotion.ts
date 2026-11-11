import { gsap } from "gsap"

// 条带的位置只由这一个控制器写入。auto 只覆盖冲突属性，不能代替整段动画的取消。
export function createTabStripMotion(target: gsap.TweenTarget, stepPercent: number) {
  let revision = 0
  let animating = false

  function stop() {
    // 先作废旧回调，再 kill，避免旧 onInterrupt 清掉新动画的状态。
    revision += 1
    gsap.killTweensOf(target)
    animating = false
  }

  return {
    get isAnimating() { return animating },
    stop,
    slideTo(index: number, duration: number) {
      stop()
      const currentRevision = revision
      animating = duration > 0
      const settle = () => {
        if (revision === currentRevision) animating = false
      }
      gsap.to(target, {
        xPercent: -index * stepPercent,
        x: 0,
        duration,
        ease: "power3.out",
        force3D: true,
        overwrite: "auto",
        onComplete: settle,
        onInterrupt: settle,
      })
    },
    dragTo(offset: number) {
      stop()
      gsap.set(target, { x: offset, force3D: true })
    },
  }
}
