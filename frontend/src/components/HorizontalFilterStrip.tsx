import { useEffect, useState, type ReactNode, type RefObject, type UIEventHandler } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { horizontalWheelTarget } from "@/lib/horizontalScroll"
import "@/styles/horizontal-filter-strip.css"

interface HorizontalFilterStripProps {
  children: ReactNode
  label: string
  role: "navigation" | "group"
  className: string
  scrollRef: RefObject<HTMLDivElement | null>
  itemCount: number
  onScroll?: UIEventHandler<HTMLDivElement>
}

export default function HorizontalFilterStrip({ children, label, role, className, scrollRef, itemCount, onScroll }: HorizontalFilterStripProps) {
  const [edges, setEdges] = useState({ back: false, forward: false })

  useEffect(() => {
    const strip = scrollRef.current
    if (!strip) return
    const measure = () => {
      const back = strip.scrollLeft > 1
      const forward = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
      setEdges(previous => previous.back === back && previous.forward === forward ? previous : { back, forward })
    }
    // 普通鼠标的纵向滚轮也能翻动筛选项；到达边缘后放行页面滚动。
    const onWheel = (event: WheelEvent) => {
      const next = horizontalWheelTarget(event, strip)
      if (next === null) return
      event.preventDefault()
      strip.scrollLeft = next
    }
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    strip.addEventListener("scroll", measure, { passive: true })
    strip.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      observer.disconnect()
      strip.removeEventListener("scroll", measure)
      strip.removeEventListener("wheel", onWheel)
    }
  }, [scrollRef, itemCount])

  const move = (direction: number) => {
    const strip = scrollRef.current
    if (strip) strip.scrollBy({ left: direction * strip.clientWidth * .7, behavior: "auto" })
  }
  const overflow = edges.back || edges.forward

  return (
    <div className="kitchen-filter-strip" data-no-swipe data-overflow-start={edges.back} data-overflow-end={edges.forward}>
      {/* 保留箭头占位，避免首次测量后宽度变化夹断从详情页恢复的滚动位置。 */}
      <button type="button" className="kitchen-filter-arrow" style={{ visibility: overflow ? "visible" : "hidden" }} aria-label={`向左滚动${label}`} disabled={!edges.back} onClick={() => move(-1)}><ChevronLeft size={15} aria-hidden="true" /></button>
      <div ref={scrollRef} role={role} aria-label={label} className={className} onScroll={onScroll}>{children}</div>
      <button type="button" className="kitchen-filter-arrow" style={{ visibility: overflow ? "visible" : "hidden" }} aria-label={`向右滚动${label}`} disabled={!edges.forward} onClick={() => move(1)}><ChevronRight size={15} aria-hidden="true" /></button>
    </div>
  )
}
