import { useEffect, useRef } from "react"
import { gsap, motionDuration, useGSAP } from "@/lib/gsap"
import { Image, ChevronLeft, ChevronRight } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
import { useKitchenTheme } from "@/store/useKitchenTheme"

interface PhotoViewerProps {
  photos: string[]
  idx: number
  setIdx: (i: number) => void
  onClose: () => void
}

export default function PhotoViewer({ photos, idx, setIdx, onClose }: PhotoViewerProps) {
  const theme = useKitchenTheme((state) => state.theme)
  const layerRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const startX = useRef<number | null>(null)
  const animating = useRef(false)
  const idxRef = useRef(idx)
  const targetIdxRef = useRef(idx)

  useEffect(() => {
    idxRef.current = idx
    targetIdxRef.current = idx
    gsap.set(stripRef.current, { x: 0, xPercent: -idx * 100 })
  }, [idx])

  useEffect(() => {
    const strip = stripRef.current
    function alignAfterResize() {
      if (!strip) return
      // 横竖屏切换会改变每页宽度；中断旧宽度下的动画和手势，再对齐目标照片。
      startX.current = null
      animating.current = false
      gsap.killTweensOf(strip)
      const target = targetIdxRef.current
      idxRef.current = target
      gsap.set(strip, { x: 0, xPercent: -target * 100 })
      setIdx(target)
    }
    window.addEventListener("resize", alignAfterResize)
    return () => {
      window.removeEventListener("resize", alignAfterResize)
      if (strip) gsap.killTweensOf(strip)
    }
  }, [setIdx])

  const { contextSafe } = useGSAP(() => {
    gsap.set(stripRef.current, { x: 0, xPercent: -idxRef.current * 100 })
  }, { scope: layerRef })

  // eslint-disable-next-line react-hooks/refs -- contextSafe 回调在事件里执行
  const snapTo = contextSafe((newIdx: number, animate: boolean) => {
    if (!stripRef.current) return
    startX.current = null
    targetIdxRef.current = newIdx
    animating.current = true
    gsap.to(stripRef.current, {
      x: 0,
      xPercent: -newIdx * 100,
      duration: animate ? motionDuration(0.3) : 0,
      ease: "power3.out",
      overwrite: true,
      onComplete: () => {
        animating.current = false
        idxRef.current = newIdx
        setIdx(newIdx)
      },
    })
  })

  function applyTransform(offset: number) {
    if (!stripRef.current) return
    gsap.set(stripRef.current, {
      x: offset,
      xPercent: -idxRef.current * 100,
      force3D: true,
    })
  }

  function onTouchStart(e: React.TouchEvent) {
    if (animating.current || e.touches.length !== 1) return
    startX.current = e.touches[0].clientX
  }

  function onTouchMove(e: React.TouchEvent) {
    if (animating.current || startX.current === null || e.touches.length !== 1) return
    const diff = e.touches[0].clientX - startX.current
    const damping = photos.length <= 1 ? 0.2 : 1
    applyTransform(diff * damping)
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (animating.current || startX.current === null || e.changedTouches.length === 0) return
    const diff = e.changedTouches[0].clientX - startX.current
    if (diff < -80 && photos.length > 1) snapTo((idxRef.current + 1) % photos.length, true)
    else if (diff > 80 && photos.length > 1) snapTo((idxRef.current - 1 + photos.length) % photos.length, true)
    else snapTo(idxRef.current, true)
  }

  function onTouchCancel() {
    if (startX.current !== null) snapTo(idxRef.current, false)
  }

  function prev() {
    if (!animating.current) snapTo((idxRef.current - 1 + photos.length) % photos.length, true)
  }

  function next() {
    if (!animating.current) snapTo((idxRef.current + 1) % photos.length, true)
  }

  return (
    <KitchenSheet title="饭桌照片" theme={theme} icon={<Image size={19} />} onClose={onClose} closeLabel="关闭图片预览" className="kitchen-photo-viewer" footer={<>
      {photos.length > 1 && <button onClick={prev} aria-label="上一张照片"><ChevronLeft size={18} /></button>}
      <span role="status" className="kitchen-sheet-hint">{idx + 1} / {photos.length}</span>
      {photos.length > 1 && <button onClick={next} aria-label="下一张照片"><ChevronRight size={18} /></button>}
    </>}>
      <div
        ref={layerRef}
        className="kitchen-photo-stage"
        tabIndex={0}
        role="group"
        aria-label="照片预览，可按左右方向键切换"
        onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); prev() } if (event.key === "ArrowRight") { event.preventDefault(); next() } }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        style={{ touchAction: "pan-y" }}
      >
        <div
          ref={stripRef}
          className="flex h-full w-full will-change-transform"
        >
          {photos.map((src, i) => (
            <div key={i} className="flex shrink-0 items-center justify-center" style={{ width: "100%" }}>
              <img src={src} alt={"饭桌照片 " + (i + 1)} className="kitchen-photo-print" draggable={false} />
            </div>
          ))}
        </div>
      </div>
    </KitchenSheet>
  )
}
