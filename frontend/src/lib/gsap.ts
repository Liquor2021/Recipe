import gsap from "gsap"
import { useGSAP } from "@gsap/react"

// DOM 的 x/rotation 动画依赖 CSSPlugin，保留标准入口；不注册无人使用的 Flip/ScrollToPlugin。
gsap.registerPlugin(useGSAP)
gsap.defaults({ duration: 0.3, ease: "power2.out", overwrite: "auto" })

const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

export { gsap, useGSAP }

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia(REDUCE_MOTION_QUERY).matches
}

export function motionDuration(duration: number) {
  return prefersReducedMotion() ? 0 : duration
}
