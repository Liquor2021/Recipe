type WheelDelta = Pick<WheelEvent, "ctrlKey" | "shiftKey" | "deltaX" | "deltaY" | "deltaMode">
type ScrollMetrics = Pick<HTMLElement, "scrollLeft" | "clientWidth" | "scrollWidth">

// null 表示交回浏览器：缩放、原生横向滚动，以及已到头的纵向滚动。
export function horizontalWheelTarget(event: WheelDelta, strip: ScrollMetrics): number | null {
  if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return null
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
  const next = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, strip.scrollLeft + event.deltaY * unit))
  return Math.abs(next - strip.scrollLeft) < 1 ? null : next
}
