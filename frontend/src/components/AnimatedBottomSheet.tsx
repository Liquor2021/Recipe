import { useRef } from "react"
import { createPortal } from "react-dom"
import { gsap, motionDuration, useGSAP } from "@/lib/gsap"

type BottomSheetControls = { close: () => void }

interface AnimatedBottomSheetProps {
  children: React.ReactNode | ((controls: BottomSheetControls) => React.ReactNode)
  onClose: () => void
  className?: string
  zIndexClass?: string
}

// 默认层级要高于各页面的固定底栏（菜品详情底栏 z-[210]、明日菜单选菜层 z-[220]），
// 否则弹层底部的按钮会被底栏盖住、点不到；低于做菜模式/评价弹窗等全屏层（z-[300] 起）
export default function AnimatedBottomSheet({
  children,
  onClose,
  className = "",
  zIndexClass = "z-[250]",
}: AnimatedBottomSheetProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)

  const { contextSafe } = useGSAP(() => {
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } })
    tl.fromTo(rootRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: motionDuration(0.18) })
      .fromTo(
        sheetRef.current,
        { yPercent: 100 },
        { yPercent: 0, duration: motionDuration(0.34), clearProps: "transform" },
        0,
      )
  }, { scope: rootRef })

  // contextSafe 只是把回调包一层（登记到 GSAP 上下文便于卸载时清理），ref 在点击时才读；
  // react-hooks/refs 把"把读 ref 的函数传给 contextSafe"当成渲染时读 ref，属误报
  // eslint-disable-next-line react-hooks/refs
  const close = contextSafe(() => {
    if (closingRef.current) return
    closingRef.current = true
    gsap.timeline({ onComplete: onClose, defaults: { ease: "power2.in" } })
      .to(sheetRef.current, { yPercent: 100, duration: motionDuration(0.24) }, 0)
      .to(rootRef.current, { autoAlpha: 0, duration: motionDuration(0.18) }, 0)
  })

  return createPortal(
    <div ref={rootRef} className={`fixed inset-0 ${zIndexClass} flex items-end justify-center`} onClick={close}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-[640px] bg-card will-change-transform ${className}`}
      >
        {typeof children === "function" ? children({ close }) : children}
      </div>
    </div>,
    document.body,
  )
}
