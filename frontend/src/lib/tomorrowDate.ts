const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

export function getTomorrow(now = new Date()) {
  const date = new Date(now)
  date.setDate(date.getDate() + 1)
  const str = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  return { str, label: `${str.slice(5)} ${weekdayNames[date.getDay()]}` }
}

export function nextLocalMidnightDelay(now = new Date()) {
  const midnight = new Date(now)
  // Calendar arithmetic also handles 23/25-hour days when daylight saving changes.
  midnight.setHours(24, 0, 0, 100)
  return Math.max(1, midnight.getTime() - now.getTime())
}
