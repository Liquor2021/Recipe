type ListScroller = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">

// 等容器获得实际高度后再恢复；缓存不足时保留目标，让分页继续补齐。
export function restoreListScroll(container: ListScroller, target: number, hasNextPage: boolean): boolean {
  if (container.clientHeight <= 0) return false
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTop = Math.min(target, maxScroll)
  return Math.abs(container.scrollTop - target) < 1
    || (!hasNextPage && Math.abs(container.scrollTop - maxScroll) < 1)
}
