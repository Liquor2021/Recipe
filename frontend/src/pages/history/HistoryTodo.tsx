import "@/styles/kitchen-memories.css"
import {
  HistoryRecordRow,
  SwipeRowCard,
  type HistoryRowActions
} from "@/pages/history/HistoryRecordRow"
import type { useHistoryCalendar } from "@/pages/history/useHistoryCalendar"
import type { useHistoryRecordActions } from "@/pages/history/useHistoryRecordActions"
type Props = {
  calendar: Pick<ReturnType<typeof useHistoryCalendar>, "pendingQuery" | "pendingRecords">
  actions: Pick<ReturnType<typeof useHistoryRecordActions>, "requestDelete" | "recordActionPending">
  rowActions: HistoryRowActions
}
export default function HistoryTodo({ calendar, actions, rowActions }: Props) {
  const { pendingQuery, pendingRecords } = calendar
  const { requestDelete, recordActionPending } = actions
  return (
    <div>
      <p className="history-pending-intro">没做的、想做的，都记在这里。</p>
      {pendingQuery.isPending ? (
        <div className="py-8 text-center text-sm text-text3" role="status">
          正在读取待完成计划…
        </div>
      ) : pendingQuery.isError && !pendingQuery.data ? (
        <button
          onClick={() => void pendingQuery.refetch()}
          className="w-full min-h-11 px-4 py-3 text-sm text-primary"
        >
          计划读取失败，点此重试
        </button>
      ) : pendingRecords.length === 0 ? (
        <div className="kitchen-empty history-empty">
          <span className="block text-4xl mb-3">🍽</span>
          <div className="text-base font-semibold">没有待完成的计划</div>
          <div className="mt-1 text-[13px] text-text2">安排好想吃的菜后，会显示在这里。</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {pendingRecords.map((record) => (
            <SwipeRowCard key={record.id} onDelete={() => requestDelete(record)}>
              <HistoryRecordRow record={record} showDate {...rowActions} />
            </SwipeRowCard>
          ))}
          {pendingQuery.hasNextPage && (
            <button
              disabled={pendingQuery.isFetching || recordActionPending}
              onClick={() => {
                if (!pendingQuery.isFetching && !recordActionPending)
                  void pendingQuery.fetchNextPage()
              }}
              className="min-h-11 mt-2 rounded-xl bg-card border border-border text-sm text-primary disabled:opacity-50"
            >
              {pendingQuery.isFetching
                ? "正在读取…"
                : pendingQuery.isFetchNextPageError
                  ? "读取失败，重试"
                  : "加载更多计划"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
