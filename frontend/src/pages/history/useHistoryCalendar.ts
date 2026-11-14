import { useState, useMemo, useEffect } from "react"
import { useLocation } from "react-router-dom"
import { useQuery, useInfiniteQuery } from "@tanstack/react-query"
import { recordsApi, statsApi, dayRatingApi } from "@/api"
import type { MealRecord, DayRating } from "@/types"
import { getHistoryMonthSummary } from "@/lib/historySummary"
import { nextLocalMidnightDelay } from "@/lib/tomorrowDate"
import { todayStr } from "@/pages/history/model"
export function useHistoryCalendar() {
  const location = useLocation()
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  const [selectedDay, setSelectedDay] = useState<number | null>(new Date().getDate())
  const [view, setView] = useState<"calendar" | "pending">("calendar")
  const [today, setToday] = useState(todayStr)
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => statsApi.get() })
  const pendingQuery = useInfiniteQuery({
    queryKey: ["records", "pending"],
    queryFn: ({ pageParam }) =>
      recordsApi.list({ status: "planned", page: String(pageParam), pageSize: "20" }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      pages.length * 20 < lastPage.total ? pages.length + 1 : undefined
  })
  const pendingRecords = pendingQuery.data?.pages.flatMap((page) => page.items || []) || []
  const selectedDateKey =
    selectedDay !== null
      ? `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`
      : ""
  const selectedIsFuture = selectedDateKey > today
  const monthStartKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-01`
  const monthEndKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(new Date(calYear, calMonth + 1, 0).getDate()).padStart(2, "0")}`
  const { data: dayRatingData } = useQuery({
    queryKey: ["day-rating", selectedDateKey],
    queryFn: () => dayRatingApi.get(selectedDateKey),
    enabled: !!selectedDateKey
  })
  const dayRating = (dayRatingData as DayRating | null) || null
  const { data: dayRatings = [] } = useQuery({
    queryKey: ["day-ratings", calYear, calMonth],
    queryFn: () => dayRatingApi.list({ date_from: monthStartKey, date_to: monthEndKey })
  })
  const {
    data: monthRecords,
    isPending: monthPending,
    isError: monthError,
    refetch: refetchMonth
  } = useQuery({
    queryKey: ["records", "calendar", monthStartKey, monthEndKey],
    queryFn: async () => {
      const params = { date_from: monthStartKey, date_to: monthEndKey, pageSize: "100" }
      const first = await recordsApi.list(params)
      const remainingPages = Math.max(0, Math.ceil(first.total / 100) - 1)
      const rest = await Promise.all(
        Array.from({ length: remainingPages }, (_, i) =>
          recordsApi.list({ ...params, page: String(i + 2) })
        )
      )
      return [first, ...rest].flatMap((page) => page.items || [])
    }
  })
  const monthSummary = useMemo(
    () => getHistoryMonthSummary(monthRecords ?? [], monthStartKey, monthEndKey),
    [monthRecords, monthStartKey, monthEndKey]
  )
  const recordByDate = useMemo(() => {
    const m = new Map<string, MealRecord[]>()
    monthRecords?.forEach((r) => {
      const arr = m.get(r.meal_date) || []
      arr.push(r)
      m.set(r.meal_date, arr)
    })
    return m
  }, [monthRecords])
  const dayRatingByDate = useMemo(() => {
    const m = new Map<string, DayRating>()
    dayRatings.forEach((r) => m.set(r.meal_date, r))
    return m
  }, [dayRatings])
  function buildCalendar() {
    const firstDay = new Date(calYear, calMonth, 1).getDay()
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
    const prevDays = new Date(calYear, calMonth, 0).getDate()
    const cells: {
      day: number
      isCurrentMonth: boolean
      isToday: boolean
      dateKey: string
    }[] = []
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = prevDays - i
      const pm = calMonth === 0 ? 11 : calMonth - 1
      const py = calMonth === 0 ? calYear - 1 : calYear
      cells.push({
        day: d,
        isCurrentMonth: false,
        isToday: false,
        dateKey: `${py}-${String(pm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday =
        `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` ===
        today
      cells.push({
        day: d,
        isCurrentMonth: true,
        isToday,
        dateKey: `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      })
    }
    const remaining = (7 - ((firstDay + daysInMonth) % 7)) % 7
    for (let i = 1; i <= remaining; i++) {
      const nm = calMonth === 11 ? 0 : calMonth + 1
      const ny = calMonth === 11 ? calYear + 1 : calYear
      cells.push({
        day: i,
        isCurrentMonth: false,
        isToday: false,
        dateKey: `${ny}-${String(nm + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`
      })
    }
    return cells
  }
  const calCells = buildCalendar()
  const selectedRecords = selectedDay !== null ? recordByDate.get(selectedDateKey) || [] : []
  const selectedCompletedRecords = selectedRecords.filter((r) => r.status === "completed")
  const canRateSelectedDay = !monthError && !selectedIsFuture && selectedCompletedRecords.length > 0
  const completedMealTypes = new Set(selectedCompletedRecords.map((r) => r.meal_type))
  function changeMonth(dir: number) {
    let m = calMonth + dir
    let y = calYear
    if (m > 11) {
      m = 0
      y++
    }
    if (m < 0) {
      m = 11
      y--
    }
    setCalMonth(m)
    setCalYear(y)
    setSelectedDay(null)
  }
  useEffect(() => {
    if (location.pathname !== "/history") return
    const raw = new URLSearchParams(location.search).get("date")
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return
    const date = new Date(raw + "T12:00:00")
    if (Number.isNaN(date.getTime()) || date.getDate() !== Number(raw.slice(8))) return
    // 成就出处是外部路由输入；同步到保留挂载的日历选择。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCalYear(date.getFullYear())
    setCalMonth(date.getMonth())
    setSelectedDay(date.getDate())
    setView("calendar")
  }, [location.pathname, location.search])
  useEffect(() => {
    let timer: number
    function refreshDate() {
      window.clearTimeout(timer)
      setToday(todayStr())
      timer = window.setTimeout(refreshDate, nextLocalMidnightDelay())
    }
    timer = window.setTimeout(refreshDate, nextLocalMidnightDelay())
    window.addEventListener("focus", refreshDate)
    document.addEventListener("visibilitychange", refreshDate)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", refreshDate)
      document.removeEventListener("visibilitychange", refreshDate)
    }
  }, [])
  return {
    calYear,
    calMonth,
    selectedDay,
    setSelectedDay,
    view,
    setView,
    today,
    stats,
    pendingQuery,
    pendingRecords,
    selectedDateKey,
    selectedIsFuture,
    dayRating,
    monthPending,
    monthError,
    refetchMonth,
    monthSummary,
    recordByDate,
    dayRatingByDate,
    calCells,
    selectedRecords,
    selectedCompletedRecords,
    canRateSelectedDay,
    completedMealTypes,
    changeMonth
  }
}
