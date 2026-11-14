import { useNavigate } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import "@/styles/kitchen-memories.css"
import type { useHistoryCalendar } from "@/pages/history/useHistoryCalendar"
type Props = {
  calendar: Pick<
    ReturnType<typeof useHistoryCalendar>,
    "calYear" | "calMonth" | "monthPending" | "monthError" | "refetchMonth" | "monthSummary"
  >
  navigate: ReturnType<typeof useNavigate>
}
export default function HistoryMonthSummary({ calendar, navigate }: Props) {
  const { calYear, calMonth, monthPending, monthError, refetchMonth, monthSummary } = calendar
  return (
    <footer className="history-month-summary" aria-label={`${calYear}年${calMonth + 1}月小结`}>
      {monthPending ? (
        <span role="status">正在整理本月手账…</span>
      ) : monthError ? (
        <button onClick={() => void refetchMonth()}>本月记录读取失败，点此重试</button>
      ) : (
        <>
          <p>
            <strong>
              {calMonth + 1}月 · {monthSummary.meals} 顿
            </strong>
            <span>
              共 {monthSummary.dishes} 道 · 午 {monthSummary.lunches} · 晚 {monthSummary.dinners}
            </span>
            {monthSummary.topDish && <span>最常吃 {monthSummary.topDish}</span>}
          </p>
          <button onClick={() => navigate("/report")}>
            饮食报告 <ChevronRight size={13} aria-hidden="true" />
          </button>
        </>
      )}
    </footer>
  )
}
