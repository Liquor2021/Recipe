import { useState, useRef, useEffect, useEffectEvent } from "react"
import { createPortal } from "react-dom"
import { useNavigate, useLocation } from "react-router-dom"
import { getUploadErrorMessage } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import type { MealRecord } from "@/types"
import PageHeader, { HeaderIconButton } from "@/components/PageHeader"
import PhotoViewer from "@/components/PhotoViewer"
import ConsumeInventorySheet from "@/components/ConsumeInventorySheet"
import InventoryHistorySheet from "@/components/InventoryHistorySheet"
import ReschedulePlanSheet from "@/components/ReschedulePlanSheet"
import toast from "react-hot-toast"
import { BarChart3 } from "lucide-react"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import "@/styles/kitchen-memories.css"
import { mealMoodFromParam } from "@/lib/mealRating"
import type { MealMood } from "@/lib/mealRating"
import { useHistoryCalendar } from "@/pages/history/useHistoryCalendar"
import { useHistoryRecordActions } from "@/pages/history/useHistoryRecordActions"
import { useRecordRatingEditor } from "@/pages/history/useRecordRatingEditor"
import { useDayRatingEditor } from "@/pages/history/useDayRatingEditor"
import { useHistoryDayPhotos } from "@/pages/history/useHistoryDayPhotos"
import HistoryCalendar from "@/pages/history/HistoryCalendar"
import HistoryDayPage from "@/pages/history/HistoryDayPage"
import HistoryMonthSummary from "@/pages/history/HistoryMonthSummary"
import HistoryTodo from "@/pages/history/HistoryTodo"
import HistoryRecordRating from "@/pages/history/HistoryRecordRating"
import HistoryDayRating from "@/pages/history/HistoryDayRating"
import UndoCompletionDialog from "@/pages/history/UndoCompletionDialog"
export default function History() {
  const theme = useKitchenTheme((state) => state.theme)
  const navigate = useNavigate()
  const location = useLocation()
  const isAdminLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const calendar = useHistoryCalendar()
  const actions = useHistoryRecordActions()
  const { rescheduleRecord, undoRecord } = actions
  const recordEditor = useRecordRatingEditor()
  const dayEditor = useDayRatingEditor({
    selectedDateKey: calendar.selectedDateKey,
    canRateSelectedDay: calendar.canRateSelectedDay
  })
  const dayPhotos = useHistoryDayPhotos(calendar.selectedDateKey)
  const [viewerPhotos, setViewerPhotos] = useState<string[]>([])
  const [viewerIdx, setViewerIdx] = useState(0)
  const [showViewer, setShowViewer] = useState(false)
  const rowActions = {
    today: calendar.today,
    pending: actions.recordActionPending,
    onStatus: (record: MealRecord, status: MealRecord["status"]) =>
      actions.statusMut.mutate({ record, status }),
    onRating: recordEditor.openRating,
    onReschedule: actions.openReschedule,
    onInventory: actions.setInventoryRecord,
    onUndo: actions.openUndo
  }
  function openViewer(photos: string[], idx: number) {
    setViewerPhotos(photos)
    setViewerIdx(idx)
    setShowViewer(true)
  }
  function closeViewer() {
    setShowViewer(false)
  }
  const reviewedLocation = useRef<string | null>(null)
  const openReviewFromHome = useEffectEvent((mood?: MealMood) => dayEditor.openMealRating(mood))
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (
      location.pathname !== "/history" ||
      params.get("review") !== "day" ||
      params.get("date") !== calendar.selectedDateKey ||
      calendar.monthPending ||
      calendar.monthError ||
      reviewedLocation.current === location.key
    )
      return
    reviewedLocation.current = location.key
    // 外部路由进入并读到当天记录后，打开同一套评价会话；每次导航只处理一次。
    if (calendar.canRateSelectedDay) openReviewFromHome(mealMoodFromParam(params.get("mood")))
    else toast("这天还没有已吃记录，吃过后再来评价吧")
  }, [
    location.pathname,
    location.search,
    location.key,
    calendar.selectedDateKey,
    calendar.monthPending,
    calendar.monthError,
    calendar.canRateSelectedDay
  ])
  return (
    <div className="kitchen-history animate-fadeUp">
      <PageHeader
        title="记录"
        meta={calendar.stats ? calendar.stats.total_records + " 道已吃" : undefined}
        actions={
          <HeaderIconButton onClick={() => navigate("/report")} aria-label="饮食报告">
            <BarChart3 size={18} strokeWidth={1.7} />
          </HeaderIconButton>
        }
      />

      <div className="kitchen-memory-body">
        <div className="history-view-tabs" role="group" aria-label="记录视图">
          <button
            onClick={() => calendar.setView("calendar")}
            aria-pressed={calendar.view === "calendar"}
          >
            日历记录
          </button>
          <button
            onClick={() => calendar.setView("pending")}
            aria-pressed={calendar.view === "pending"}
          >
            待完成
            {calendar.pendingQuery.data && (
              <span className="history-pending-count">
                {calendar.pendingQuery.data.pages[0].total}
              </span>
            )}
          </button>
        </div>
        {calendar.view === "pending" ? (
          <HistoryTodo calendar={calendar} actions={actions} rowActions={rowActions} />
        ) : (
          <>
            <HistoryCalendar calendar={calendar} />

            {calendar.selectedDay !== null && (
              <HistoryDayPage
                calendar={calendar}
                review={dayEditor}
                actions={actions}
                photos={dayPhotos}
                navigate={navigate}
                rowActions={rowActions}
                openViewer={openViewer}
                isAdminLoggedIn={isAdminLoggedIn}
              />
            )}

            <HistoryMonthSummary calendar={calendar} navigate={navigate} />
          </>
        )}
      </div>

      <ConsumeInventorySheet
        dish={actions.consumption?.dish || null}
        portionScale={actions.consumption?.portionScale || 1}
        recordId={actions.consumption?.recordId || 0}
        onClose={() => actions.setConsumption(null)}
      />
      <InventoryHistorySheet
        record={actions.inventoryRecord}
        onClose={() => actions.setInventoryRecord(null)}
        onSupplement={(record) => {
          if (!actions.supplementMut.isPending) actions.supplementMut.mutate(record)
        }}
      />
      {rescheduleRecord && (
        <ReschedulePlanSheet
          key={rescheduleRecord.id}
          record={rescheduleRecord}
          pending={actions.rescheduleMut.isPending}
          error={
            actions.rescheduleMut.isError
              ? getUploadErrorMessage(actions.rescheduleMut.error, "改期失败，请稍后重试")
              : undefined
          }
          onClose={() => actions.setRescheduleRecord(null)}
          onSubmit={(data) => actions.rescheduleMut.mutate({ record: rescheduleRecord, ...data })}
        />
      )}
      {undoRecord && (
        <UndoCompletionDialog
          key={undoRecord.id}
          record={undoRecord}
          pending={actions.undoMut.isPending}
          error={
            actions.undoMut.isError
              ? getUploadErrorMessage(actions.undoMut.error, "撤销失败，请稍后重试")
              : undefined
          }
          onClose={() => actions.setUndoRecord(null)}
          onConfirm={(entryId) => actions.undoMut.mutate({ record: undoRecord, entryId })}
        />
      )}

      {recordEditor.ratingRecord && (
        <HistoryRecordRating
          editor={recordEditor}
          theme={theme}
          isAdminLoggedIn={isAdminLoggedIn}
        />
      )}

      {dayEditor.showMealRating && (
        <HistoryDayRating review={dayEditor} theme={theme} isAdminLoggedIn={isAdminLoggedIn} />
      )}

      {showViewer &&
        viewerPhotos.length > 0 &&
        createPortal(
          <PhotoViewer
            photos={viewerPhotos}
            idx={viewerIdx}
            setIdx={setViewerIdx}
            onClose={closeViewer}
          />,
          document.body
        )}
    </div>
  )
}
