import { useRef, useEffect } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import type { MealRecord } from "@/types"
import SwipeDeleteRow from "@/components/SwipeDeleteRow"
import { Ellipsis, Star } from "lucide-react"
import "@/styles/kitchen-memories.css"
import { getPlanDateLabel } from "@/lib/historySummary"
import { moodEmojiMap, statusLabels } from "@/pages/history/model"
export function HistoryRecordRow({
  record,
  showDate = false,
  today,
  pending,
  onStatus,
  onRating,
  onReschedule,
  onInventory,
  onUndo
}: {
  record: MealRecord
  showDate?: boolean
  today: string
  pending: boolean
  onStatus: (record: MealRecord, status: MealRecord["status"]) => void
  onRating: (record: MealRecord) => void
  onReschedule: (record: MealRecord) => void
  onInventory: (record: MealRecord) => void
  onUndo: (record: MealRecord) => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const rowRef = useRef<HTMLElement>(null)
  const isSource =
    location.pathname === "/history" &&
    new URLSearchParams(location.search).get("record") === String(record.id)
  useEffect(() => {
    if (!isSource) return
    const frame = requestAnimationFrame(() => {
      rowRef.current?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [isSource, location.key])
  const completed = record.status === "completed"
  const planned = record.status === "planned"
  const canComplete = planned && record.meal_date <= today
  const overdue = planned && record.meal_date < today
  return (
    <article
      ref={rowRef}
      key={record.status}
      data-record-id={record.id}
      className={`history-ledger-row ${isSource ? "is-achievement-source" : ""} ${showDate ? "history-plan-row" : ""}`}
    >
      {isSource && <p className="history-source-note">成就的解锁出处</p>}
      <div className="history-ledger-main">
        {showDate && (
          <span className={`history-relative-date ${overdue ? "is-overdue" : ""}`}>
            {getPlanDateLabel(record.meal_date, today)}
          </span>
        )}
        <button
          onClick={() =>
            navigate("/dishes/" + record.dish_id + (completed ? "" : "?record_id=" + record.id))
          }
          className="history-dish-link"
        >
          <strong className={record.status === "cancelled" ? "is-cancelled" : undefined}>
            {record.dish_name}
          </strong>
          <span className="memory-dot-leader" aria-hidden="true" />
          <span className="history-meal-label">
            {record.meal_type === "lunch" ? "午市" : "晚市"}
          </span>
        </button>
        {!showDate && (
          <span className={"history-status-stamp is-" + record.status}>
            {statusLabels[record.status] || "计划"}
          </span>
        )}
      </div>
      <div className={`history-row-footnote ${!planned ? "has-more" : ""}`}>
        <span>
          {showDate && (
            <>
              <time dateTime={record.meal_date}>{record.meal_date}</time> ·{" "}
            </>
          )}
          原量 × {record.portion_scale || 1}
          {completed && record.mood && <span> · {moodEmojiMap[record.mood]}</span>}
          {completed && record.rating > 0 && <span> · ★ {record.rating}</span>}
        </span>
        {completed && (
          <button
            onClick={() => onRating(record)}
            aria-label={"评价" + record.dish_name}
            title={"评价" + record.dish_name}
            className="history-round-button history-rating-button"
          >
            <Star size={15} aria-hidden="true" fill={record.rating > 0 ? "currentColor" : "none"} />
          </button>
        )}
      </div>
      {overdue && !showDate && (
        <p className="history-overdue">{getPlanDateLabel(record.meal_date, today)}</p>
      )}
      {planned ? (
        <div className="history-action-buttons history-plan-actions">
          {canComplete && (
            <>
              <button
                disabled={pending}
                className="is-cook"
                onClick={() =>
                  navigate("/dishes/" + record.dish_id + "/cook?record_id=" + record.id)
                }
              >
                开始做菜
              </button>
              <button
                disabled={pending}
                className="is-primary"
                onClick={() => onStatus(record, "completed")}
              >
                标记已吃
              </button>
            </>
          )}
          <button disabled={pending} onClick={() => onReschedule(record)}>
            改期
          </button>
          <button disabled={pending} onClick={() => onStatus(record, "cancelled")}>
            取消计划
          </button>
        </div>
      ) : (
        <details className="history-row-actions">
          <summary
            className="history-round-button"
            aria-label={record.dish_name + "的更多操作"}
            title="更多操作"
          >
            <Ellipsis size={17} aria-hidden="true" />
          </summary>
          <div className="history-action-content">
            <div className="history-action-buttons">
              {!completed ? (
                <button disabled={pending} onClick={() => onStatus(record, "planned")}>
                  恢复计划
                </button>
              ) : (
                <>
                  <button disabled={pending} onClick={() => onUndo(record)}>
                    撤销已吃
                  </button>
                  <button disabled={pending} onClick={() => onInventory(record)}>
                    {record.inventory_applied ? "库存记录" : "补扣库存"}
                  </button>
                </>
              )}
            </div>
          </div>
        </details>
      )}
      {completed && record.remark && <p className="history-record-remark">“{record.remark}”</p>}
    </article>
  )
}
export function SwipeRowBg({
  children,
  onDelete
}: {
  children: React.ReactNode
  onDelete: () => void
}) {
  return (
    <SwipeDeleteRow actionWidth={80} onDelete={onDelete} className="history-swipe-row">
      {children}
    </SwipeDeleteRow>
  )
}
export function SwipeRowCard({
  children,
  onDelete
}: {
  children: React.ReactNode
  onDelete: () => void
}) {
  return (
    <SwipeDeleteRow
      actionWidth={72}
      onDelete={onDelete}
      className="history-swipe-row history-swipe-card"
    >
      {children}
    </SwipeDeleteRow>
  )
}
export type HistoryRowActions = Omit<Parameters<typeof HistoryRecordRow>[0], "record" | "showDate">
