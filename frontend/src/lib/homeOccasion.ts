import type { Holiday } from "../types/index.ts"

type OccasionNote = {
  key: string
  date: string
  message: string
  kind: "holiday" | "weekend"
}

const dayMs = 86400000

function calendarDay(key: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const timestamp = Date.parse(`${key}T00:00:00Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== key)
    return null
  return timestamp
}

// 用日历日期而非本地午夜时间差计天，跨夏令时也不会少/多算一天。
export function homeOccasion(
  holidays: readonly Holiday[] | null | undefined,
  today: string
): OccasionNote | null {
  const now = calendarDay(today)
  if (now === null) return null
  const candidates = (Array.isArray(holidays) ? holidays : [])
    .flatMap((holiday) => {
      if (
        !holiday ||
        typeof holiday.name !== "string" ||
        !holiday.name.trim() ||
        typeof holiday.date !== "string"
      )
        return []
      const date = calendarDay(holiday.date)
      if (date === null) return []
      const days = (date - now) / dayMs
      return days >= 0 && days <= 7 ? [{ holiday, days }] : []
    })
    .sort((a, b) => a.days - b.days)
  const upcoming = candidates[0]
  if (upcoming) {
    const { holiday, days } = upcoming
    const name = holiday.name.trim().slice(0, 40)
    const greeting =
      typeof holiday.greeting === "string" ? holiday.greeting.trim().slice(0, 100) : ""
    return {
      key: `holiday:${holiday.date}:${holiday.id}`,
      date: holiday.date,
      kind: "holiday",
      message:
        days === 0
          ? `今天是${name}，${greeting || "做顿喜欢的，好好过节。"}`
          : `${days === 1 ? "明天" : `再过 ${days} 天`}就是${name}，安排顿好的？`
    }
  }
  const weekday = new Date(now).getUTCDay()
  const days = weekday === 0 || weekday === 6 ? 0 : 6 - weekday
  // 周一、周二不提醒；周末仅按日历说，不声称是法定休假或猜测调休。
  if (days > 3) return null
  const date = new Date(now + days * dayMs).toISOString().slice(0, 10)
  if (calendarDay(date) === null) return null
  return {
    key: `weekend:${date}`,
    date,
    kind: "weekend",
    message:
      days === 0
        ? "周末到了，慢慢做顿喜欢的吧。"
        : `${days === 1 ? "明天" : `再过 ${days} 天`}就是周末，安排顿好的？`
  }
}

export function occasionDismissalKey(today: string, note: Pick<OccasionNote, "key">) {
  return `${today}:${note.key}`
}
