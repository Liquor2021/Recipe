import { useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { recordsApi } from "@/api"
import type { MealRecord } from "@/types"
import KitchenSheet from "@/components/KitchenSheet"
import { Undo2 } from "lucide-react"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import "@/styles/kitchen-memories.css"
export default function UndoCompletionDialog({
  record,
  pending,
  error,
  onClose,
  onConfirm
}: {
  record: MealRecord
  pending: boolean
  error?: string
  onClose: () => void
  onConfirm: (entryId: number | null) => void
}) {
  const safeButtonRef = useRef<HTMLButtonElement>(null)
  const theme = useKitchenTheme((state) => state.theme)
  const history = useQuery({
    queryKey: ["record-consumption", record.id],
    queryFn: () => recordsApi.consumption(record.id),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const activeEntry = history.data?.entries.find((entry) => entry.status === "applied")
  const fetched = history.isFetchedAfterMount && history.isSuccess && !history.isFetching
  const consistent = history.data?.applied === !!activeEntry
  const canConfirm = fetched && consistent && !pending
  return (
    <KitchenSheet
      title="撤销这顿已吃记录？"
      theme={theme}
      icon={<Undo2 size={19} />}
      onClose={onClose}
      closeDisabled={pending}
      initialFocusRef={safeButtonRef}
      footer={
        <>
          <button ref={safeButtonRef} disabled={pending} onClick={onClose} className="is-ink">
            保留记录
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => {
              if (canConfirm) onConfirm(activeEntry?.id ?? null)
            }}
            className="is-danger"
          >
            {pending ? "正在撤销…" : "确认撤销"}
          </button>
        </>
      }
    >
      <p className="kitchen-sheet-context">
        <strong>{record.dish_name}</strong>
        <span>
          {record.meal_date} · {record.meal_type === "lunch" ? "午市" : "晚市"} · 已吃
        </span>
      </p>
      <p className="mt-3 text-sm text-text2 leading-relaxed">
        这道菜会恢复为待完成计划，本条记录的评分、心情和成品照会清空。
      </p>
      {history.isError ? (
        <div className="mt-3">
          <p role="alert" className="text-sm text-red">
            读取最新库存记录失败，请重试后再确认。
          </p>
          <button
            disabled={history.isFetching || pending}
            onClick={() => void history.refetch()}
            className="min-h-11 px-3 rounded-xl text-sm text-primary disabled:opacity-50"
          >
            重新读取库存记录
          </button>
        </div>
      ) : !fetched ? (
        <p role="status" className="mt-3 text-sm text-text3">
          正在确认这顿的最新库存扣减…
        </p>
      ) : !consistent ? (
        <div className="mt-3">
          <p role="alert" className="text-sm text-red">
            库存记录暂不一致，请刷新后再确认。
          </p>
          <button
            disabled={pending}
            onClick={() => void history.refetch()}
            className="min-h-11 px-3 rounded-xl text-sm text-primary disabled:opacity-50"
          >
            重新读取库存记录
          </button>
        </div>
      ) : activeEntry ? (
        <div className="mt-3 rounded-xl bg-bg p-3">
          <p className="text-sm text-text2 leading-relaxed">
            同时撤销以下库存扣减。如果相关批次后来有变动，将保留当前状态并提示你处理。
          </p>
          <time dateTime={activeEntry.created_at} className="block mt-2 text-xs text-text3">
            {new Date(activeEntry.created_at).toLocaleString("zh-CN")}
          </time>
          <ul className="mt-2 space-y-1 text-xs text-text2">
            {activeEntry.items.map((item) => (
              <li key={item.batch_id} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <span>{item.item_name}</span>
                <span>
                  {item.removed ? "已用完" : item.after_quantity || "未记数量"} →{" "}
                  {item.before_quantity || "恢复原批次"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-text2 leading-relaxed">
          当前没有需要撤销的库存扣减，只恢复这条用餐计划。
        </p>
      )}
      {error && (
        <div className="mt-3">
          <p role="alert" className="text-sm text-red">
            {error}
          </p>
          <button
            disabled={pending || history.isFetching}
            onClick={() => void history.refetch()}
            className="min-h-11 px-3 rounded-xl text-sm text-primary disabled:opacity-50"
          >
            重新读取库存记录
          </button>
        </div>
      )}
    </KitchenSheet>
  )
}
