import { ChevronLeft, ChevronRight } from "lucide-react"
import "@/styles/kitchen-memories.css"
import { weekdays, homeMoodEmojiMap } from "@/pages/history/model"
import type { useHistoryCalendar } from "@/pages/history/useHistoryCalendar"
type Props = {
  calendar: Pick<
    ReturnType<typeof useHistoryCalendar>,
    | "calMonth"
    | "calYear"
    | "changeMonth"
    | "calCells"
    | "recordByDate"
    | "today"
    | "selectedDay"
    | "dayRatingByDate"
    | "setSelectedDay"
  >
}
export default function HistoryCalendar({ calendar }: Props) {
  const {
    calMonth,
    calYear,
    changeMonth,
    calCells,
    recordByDate,
    today,
    selectedDay,
    dayRatingByDate,
    setSelectedDay
  } = calendar
  return (
    <div className="history-calendar">
      <div className="history-calendar-heading">
        <h2>
          {calMonth + 1} 月 <small>· {calYear}</small>
        </h2>
        <div className="history-calendar-legend">
          <span>
            <i className="is-eaten" />
            已吃
          </span>
          <span>
            <i className="is-planned" />
            计划
          </span>
          <span>
            <i className="is-overdue" />
            逾期
          </span>
        </div>
        <div className="history-calendar-nav">
          <button onClick={() => changeMonth(-1)} aria-label="上个月">
            <ChevronLeft size={18} strokeWidth={1.5} />
          </button>
          <button onClick={() => changeMonth(1)} aria-label="下个月">
            <ChevronRight size={18} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="history-calendar-grid">
        {weekdays.map((w) => (
          <div key={w} className="text-[11px] text-text3 font-semibold py-0.5">
            {w}
          </div>
        ))}
        {calCells.map((cell, i) => {
          const recs = recordByDate.get(cell.dateKey) || []
          const hasLunch = recs.some((r) => r.status === "completed" && r.meal_type === "lunch")
          const hasDinner = recs.some((r) => r.status === "completed" && r.meal_type === "dinner")
          const hasPlan = recs.some((r) => r.status === "planned")
          const hasOverdue = hasPlan && cell.dateKey < today
          const isSelected = cell.isCurrentMonth && selectedDay === cell.day
          const homeMood = cell.isCurrentMonth ? dayRatingByDate.get(cell.dateKey)?.home_mood : ""
          const homeMoodEmoji = homeMood ? homeMoodEmojiMap[homeMood] : ""
          return (
            <button
              key={i}
              onClick={() => cell.isCurrentMonth && setSelectedDay(cell.day)}
              aria-label={`${cell.dateKey}${hasLunch || hasDinner ? " 已吃" : ""}${hasPlan ? " 有计划" : ""}${hasOverdue ? " 已逾期" : ""}`}
              disabled={!cell.isCurrentMonth}
              aria-current={cell.isToday ? "date" : undefined}
              aria-pressed={isSelected}
              className={`history-calendar-day ${cell.isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""}`}
            >
              {cell.day}
              <span className="history-date-marks" aria-hidden="true">
                {(hasLunch || hasDinner) && <span className="is-eaten" />}
                {hasPlan && <span className={hasOverdue ? "is-overdue" : "is-planned"} />}
              </span>
              {homeMoodEmoji && (
                <span className="absolute -top-0.5 right-0 text-[10px] leading-none">
                  {homeMoodEmoji}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
