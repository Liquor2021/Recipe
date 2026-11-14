import { useNavigate } from "react-router-dom"
import DayPlanEditor from "@/components/DayPlanEditor"
import { planDateShortcuts } from "@/lib/planDate"
import { Camera, NotebookPen } from "lucide-react"
import "@/styles/kitchen-memories.css"
import { thumbUrl } from "@/lib/dishImage"
import {
  moodEmojiMap,
  homeMoodEmojiMap,
  homeMoodLabelMap,
  parsePhotos
} from "@/pages/history/model"
import {
  HistoryRecordRow,
  SwipeRowBg,
  type HistoryRowActions
} from "@/pages/history/HistoryRecordRow"
import type { useHistoryCalendar } from "@/pages/history/useHistoryCalendar"
import type { useDayRatingEditor } from "@/pages/history/useDayRatingEditor"
import type { useHistoryRecordActions } from "@/pages/history/useHistoryRecordActions"
import type { useHistoryDayPhotos } from "@/pages/history/useHistoryDayPhotos"
type Props = {
  calendar: Pick<
    ReturnType<typeof useHistoryCalendar>,
    | "calMonth"
    | "selectedDay"
    | "selectedDateKey"
    | "today"
    | "dayRating"
    | "canRateSelectedDay"
    | "monthPending"
    | "monthError"
    | "refetchMonth"
    | "selectedRecords"
    | "selectedIsFuture"
    | "completedMealTypes"
  >
  review: Pick<ReturnType<typeof useDayRatingEditor>, "openMealRating">
  actions: Pick<ReturnType<typeof useHistoryRecordActions>, "requestDelete">
  photos: Pick<
    ReturnType<typeof useHistoryDayPhotos>,
    | "dayPhotoError"
    | "dayPhotoReading"
    | "updateDayPhotosMut"
    | "reloadDayPhotos"
    | "removeDayPhoto"
  >
  navigate: ReturnType<typeof useNavigate>
  rowActions: HistoryRowActions
  openViewer: (photos: string[], idx: number) => void
  isAdminLoggedIn: boolean
}
export default function HistoryDayPage({
  calendar,
  review,
  actions,
  photos,
  navigate,
  rowActions,
  openViewer,
  isAdminLoggedIn
}: Props) {
  const {
    calMonth,
    selectedDay,
    selectedDateKey,
    today,
    dayRating,
    canRateSelectedDay,
    monthPending,
    monthError,
    refetchMonth,
    selectedRecords,
    selectedIsFuture,
    completedMealTypes
  } = calendar
  const { openMealRating } = review
  const { requestDelete } = actions
  const { dayPhotoError, dayPhotoReading, updateDayPhotosMut, reloadDayPhotos, removeDayPhoto } =
    photos
  return (
    <section
      className="history-day-ledger animate-pop-soft"
      aria-labelledby="history-selected-date"
    >
      <div className="history-day-heading">
        <div className="flex items-center gap-1.5 flex-wrap">
          <h2 id="history-selected-date">
            「{calMonth + 1}月{selectedDay}日」
          </h2>
          {selectedDateKey === today && <span className="history-today-note">今天</span>}
          {dayRating?.home_mood && (
            <span className="memory-mood-stamp">
              {homeMoodEmojiMap[dayRating.home_mood] || "😃"}{" "}
              {homeMoodLabelMap[dayRating.home_mood] || "心情"}
            </span>
          )}
        </div>
        {canRateSelectedDay ? (
          <button
            onClick={() => openMealRating()}
            className="history-day-rating"
            aria-label={dayRating?.mood ? "编辑当日心情与评价" : "记录当日心情与评价"}
            title={dayRating?.mood ? "编辑当日心情与评价" : "记录当日心情与评价"}
          >
            <span aria-hidden="true">{dayRating?.mood ? moodEmojiMap[dayRating.mood] : "😌"}</span>
          </button>
        ) : null}
      </div>
      {selectedDateKey >= today ? (
        <div className="history-plan-tools">
          <div className="planner-shortcuts" aria-label="快捷安排日期">
            {planDateShortcuts(new Date()).map((shortcut) => (
              <button
                key={shortcut.label}
                onClick={() => navigate(`/history?date=${shortcut.date}`)}
              >
                {shortcut.label}
              </button>
            ))}
          </div>
          <DayPlanEditor
            key={selectedDateKey}
            date={selectedDateKey}
            renderRecord={(record) => <HistoryRecordRow record={record} {...rowActions} />}
          />
          <button
            type="button"
            className="history-plan-link"
            onClick={() => navigate(`/more?date=${selectedDateKey}#week`)}
          >
            去这一周看看 ›
          </button>
        </div>
      ) : monthPending ? (
        <div className="py-5 px-4 text-center text-[13px] text-text3">正在读取记录…</div>
      ) : monthError ? (
        <button
          onClick={() => void refetchMonth()}
          className="w-full min-h-11 px-4 py-3 text-[13px] text-primary"
        >
          记录读取失败，点此重试
        </button>
      ) : selectedRecords.length === 0 ? (
        <div className="kitchen-empty history-empty">
          <NotebookPen size={28} strokeWidth={1.3} aria-hidden="true" />
          <p>
            {selectedDateKey === today
              ? "今天还没有记录哦~"
              : selectedIsFuture
                ? "这天还没有安排"
                : "这天没有记录"}
          </p>
        </div>
      ) : (
        selectedRecords.map((r) => (
          <SwipeRowBg key={r.id} onDelete={() => requestDelete(r)}>
            <HistoryRecordRow record={r} {...rowActions} />
          </SwipeRowBg>
        ))
      )}
      {dayRating?.mood && canRateSelectedDay && (
        <div className="history-day-review">
          <span className="text-xl">🍚</span>
          <span className="flex-1 text-text2">
            {completedMealTypes.size > 1
              ? "午餐+晚餐"
              : completedMealTypes.has("lunch")
                ? "午餐"
                : "晚餐"}{" "}
            · 整体评价
            {dayRating.remark && <span className="ml-1 text-text"> {dayRating.remark}</span>}
          </span>
          <span className="text-xl">{moodEmojiMap[dayRating.mood] || "😋"}</span>
        </div>
      )}
      {dayPhotoError?.date === selectedDateKey && (
        <div role="alert" className="border-t border-border px-4 py-3 text-sm text-text2">
          <p>{dayPhotoError.message}</p>
          {!dayPhotoError.ready && (
            <button
              disabled={dayPhotoReading || updateDayPhotosMut.isPending}
              onClick={() => void reloadDayPhotos()}
              className="mt-2 min-h-11 rounded-full bg-bg px-4 font-semibold text-primary disabled:opacity-50"
            >
              {dayPhotoReading ? "正在读取照片…" : "重新读取照片"}
            </button>
          )}
        </div>
      )}
      {(() => {
        const dayPhotos = dayRating?.photos ? parsePhotos(dayRating.photos) : []
        const hasPhotos = dayPhotos.length > 0
        // 只有计划或已取消的日子不提示评价；已上传的照片仍可查看。
        if (!hasPhotos && !canRateSelectedDay) return null
        return (
          <div className="history-day-photos">
            {hasPhotos && (
              <div className="history-photo-list" aria-label="当日照片">
                {dayPhotos.map((p, i) => (
                  <div key={p} className="history-photo-item">
                    <button
                      className="history-polaroid"
                      onClick={() => openViewer(dayPhotos, i)}
                      aria-label={`查看第 ${i + 1} 张照片`}
                    >
                      <img src={thumbUrl(p)} alt="" loading="lazy" decoding="async" />
                      <span>
                        {calMonth + 1}.{selectedDay} · 饭桌记忆
                      </span>
                    </button>
                    {isAdminLoggedIn && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (dayRating) removeDayPhoto(i, dayRating)
                        }}
                        aria-label={`删除第 ${i + 1} 张照片`}
                        disabled={
                          dayPhotoReading ||
                          (dayPhotoError?.date === selectedDateKey && !dayPhotoError.ready) ||
                          (updateDayPhotosMut.isPending &&
                            updateDayPhotosMut.variables.meal_date === selectedDateKey)
                        }
                        className="history-photo-delete"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canRateSelectedDay && (
              <div className="history-photo-invitation">
                <button
                  onClick={() => openMealRating()}
                  className="history-photo-add"
                  aria-label="贴一张饭桌照片"
                >
                  <Camera size={20} strokeWidth={1.5} aria-hidden="true" />
                  <span>贴一张</span>
                </button>
                <p>
                  给{selectedDateKey === today ? "今天" : "这天"}
                  的饭桌拍一张，照片墙和做菜回忆都会留着它。
                </p>
              </div>
            )}
          </div>
        )
      })()}
    </section>
  )
}
