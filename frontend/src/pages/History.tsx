import { useState, useMemo, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { useNavigate, useLocation } from "react-router-dom"
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { recordsApi, statsApi, dayRatingApi, dishesApi, uploadApi, getUploadErrorMessage } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import type { MealRecord, DayRating, Dish } from "@/types"
import StatCard from "@/components/StatCard"
import SectionHeader from "@/components/SectionHeader"
import SafeImage from "@/components/SafeImage"
import PageHeader, { HeaderIconButton } from "@/components/PageHeader"
import PhotoViewer from "@/components/PhotoViewer"
import SwipeDeleteRow from "@/components/SwipeDeleteRow"
import ConsumeInventorySheet from "@/components/ConsumeInventorySheet"
import InventoryHistorySheet from "@/components/InventoryHistorySheet"
import ReschedulePlanSheet from "@/components/ReschedulePlanSheet"
import { cardShadow } from "@/components/Card"
import toast from "react-hot-toast"
import { CalendarDays, Star } from "lucide-react"
import { thumbUrl } from "@/lib/dishImage"

const weekdays = ["日", "一", "二", "三", "四", "五", "六"]

const moodOptions = [
  { key: "yum", emoji: "😋", label: "好吃" },
  { key: "ok", emoji: "😐", label: "一般" },
  { key: "no", emoji: "😵", label: "不想再吃" },
]

const mealMoodOptions = [
  { key: "great", emoji: "😋", label: "超满足" },
  { key: "ok", emoji: "😐", label: "还行吧" },
  { key: "meh", emoji: "😕", label: "不太行" },
]

const moodEmojiMap: Record<string, string> = { yum: "😋", ok: "😐", no: "😵", great: "😋", meh: "😕" }
const homeMoodEmojiMap: Record<string, string> = { happy: "😊", tired: "😫", lazy: "😌", spicy: "🤤", healthy: "🌿" }
const homeMoodLabelMap: Record<string, string> = { happy: "开心", tired: "疲惫", lazy: "想偷懒", spicy: "想吃辣", healthy: "想养生" }

const todayStr = () => `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-${String(new Date().getDate()).padStart(2,"0")}`

const statusLabels = { planned: "计划", completed: "已吃", cancelled: "已取消" }

// 每次打开评价都是独立会话；关闭或切换后，旧上传/保存不能改动新的草稿。
type RatingSession = { target: string; photos: string[]; uploading: boolean; saving: boolean }
type DayRatingSession = RatingSession & { version: string; readToken: number }
type DayRatingConflict = { latest: DayRating | null; reason: "changed" | "unconfirmed" }

function isDayRatingConflict(error: unknown) {
  return typeof error === "object" && error !== null && "response" in error
    && typeof error.response === "object" && error.response !== null
    && "status" in error.response && error.response.status === 409
}

// 记录查询既有普通分页，也有日历数组和无限分页；只替换已在缓存中的该条记录。
function mergeSavedRecord(value: unknown, saved: MealRecord): unknown {
  if (Array.isArray(value)) return value.map((record: MealRecord) => record.id === saved.id ? { ...record, ...saved } : record)
  if (!value || typeof value !== "object") return value
  const data = value as { items?: MealRecord[]; records?: MealRecord[]; pages?: unknown[] }
  if (Array.isArray(data.items)) return { ...data, items: mergeSavedRecord(data.items, saved) }
  if (Array.isArray(data.records)) return { ...data, records: mergeSavedRecord(data.records, saved) }
  if (Array.isArray(data.pages)) return { ...data, pages: data.pages.map((page) => mergeSavedRecord(page, saved)) }
  return value
}

function HistoryRecordRow({ record, showDate = false, pending, onStatus, onRating, onReschedule, onInventory, onUndo }: {
  record: MealRecord
  showDate?: boolean
  pending: boolean
  onStatus: (record: MealRecord, status: MealRecord["status"]) => void
  onRating: (record: MealRecord) => void
  onReschedule: (record: MealRecord) => void
  onInventory: (record: MealRecord) => void
  onUndo: (record: MealRecord) => void
}) {
  const navigate = useNavigate()
  const completed = record.status === "completed"
  const canComplete = record.status === "planned" && record.meal_date <= todayStr()
  return (
    <div className="px-4 py-3 border-b border-border last:border-0">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(`/dishes/${record.dish_id}${completed ? "" : `?record_id=${record.id}`}`)}
          className="flex flex-1 min-w-0 items-center gap-3 text-left rounded-lg active:opacity-70"
        >
          <span className={`w-11 h-11 rounded-[10px] flex items-center justify-center text-xl flex-shrink-0 overflow-hidden ${record.meal_type === "lunch" ? "bg-primary-light" : "bg-mint-light"}`}>
            <SafeImage src={thumbUrl(record.dish_image_url)} alt="" className="w-full h-full object-cover" fallback={record.dish_emoji} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block text-sm font-semibold mb-0.5 ${record.status === "cancelled" ? "text-text3" : ""}`}>{record.dish_name}</span>
            <span className="block text-[11px] text-text2">
              {showDate ? `${record.meal_date} · ` : ""}{record.meal_type === "lunch" ? "午餐" : "晚餐"} · 原量 × {record.portion_scale || 1}
            </span>
            {record.status === "planned" && record.meal_date < todayStr() && <span className="block mt-1 text-[11px] text-primary">已过计划日期，仍待完成</span>}
            {completed && record.remark && <span className="block mt-1 text-[11px] text-text2 truncate">{record.remark}</span>}
          </span>
        </button>
        <span className={`flex-shrink-0 px-2 py-1 rounded-full text-[11px] font-medium ${completed ? "bg-mint-light text-mint" : record.status === "cancelled" ? "bg-bg text-text3" : "bg-primary-light text-primary"}`}>
          {statusLabels[record.status] || "计划"}
        </span>
        {completed && (
          <button
            onClick={() => onRating(record)}
            aria-label={`评价${record.dish_name}`}
            className="min-h-11 flex-shrink-0 flex items-center gap-1 px-2 rounded-full text-xs font-medium text-primary active:bg-primary-light"
          >
            {record.mood ? <span className="text-lg">{moodEmojiMap[record.mood]}</span> : "评价"}
            {record.rating > 0 && <span className="text-[11px] font-bold text-[#C8A23C]">★{record.rating}</span>}
          </button>
        )}
      </div>
      {!completed && (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {record.status === "cancelled" ? (
            <button disabled={pending} onClick={() => onStatus(record, "planned")} className="min-h-11 px-3 rounded-xl bg-bg text-text2 text-xs font-medium disabled:opacity-50 active:bg-primary-light">恢复计划</button>
          ) : (
            <>
              <button disabled={pending} onClick={() => onStatus(record, "cancelled")} className="min-h-11 px-3 rounded-xl text-text3 text-xs font-medium disabled:opacity-50 active:bg-bg">取消计划</button>
              <button disabled={pending} onClick={() => onReschedule(record)} className="min-h-11 px-3 rounded-xl bg-bg text-text2 text-xs font-medium disabled:opacity-50 active:bg-primary-light">改期</button>
              {canComplete && (
                <>
                  <button disabled={pending} onClick={() => navigate(`/dishes/${record.dish_id}/cook?record_id=${record.id}`)} className="min-h-11 px-3 rounded-xl bg-bg text-text2 text-xs font-medium disabled:opacity-50 active:bg-primary-light">开始做菜</button>
                  <button disabled={pending} onClick={() => onStatus(record, "completed")} className="min-h-11 px-3 rounded-xl bg-primary text-white text-xs font-semibold disabled:opacity-50 active:scale-95">标记已吃</button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {completed && (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button disabled={pending} onClick={() => onUndo(record)} className="min-h-11 px-3 rounded-xl text-text3 text-xs font-medium disabled:opacity-50 active:bg-bg">撤销已吃</button>
          <button disabled={pending} onClick={() => onInventory(record)} className="min-h-11 px-3 rounded-xl bg-bg text-text2 text-xs font-medium disabled:opacity-50 active:bg-primary-light">{record.inventory_applied ? "库存记录" : "补扣库存"}</button>
        </div>
      )}
    </div>
  )
}

function SwipeRowBg({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  return (
    <SwipeDeleteRow actionWidth={80} onDelete={onDelete} className="bg-red">
      {children}
    </SwipeDeleteRow>
  )
}

function SwipeRowCard({ children, onDelete }: { children: React.ReactNode; onDelete: () => void }) {
  return (
    <SwipeDeleteRow actionWidth={72} onDelete={onDelete} className={`rounded-2xl border border-border ${cardShadow}`}>
      {children}
    </SwipeDeleteRow>
  )
}

function UndoCompletionDialog({ record, pending, error, onClose, onConfirm }: {
  record: MealRecord
  pending: boolean
  error?: string
  onClose: () => void
  onConfirm: (entryId: number | null) => void
}) {
  const history = useQuery({
    queryKey: ["record-consumption", record.id],
    queryFn: () => recordsApi.consumption(record.id),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const activeEntry = history.data?.entries.find((entry) => entry.status === "applied")
  const fetched = history.isFetchedAfterMount && history.isSuccess && !history.isFetching
  const consistent = history.data?.applied === !!activeEntry
  const canConfirm = fetched && consistent && !pending

  return createPortal(
    <div className="fixed inset-0 z-[400] bg-black/45 backdrop-blur-sm flex items-end justify-center" onClick={() => !pending && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="undo-completion-title" className="bg-card w-full max-w-[640px] rounded-t-2xl p-5 max-h-[90dvh] overflow-y-auto animate-slide-in-up" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape" && !pending) onClose() }}>
        <h2 id="undo-completion-title" className="text-base font-bold">撤销「{record.dish_name}」已吃记录？</h2>
        <p className="mt-3 text-sm text-text2 leading-relaxed">这道菜会恢复为待完成计划，本条记录的评分、心情和成品照会清空。</p>
        {history.isError ? (
          <div className="mt-3">
            <p role="alert" className="text-sm text-red">读取最新库存记录失败，请重试后再确认。</p>
            <button disabled={history.isFetching || pending} onClick={() => void history.refetch()} className="min-h-11 px-3 rounded-xl text-sm text-primary disabled:opacity-50">重新读取库存记录</button>
          </div>
        ) : !fetched ? (
          <p role="status" className="mt-3 text-sm text-text3">正在确认这顿的最新库存扣减…</p>
        ) : !consistent ? (
          <div className="mt-3">
            <p role="alert" className="text-sm text-red">库存记录暂不一致，请刷新后再确认。</p>
            <button disabled={pending} onClick={() => void history.refetch()} className="min-h-11 px-3 rounded-xl text-sm text-primary disabled:opacity-50">重新读取库存记录</button>
          </div>
        ) : activeEntry ? (
          <div className="mt-3 rounded-xl bg-bg p-3">
            <p className="text-sm text-text2 leading-relaxed">同时撤销以下库存扣减。如果相关批次后来有变动，将保留当前状态并提示你处理。</p>
            <time dateTime={activeEntry.created_at} className="block mt-2 text-xs text-text3">{new Date(activeEntry.created_at).toLocaleString("zh-CN")}</time>
            <ul className="mt-2 space-y-1 text-xs text-text2">
              {activeEntry.items.map((item) => <li key={item.batch_id} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span>{item.item_name}</span><span>{item.removed ? "已用完" : item.after_quantity || "未记数量"} → {item.before_quantity || "恢复原批次"}</span></li>)}
            </ul>
          </div>
        ) : <p className="mt-3 text-sm text-text2 leading-relaxed">当前没有需要撤销的库存扣减，只恢复这条用餐计划。</p>}
        {error && <div className="mt-3">
          <p role="alert" className="text-sm text-red">{error}</p>
          <button disabled={pending || history.isFetching} onClick={() => void history.refetch()} className="min-h-11 px-3 rounded-xl text-sm text-primary disabled:opacity-50">重新读取库存记录</button>
        </div>}
        <div className="grid grid-cols-2 gap-3 mt-5 mb-3">
          <button autoFocus disabled={pending} onClick={onClose} className="min-h-11 rounded-xl bg-bg text-sm font-semibold disabled:opacity-50">保留记录</button>
          <button disabled={!canConfirm} onClick={() => { if (canConfirm) onConfirm(activeEntry?.id ?? null) }} className="min-h-11 rounded-xl bg-primary text-white text-sm font-semibold disabled:opacity-50">{pending ? "正在撤销…" : "确认撤销"}</button>
        </div>
      </div>
    </div>, document.body,
  )
}

export default function History() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const isAdminLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const [calYear, setCalYear] = useState(new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(new Date().getMonth())
  const [selectedDay, setSelectedDay] = useState<number | null>(new Date().getDate())
  const [view, setView] = useState<"calendar" | "pending">("calendar")
  const [rescheduleRecord, setRescheduleRecord] = useState<MealRecord | null>(null)
  const [inventoryRecord, setInventoryRecord] = useState<MealRecord | null>(null)
  const [undoRecord, setUndoRecord] = useState<MealRecord | null>(null)
  const [ratingRecord, setRatingRecord] = useState<MealRecord | null>(null)
  const [ratingMood, setRatingMood] = useState<string>("")
  // 1-5 星，0 = 未打分（报告的平均评分、菜品详情的评分趋势用它）
  const [ratingStars, setRatingStars] = useState(0)
  const [ratingRemark, setRatingRemark] = useState("")
  const [ratingPhoto, setRatingPhoto] = useState("")
  const ratingSession = useRef<RatingSession | null>(null)
  const [ratingUploading, setRatingUploading] = useState(false)
  const [ratingSaving, setRatingSaving] = useState(false)
  const [showMealRating, setShowMealRating] = useState(false)
  const [mealRatingDate, setMealRatingDate] = useState("")
  const [mealRatingMood, setMealRatingMood] = useState<string>("")
  const [mealRatingRemark, setMealRatingRemark] = useState("")
  const [mealPhotos, setMealPhotos] = useState<string[]>([])
  const mealSession = useRef<DayRatingSession | null>(null)
  const [mealUploadRemaining, setMealUploadRemaining] = useState(0)
  const [mealSaving, setMealSaving] = useState(false)
  const [mealReading, setMealReading] = useState(false)
  const [mealReady, setMealReady] = useState(false)
  const [mealReadError, setMealReadError] = useState("")
  const [mealConflict, setMealConflict] = useState<DayRatingConflict | null>(null)
  const [dayPhotoError, setDayPhotoError] = useState<{ date: string; message: string; ready: boolean } | null>(null)
  const [dayPhotoReading, setDayPhotoReading] = useState(false)
  const [viewerPhotos, setViewerPhotos] = useState<string[]>([])
  const [viewerIdx, setViewerIdx] = useState(0)
  const [showViewer, setShowViewer] = useState(false)
  const [consumption, setConsumption] = useState<{ dish: Dish; portionScale: number; recordId: number } | null>(null)

  // 主标签页会保留挂载；离开记录页时也要结束草稿，而不仅在组件卸载时清理。
  useEffect(() => () => {
    ratingSession.current = null
    mealSession.current = null
    setRatingRecord(null)
    setShowMealRating(false)
    setRatingUploading(false)
    setMealUploadRemaining(0)
    setRatingSaving(false)
    setMealSaving(false)
    setMealReading(false)
    setMealReady(false)
    setMealReadError("")
    setMealConflict(null)
  }, [location.pathname])

  function refreshMealQueries() {
    return Promise.all([
      ["records"], ["record"], ["stats"], ["report"], ["achievements"], ["favorites"],
      ["dish-records"], ["shopping-list"], ["photo-wall"], ["admin", "records"], ["admin", "dashboard"],
      ["fridge"], ["fridge-recipes"], ["fridge-urgent"], ["fridge-consumption"], ["record-consumption"],
    ].map((queryKey) => qc.invalidateQueries({ queryKey })))
  }

  // 写入状态存于 QueryClient，关闭弹窗甚至卸载页面都不会提前释放同一目标的锁。
  function ratingWritePending(kind: "record" | "day", target: string): boolean {
    return qc.getMutationCache().findAll({ mutationKey: ["history-rating", kind], status: "pending" }).some((mutation) => {
      const variables = mutation.state.variables as { session?: RatingSession; meal_date?: string } | undefined
      return (variables?.session?.target ?? variables?.meal_date) === target
    })
  }

  async function syncSavedRecord(saved: MealRecord) {
    await Promise.all(["records", "record", "dish-records"].map((key) => qc.cancelQueries({ queryKey: [key] })))
    qc.setQueryData<MealRecord>(["record", saved.id], (old) => ({ ...old, ...saved }))
    for (const key of ["records", "dish-records"]) {
      qc.setQueriesData({ queryKey: [key] }, (old: unknown) => mergeSavedRecord(old, saved))
    }
  }

  async function syncSavedDayRating(saved: DayRating) {
    await Promise.all([
      qc.cancelQueries({ queryKey: ["day-rating", saved.meal_date], exact: true }),
      qc.cancelQueries({ queryKey: ["day-ratings"] }),
    ])
    // 保留其他功能刚更新的字段（如首页心情），只同步本次请求拥有的字段。
    const merge = (old?: DayRating): DayRating => ({
      ...saved, ...old, photos: saved.photos, version: saved.version,
      mood: saved.mood, remark: saved.remark,
    })
    qc.setQueryData<DayRating>(["day-rating", saved.meal_date], merge)
    qc.setQueriesData<DayRating[]>({ queryKey: ["day-ratings"] }, (old) => old?.map((rating) => rating.meal_date === saved.meal_date ? merge(rating) : rating))
  }

  const statusMut = useMutation({
    mutationFn: ({ record, status }: { record: MealRecord; status: MealRecord["status"] }) =>
      recordsApi.update(record.id, { status }),
    onSuccess: async (saved, { record, status }) => {
      toast.success(status === "completed" ? "已记为吃过" : status === "cancelled" ? "已取消计划，购物清单已同步" : "已恢复计划")
      const refreshing = refreshMealQueries()
      if (status === "completed") {
        try {
          const dish = await qc.fetchQuery({ queryKey: ["dish", record.dish_id], queryFn: () => dishesApi.get(record.dish_id) })
          setConsumption({ dish, portionScale: saved.portion_scale || record.portion_scale || 1, recordId: saved.id })
        } catch {
          toast.error("已记为吃过，暂时无法读取菜谱用量，可稍后点击补扣库存")
        }
      }
      await refreshing
    },
    onError: (err) => toast.error(getUploadErrorMessage(err, "更新计划失败，请稍后重试")),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => recordsApi.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["records"] })
      const prev = qc.getQueryData(["records"])
      qc.setQueryData(["records"], (old: unknown) => {
        if (!old || typeof old !== "object" || old === null) return old
        const o = old as { items?: MealRecord[] }
        if (!o.items) return old
        return { ...o, items: o.items.filter((r) => r.id !== id) }
      })
      return { prev }
    },
    onSuccess: () => {
      void refreshMealQueries()
      toast.success("已删除")
    },
    onError: (err, _id, context) => {
      if (context?.prev) qc.setQueryData(["records"], context.prev)
      toast.error(getUploadErrorMessage(err, "删除失败"))
    },
  })

  const rescheduleMut = useMutation({
    mutationFn: ({ record, meal_date, meal_type }: { record: MealRecord; meal_date: string; meal_type: string }) =>
      recordsApi.update(record.id, { meal_date, meal_type }),
    onSuccess: async () => {
      setRescheduleRecord(null)
      toast.success("计划已改期，份量和购物状态已保留")
      await refreshMealQueries()
    },
  })

  const undoMut = useMutation({
    mutationFn: ({ record, entryId }: { record: MealRecord; entryId: number | null }) => recordsApi.undoCompletion(record.id, entryId),
    onSuccess: async (_, { entryId }) => {
      setUndoRecord(null)
      toast.success(entryId !== null ? "已恢复为计划，库存扣减已撤销" : "已恢复为待完成计划")
      await refreshMealQueries()
    },
  })

  const supplementMut = useMutation({
    mutationFn: async (record: MealRecord) => {
      const [current, dish] = await Promise.all([
        recordsApi.get(record.id),
        qc.fetchQuery({ queryKey: ["dish", record.dish_id], queryFn: () => dishesApi.get(record.dish_id) }),
      ])
      if (current.status !== "completed") throw new Error("这条记录已不再是已吃状态，请刷新后重试")
      if (current.inventory_applied) throw new Error("这顿已经扣过库存，可在库存记录中查看")
      return { dish, portionScale: current.portion_scale || 1, recordId: current.id }
    },
    onSuccess: (next) => {
      setInventoryRecord(null)
      setConsumption(next)
    },
    onError: (err) => toast.error(getUploadErrorMessage(err, "读取库存用量失败，请稍后重试")),
  })

  function requestDelete(record: MealRecord) {
    if (recordActionPending) return
    if (record.inventory_applied) {
      toast.error("请先在库存记录中撤销扣减，再删除这条记录")
      setInventoryRecord(record)
      return
    }
    deleteMut.mutate(record.id)
  }

  function openReschedule(record: MealRecord) {
    rescheduleMut.reset()
    setRescheduleRecord(record)
  }

  function openUndo(record: MealRecord) {
    undoMut.reset()
    setUndoRecord(record)
  }

  const updateMut = useMutation({
    mutationKey: ["history-rating", "record"],
    scope: { id: "history-record-rating" },
    mutationFn: ({ id, data }: { id: number; data: Partial<MealRecord>; session: RatingSession }) => recordsApi.update(id, data),
    onSuccess: async (saved, { session }) => {
      await syncSavedRecord(saved)
      void refreshMealQueries()
      if (ratingSession.current !== session) return
      toast.success("评价已保存")
      closeRating()
    },
    onError: (_err, { session }) => {
      if (ratingSession.current === session) toast.error("评价失败，请重试")
    },
    onSettled: (_data, _err, { session }) => {
      session.saving = false
      if (ratingSession.current === session) setRatingSaving(false)
    },
  })

  const dayRatingMut = useMutation({
    mutationKey: ["history-rating", "day"],
    scope: { id: "history-day-rating" },
    mutationFn: ({ data }: { data: { meal_date: string; expected_version: string; mood: string; remark: string; photos: string }; session: DayRatingSession }) =>
      dayRatingApi.create(data),
    onSuccess: async (saved, { session }) => {
      await syncSavedDayRating(saved)
      qc.invalidateQueries({ queryKey: ["day-rating"] })
      qc.invalidateQueries({ queryKey: ["day-ratings"] })
      qc.invalidateQueries({ queryKey: ["photo-wall"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      if (mealSession.current !== session) return
      toast.success("今日评价已保存")
      closeMealRating()
    },
    onError: async (error, { session }) => {
      if (mealSession.current !== session) return
      setMealConflict({ latest: null, reason: isDayRatingConflict(error) ? "changed" : "unconfirmed" })
      await readMealRating(session, false)
      if (mealSession.current === session) toast.error("评价未确认，草稿已保留，请核对后继续")
    },
    onSettled: (_data, _err, { session }) => {
      session.saving = false
      if (mealSession.current === session) setMealSaving(false)
    },
  })

  const updateDayPhotosMut = useMutation({
    mutationKey: ["history-rating", "day"],
    mutationFn: (data: { meal_date: string; expected_version: string; photos: string }) =>
      dayRatingApi.create(data),
    onMutate: async (data) => {
      const key = ["day-rating", data.meal_date]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<DayRating>(key)
      qc.setQueryData(key, (old: unknown) => {
        if (!old || typeof old !== "object" || old === null) return old
        const r = old as DayRating
        return { ...r, photos: data.photos }
      })
      return { prev, key }
    },
    onSuccess: async (saved, data) => {
      await syncSavedDayRating(saved)
      qc.invalidateQueries({ queryKey: ["day-rating", data.meal_date] })
      qc.invalidateQueries({ queryKey: ["day-ratings"] })
      qc.invalidateQueries({ queryKey: ["photo-wall"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      setDayPhotoError(current => current?.date === data.meal_date ? null : current)
      toast.success("照片已删除")
    },
    onError: (error, data, context) => {
      if (context?.prev) qc.setQueryData<DayRating>(context.key, (current) =>
        current?.photos === data.photos ? { ...current, photos: context.prev!.photos } : current,
      )
      const message = isDayRatingConflict(error) ? "照片已变化，已保留最新内容，请重新确认要删除的照片" : "照片删除未确认，请重新读取后再操作"
      setDayPhotoError({ date: data.meal_date, message, ready: false })
      toast.error(message)
    },
    // 失败也重新核对服务端（包括已保存但响应丢失），核对完才释放同日写锁。
    onSettled: async (_saved, _err, data) => {
      try {
        const latest = await dayRatingApi.getFresh(data.meal_date)
        await syncSavedDayRating(latest)
        setDayPhotoError(current => current?.date === data.meal_date ? { ...current, message: "照片已更新，请重新确认要删除的照片", ready: true } : current)
      } catch {
        setDayPhotoError({ date: data.meal_date, message: "最新照片读取失败，重新读取成功后再删除", ready: false })
      }
    },
  })

  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => statsApi.get() })
  const { data: recordsData } = useQuery({
    queryKey: ["records"],
    queryFn: () => recordsApi.list({ pageSize: "100" }),
  })
  const pendingQuery = useInfiniteQuery({
    queryKey: ["records", "pending"],
    queryFn: ({ pageParam }) => recordsApi.list({ status: "planned", page: String(pageParam), pageSize: "20" }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) => pages.length * 20 < lastPage.total ? pages.length + 1 : undefined,
    enabled: view === "pending",
  })
  const pendingRecords = pendingQuery.data?.pages.flatMap((page) => page.items || []) || []
  const recordActionPending = statusMut.isPending || rescheduleMut.isPending || undoMut.isPending || supplementMut.isPending || deleteMut.isPending

  const rowActions = {
    pending: recordActionPending,
    onStatus: (record: MealRecord, status: MealRecord["status"]) => statusMut.mutate({ record, status }),
    onRating: openRating,
    onReschedule: openReschedule,
    onInventory: setInventoryRecord,
    onUndo: openUndo,
  }

  const selectedDateKey = selectedDay !== null ? `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}` : ""
  const selectedIsFuture = selectedDateKey > todayStr()
  const monthStartKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-01`
  const monthEndKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(new Date(calYear, calMonth + 1, 0).getDate()).padStart(2, "0")}`

  const { data: dayRatingData } = useQuery({
    queryKey: ["day-rating", selectedDateKey],
    queryFn: () => dayRatingApi.get(selectedDateKey),
    enabled: !!selectedDateKey,
  })
  const dayRating = (dayRatingData as DayRating | null) || null

  const { data: dayRatings = [] } = useQuery({
    queryKey: ["day-ratings", calYear, calMonth],
    queryFn: () => dayRatingApi.list({ date_from: monthStartKey, date_to: monthEndKey }),
  })

  const { data: monthRecords, isPending: monthPending, isError: monthError, refetch: refetchMonth } = useQuery({
    queryKey: ["records", "calendar", monthStartKey, monthEndKey],
    queryFn: async () => {
      const params = { date_from: monthStartKey, date_to: monthEndKey, pageSize: "100" }
      const first = await recordsApi.list(params)
      const remainingPages = Math.max(0, Math.ceil(first.total / 100) - 1)
      const rest = await Promise.all(Array.from({ length: remainingPages }, (_, i) => recordsApi.list({ ...params, page: String(i + 2) })))
      return [first, ...rest].flatMap((page) => page.items || [])
    },
  })

  const records = useMemo(() => recordsData?.items || [], [recordsData])

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

  function openRating(r: MealRecord) {
    if (r.status !== "completed") return
    if (ratingWritePending("record", String(r.id))) {
      toast("这条评价正在保存，请稍后再打开")
      return
    }
    // 即使缓存通知尚未触发列表重绘，也以刚保存的实际响应初始化。
    r = qc.getQueryData<MealRecord>(["record", r.id]) || r
    ratingSession.current = { target: String(r.id), photos: r.photo ? [r.photo] : [], uploading: false, saving: false }
    setRatingUploading(false)
    setRatingSaving(false)
    setRatingRecord(r)
    setRatingMood(r.mood || "")
    setRatingStars(r.rating || 0)
    setRatingRemark(r.remark || "")
    setRatingPhoto(r.photo || "")
  }

  function closeRating() {
    ratingSession.current = null
    setRatingRecord(null)
    setRatingUploading(false)
    setRatingSaving(false)
  }

  function submitRating() {
    const session = ratingSession.current
    if (!ratingRecord || !ratingMood || !session || session.target !== String(ratingRecord.id) || session.uploading || session.saving || ratingWritePending("record", session.target)) return
    session.saving = true
    setRatingSaving(true)
    updateMut.mutate({
      id: ratingRecord.id,
      session,
      data: { mood: ratingMood, rating: ratingStars, remark: ratingRemark, photo: session.photos[0] || "" },
    })
  }

  function handleRatingPhotoUpload() {
    const session = ratingSession.current
    if (!session || session.uploading || session.saving) return
    if (!isAdminLoggedIn) {
      toast.error("上传照片需要先进入管理模式")
      navigate("/admin/login")
      return
    }
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/jpg,image/jpeg,image/png,image/webp"
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file || ratingSession.current !== session || session.uploading || session.saving) return
      session.uploading = true
      setRatingUploading(true)
      try {
        const res = await uploadApi.image(file)
        if (ratingSession.current !== session) return
        const url = res.data.data.url
        if (url) {
          session.photos = [url]
          setRatingPhoto(url)
        }
        else toast.error("上传返回异常")
      } catch (err) {
        if (ratingSession.current === session) toast.error(getUploadErrorMessage(err))
      } finally {
        session.uploading = false
        if (ratingSession.current === session) setRatingUploading(false)
      }
    }
    input.click()
  }

  function removeRatingPhoto() {
    const session = ratingSession.current
    if (!session || session.uploading || session.saving) return
    session.photos = []
    setRatingPhoto("")
  }

  function parsePhotos(photosStr: string): string[] {
    try {
      const arr = JSON.parse(photosStr)
      return Array.isArray(arr) ? arr.filter((photo): photo is string => typeof photo === "string" && photo !== "") : []
    } catch {
      return []
    }
  }

  function openMealRating() {
    if (!canRateSelectedDay) return
    if (ratingWritePending("day", selectedDateKey)) {
      toast("这天的评价或照片正在保存，请稍后再打开")
      return
    }
    const session: DayRatingSession = { target: selectedDateKey, photos: [], version: "", readToken: 0, uploading: false, saving: false }
    mealSession.current = session
    setMealRatingDate(selectedDateKey)
    setMealUploadRemaining(0)
    setMealSaving(false)
    setMealConflict(null)
    setMealReady(false)
    setMealRatingMood("")
    setMealRatingRemark("")
    setMealPhotos([])
    setShowMealRating(true)
    void readMealRating(session, true)
  }

  async function readMealRating(session: DayRatingSession, initialize: boolean) {
    const token = ++session.readToken
    setMealReading(true)
    setMealReadError("")
    try {
      const latest = await dayRatingApi.getFresh(session.target)
      if (!latest || latest.meal_date !== session.target || latest.version?.length !== 64) throw new Error("评价数据不完整，请刷新后重试")
      if (mealSession.current !== session || session.readToken !== token) return
      if (initialize) {
        session.version = latest.version
        session.photos = parsePhotos(latest.photos)
        setMealRatingMood(latest.mood || "")
        setMealRatingRemark(latest.remark || "")
        setMealPhotos(session.photos)
        setMealReady(true)
      } else {
        setMealConflict(current => current ? { ...current, latest } : null)
      }
    } catch (error) {
      if (mealSession.current === session && session.readToken === token) {
        setMealReadError(getUploadErrorMessage(error, "最新评价读取失败，请重试"))
      }
    } finally {
      if (mealSession.current === session && session.readToken === token) setMealReading(false)
    }
  }

  function resolveMealConflict(keepDraft: boolean) {
    const session = mealSession.current
    const latest = mealConflict?.latest
    if (!session || !latest || mealReading || session.saving) return
    session.version = latest.version
    if (!keepDraft) {
      session.photos = parsePhotos(latest.photos)
      setMealRatingMood(latest.mood || "")
      setMealRatingRemark(latest.remark || "")
      setMealPhotos(session.photos)
    }
    setMealConflict(null)
    setMealReadError("")
    toast(keepDraft ? "已核对最新内容，请检查草稿后再保存" : "已载入最新评价")
  }

  function closeMealRating() {
    mealSession.current = null
    setShowMealRating(false)
    setMealPhotos([])
    setMealUploadRemaining(0)
    setMealSaving(false)
    setMealReading(false)
    setMealReady(false)
    setMealReadError("")
    setMealConflict(null)
  }

  function submitMealRating() {
    const session = mealSession.current
    if (!mealRatingMood || !session || !session.version || mealReading || mealReadError || mealConflict || session.uploading || session.saving || ratingWritePending("day", session.target)) return
    session.saving = true
    setMealSaving(true)
    dayRatingMut.mutate({
      session,
      data: {
        meal_date: session.target,
        expected_version: session.version,
        mood: mealRatingMood,
        remark: mealRatingRemark,
        photos: JSON.stringify(session.photos),
      },
    })
  }

  function handlePhotoUpload() {
    const session = mealSession.current
    if (!session || !session.version || mealReading || mealReadError || mealConflict || session.uploading || session.saving) return
    if (!isAdminLoggedIn) {
      toast.error("上传照片需要先进入管理模式")
      navigate("/admin/login")
      return
    }

    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.accept = "image/jpg,image/jpeg,image/png,image/webp"
    input.onchange = async () => {
      const files = Array.from(input.files || [])
      if (files.length === 0 || mealSession.current !== session || session.uploading || session.saving) return
      const remaining = 9 - session.photos.length
      if (remaining <= 0) {
        toast.error("最多上传9张照片")
        return
      }
      const toUpload = files.slice(0, remaining)
      if (files.length > remaining) {
        toast.error(`已选${files.length}张，仅上传前${remaining}张`)
      }
      // 同一草稿一次只处理一批文件；同步占用上传状态，避免连点绕过 9 张限制。
      session.uploading = true
      setMealUploadRemaining(toUpload.length)
      let failed = 0
      let lastErrMsg = ""
      try {
        for (const [index, file] of toUpload.entries()) {
          if (mealSession.current !== session) return
          try {
            const res = await uploadApi.image(file)
            if (mealSession.current !== session) return
            const url = res.data.data.url
            if (url) {
              session.photos = [...session.photos, url]
              setMealPhotos(session.photos)
            } else {
              failed++
            }
          } catch (err) {
            if (mealSession.current !== session) return
            failed++
            lastErrMsg = getUploadErrorMessage(err)
          }
          setMealUploadRemaining(toUpload.length - index - 1)
        }
        if (failed > 0) toast.error(lastErrMsg || `${failed}张上传失败`)
      } finally {
        session.uploading = false
        if (mealSession.current === session) setMealUploadRemaining(0)
      }
    }
    input.click()
  }

  function removeMealPhoto(idx: number) {
    const session = mealSession.current
    if (!session || session.saving || mealReading || mealReadError || mealConflict) return
    session.photos = session.photos.filter((_, i) => i !== idx)
    setMealPhotos(session.photos)
  }

  function removeDayPhoto(idx: number, displayed: DayRating) {
    if (dayPhotoReading || (dayPhotoError?.date === selectedDateKey && !dayPhotoError.ready)) return
    if (ratingWritePending("day", selectedDateKey)) {
      toast("这天的评价或照片正在保存，请稍后再试")
      return
    }
    if (!isAdminLoggedIn) {
      toast.error("删除照片需要先进入管理模式")
      navigate("/admin/login")
      return
    }
    if (!displayed.version) {
      setDayPhotoError({ date: selectedDateKey, message: "请先重新读取照片，再确认要删除的照片", ready: false })
      return
    }
    // 用用户实际看到的照片列表及其版本；缓存更新早于重绘时也不能删错另一张。
    const dayPhotos = parsePhotos(displayed.photos)
    if (idx < 0 || idx >= dayPhotos.length) return
    const updated = dayPhotos.filter((_, i) => i !== idx)
    updateDayPhotosMut.mutate({
      meal_date: selectedDateKey,
      expected_version: displayed.version,
      photos: JSON.stringify(updated),
    })
  }

  async function reloadDayPhotos() {
    const date = selectedDateKey
    if (dayPhotoReading || ratingWritePending("day", date)) return
    setDayPhotoReading(true)
    try {
      const latest = await dayRatingApi.getFresh(date)
      await syncSavedDayRating(latest)
      setDayPhotoError(current => current?.date === date ? { date, message: "照片已更新，请重新确认要删除的照片", ready: true } : current)
    } catch {
      setDayPhotoError({ date, message: "最新照片读取失败，请重试", ready: false })
    } finally {
      setDayPhotoReading(false)
    }
  }

  function openViewer(photos: string[], idx: number) {
    setViewerPhotos(photos)
    setViewerIdx(idx)
    setShowViewer(true)
  }

  function closeViewer() {
    setShowViewer(false)
  }

  function buildCalendar() {
    const firstDay = new Date(calYear, calMonth, 1).getDay()
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
    const prevDays = new Date(calYear, calMonth, 0).getDate()
    const today = new Date()
    const cells: { day: number; isCurrentMonth: boolean; isToday: boolean; dateKey: string }[] = []

    for (let i = firstDay - 1; i >= 0; i--) {
      const d = prevDays - i
      const pm = calMonth === 0 ? 11 : calMonth - 1
      const py = calMonth === 0 ? calYear - 1 : calYear
      cells.push({ day: d, isCurrentMonth: false, isToday: false, dateKey: `${py}-${String(pm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = calYear === today.getFullYear() && calMonth === today.getMonth() && d === today.getDate()
      cells.push({ day: d, isCurrentMonth: true, isToday, dateKey: `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` })
    }
    const remaining = (7 - (firstDay + daysInMonth) % 7) % 7
    for (let i = 1; i <= remaining; i++) {
      const nm = calMonth === 11 ? 0 : calMonth + 1
      const ny = calMonth === 11 ? calYear + 1 : calYear
      cells.push({ day: i, isCurrentMonth: false, isToday: false, dateKey: `${ny}-${String(nm + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}` })
    }
    return cells
  }

  const calCells = buildCalendar()
  const selectedRecords = selectedDay !== null ? (recordByDate.get(selectedDateKey) || []) : []
  const selectedCompletedRecords = selectedRecords.filter((r) => r.status === "completed")
  const canRateSelectedDay = !selectedIsFuture && selectedCompletedRecords.length > 0
  const completedMealTypes = new Set(selectedCompletedRecords.map((r) => r.meal_type))

  function changeMonth(dir: number) {
    let m = calMonth + dir
    let y = calYear
    if (m > 11) { m = 0; y++ }
    if (m < 0) { m = 11; y-- }
    setCalMonth(m)
    setCalYear(y)
    setSelectedDay(null)
  }

  const topDish = stats?.top_dishes?.[0]

  return (
    <div className="animate-fadeUp">
      <PageHeader
        title="记录"
        subtitle="安排做菜计划，吃过后再记下感受"
        icon={CalendarDays}
        actions={
          <HeaderIconButton onClick={() => navigate("/report")} aria-label="饮食报告">
            <span className="text-base leading-none">📊</span>
          </HeaderIconButton>
        }
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto">
        <div className="grid grid-cols-2 gap-1 p-1 mb-4 rounded-2xl bg-bg border border-border" role="group" aria-label="记录视图">
          <button onClick={() => setView("calendar")} aria-pressed={view === "calendar"} className={`min-h-11 rounded-xl text-sm font-semibold transition-colors ${view === "calendar" ? "bg-card text-primary shadow-sm" : "text-text2"}`}>日历记录</button>
          <button onClick={() => setView("pending")} aria-pressed={view === "pending"} className={`min-h-11 rounded-xl text-sm font-semibold transition-colors ${view === "pending" ? "bg-card text-primary shadow-sm" : "text-text2"}`}>待完成</button>
        </div>
        {view === "pending" ? (
          <div>
            <div className="mb-4 text-[13px] text-text2">过去没做的和未来安排的计划都在这里，可直接改期或取消。</div>
            {pendingQuery.isPending ? (
              <div className="py-8 text-center text-sm text-text3" role="status">正在读取待完成计划…</div>
            ) : pendingQuery.isError && !pendingQuery.data ? (
              <button onClick={() => void pendingQuery.refetch()} className="w-full min-h-11 px-4 py-3 text-sm text-primary">计划读取失败，点此重试</button>
            ) : pendingRecords.length === 0 ? (
              <div className="py-12 text-center bg-card rounded-2xl border border-border">
                <span className="block text-4xl mb-3">🍽</span>
                <div className="text-base font-semibold">没有待完成的计划</div>
                <div className="mt-1 text-[13px] text-text2">安排好想吃的菜后，会显示在这里。</div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <div className="text-xs text-text3">共 {pendingQuery.data?.pages[0].total || pendingRecords.length} 道待完成</div>
                {pendingRecords.map((record) => (
                  <SwipeRowCard key={record.id} onDelete={() => requestDelete(record)}>
                    <HistoryRecordRow record={record} showDate {...rowActions} />
                  </SwipeRowCard>
                ))}
                {pendingQuery.hasNextPage && <button disabled={pendingQuery.isFetching || recordActionPending} onClick={() => { if (!pendingQuery.isFetching && !recordActionPending) void pendingQuery.fetchNextPage() }} className="min-h-11 mt-2 rounded-xl bg-card border border-border text-sm text-primary disabled:opacity-50">{pendingQuery.isFetching ? "正在读取…" : pendingQuery.isFetchNextPageError ? "读取失败，重试" : "加载更多计划"}</button>}
              </div>
            )}
          </div>
        ) : (
          <>
        <div className={`bg-card rounded-2xl p-3.5 mb-5 ${cardShadow} border border-border`}>
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-base font-bold">{calYear} 年 {calMonth + 1} 月</div>
            <div className="flex gap-2">
              <button onClick={() => changeMonth(-1)} className="w-7 h-7 rounded-full bg-bg flex items-center justify-center text-sm transition-all active:bg-primary-light">←</button>
              <button onClick={() => changeMonth(1)} className="w-7 h-7 rounded-full bg-bg flex items-center justify-center text-sm transition-all active:bg-primary-light">→</button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {weekdays.map((w) => <div key={w} className="text-[11px] text-text3 font-semibold py-0.5">{w}</div>)}
            {calCells.map((cell, i) => {
              const recs = recordByDate.get(cell.dateKey) || []
              const hasLunch = recs.some((r) => r.status === "completed" && r.meal_type === "lunch")
              const hasDinner = recs.some((r) => r.status === "completed" && r.meal_type === "dinner")
              const hasPlan = recs.some((r) => r.status === "planned")
              const isSelected = cell.isCurrentMonth && selectedDay === cell.day
              const homeMood = cell.isCurrentMonth ? dayRatingByDate.get(cell.dateKey)?.home_mood : ""
              const homeMoodEmoji = homeMood ? homeMoodEmojiMap[homeMood] : ""
              return (
                <button
                  key={i}
                  onClick={() => cell.isCurrentMonth && setSelectedDay(cell.day)}
                  aria-label={`${cell.dateKey}${hasLunch || hasDinner ? " 已吃" : ""}${hasPlan ? " 有计划" : ""}`}
                  className={`h-8 flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-all relative ${!cell.isCurrentMonth ? "text-text4" : ""} ${cell.isToday ? "font-bold text-primary" : ""} ${isSelected ? "bg-primary text-white font-bold" : "active:bg-primary-light"}`}
                >
                  {cell.day}
                  {(hasLunch || hasDinner || hasPlan) && (
                    <span className={`absolute bottom-0.5 h-1 w-1 rounded-full ${hasLunch || hasDinner ? isSelected ? "bg-white" : hasLunch ? "bg-primary" : "bg-mint" : isSelected ? "border border-white" : "border border-primary"}`} />
                  )}
                  {homeMoodEmoji && <span className="absolute -top-0.5 right-0 text-[10px] leading-none">{homeMoodEmoji}</span>}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex justify-end gap-3 text-[11px] text-text3"><span>● 已吃</span><span>○ 计划</span></div>
        </div>

        {selectedDay !== null && (
          <div className={`bg-card rounded-2xl overflow-hidden mb-5 ${cardShadow} border border-border animate-pop-soft`}>
            <div className="px-4 py-3 bg-primary-light text-sm font-semibold text-primary flex items-center justify-between">
              <div className="flex items-center gap-1.5 flex-wrap">
                {calMonth + 1}月{selectedDay}日
                {selectedDateKey === todayStr() && <span className="text-[11px] font-medium bg-primary text-white px-1.5 py-px rounded-full">今天</span>}
                {dayRating?.home_mood && (
                  <span className="text-[11px] font-medium bg-white/80 text-primary px-1.5 py-px rounded-full">
                    {homeMoodEmojiMap[dayRating.home_mood] || "😃"} {homeMoodLabelMap[dayRating.home_mood] || "心情"}
                  </span>
                )}
              </div>
              {canRateSelectedDay ? (
                <button
                  onClick={openMealRating}
                  className={`min-h-11 px-2.5 rounded-full text-[11px] font-semibold transition-all active:scale-95 ${dayRating?.mood ? "bg-mint text-white" : "bg-primary text-white"}`}
                >
                  {dayRating?.mood ? "✓ 已评价" : "😌 评价"}
                </button>
              ) : selectedRecords.some((r) => r.status === "planned") ? (
                <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white/80 text-text2">待完成</span>
              ) : null}
            </div>
            {monthPending ? (
              <div className="py-5 px-4 text-center text-[13px] text-text3">正在读取记录…</div>
            ) : monthError ? (
              <button onClick={() => void refetchMonth()} className="w-full min-h-11 px-4 py-3 text-[13px] text-primary">记录读取失败，点此重试</button>
            ) : selectedRecords.length === 0 ? (
              <div className="py-5 px-4 text-center text-[13px] text-text3">
                {selectedDateKey === todayStr() ? "今天还没有记录哦~" : selectedIsFuture ? "这天还没有安排" : "这天没有记录"}
              </div>
            ) : (
              selectedRecords.map((r) => (
                <SwipeRowBg key={r.id} onDelete={() => requestDelete(r)}>
                  <HistoryRecordRow record={r} {...rowActions} />
                </SwipeRowBg>
              ))
            )}
            {dayRating?.mood && canRateSelectedDay && (
              <div className="px-4 py-2.5 bg-bg border-t border-border flex items-center gap-2.5 text-[13px]">
                <span className="text-xl">🍚</span>
                <span className="flex-1 text-text2">
                  {completedMealTypes.size > 1 ? "午餐+晚餐" : completedMealTypes.has("lunch") ? "午餐" : "晚餐"} · 整体评价
                  {dayRating.remark && <span className="ml-1 text-text"> {dayRating.remark}</span>}
                </span>
                <span className="text-xl">{moodEmojiMap[dayRating.mood] || "😋"}</span>
              </div>
            )}
            {dayPhotoError?.date === selectedDateKey && (
              <div role="alert" className="border-t border-border px-4 py-3 text-sm text-text2">
                <p>{dayPhotoError.message}</p>
                {!dayPhotoError.ready && <button disabled={dayPhotoReading || updateDayPhotosMut.isPending} onClick={() => void reloadDayPhotos()} className="mt-2 min-h-11 rounded-full bg-bg px-4 font-semibold text-primary disabled:opacity-50">{dayPhotoReading ? "正在读取照片…" : "重新读取照片"}</button>}
              </div>
            )}
            {(() => {
              const dayPhotos = dayRating?.photos ? parsePhotos(dayRating.photos) : []
              const hasPhotos = dayPhotos.length > 0
              // 只有计划或已取消的日子不提示评价；已上传的照片仍可查看。
              if (!hasPhotos && !canRateSelectedDay) return null
              return (
                <div className="px-4 py-2.5 border-t border-border">
                  <div className="text-[11px] text-text3 mb-1.5">{hasPhotos ? `📷 照片 (${dayPhotos.length})` : "📷 拍张照记录一下？"}</div>
                  <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-1 scroll-fade-x">
                    {dayPhotos.map((p, i) => (
                       <div
                         key={i}
                         className="w-14 h-14 rounded-md overflow-hidden flex-shrink-0 bg-bg border border-border flex items-center justify-center cursor-pointer transition-all active:scale-95 relative"
                         onClick={() => openViewer(dayPhotos, i)}
                       >
                          <img src={thumbUrl(p)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                          {isAdminLoggedIn && (
                            <button
                             onClick={(e) => { e.stopPropagation(); if (dayRating) removeDayPhoto(i, dayRating) }}
                             aria-label={`删除第 ${i + 1} 张照片`}
                             disabled={dayPhotoReading || (dayPhotoError?.date === selectedDateKey && !dayPhotoError.ready) || (updateDayPhotosMut.isPending && updateDayPhotosMut.variables.meal_date === selectedDateKey)}
                             className="absolute top-0 right-0 w-[22px] h-[22px] rounded-bl-md bg-black/50 text-white text-xs flex items-center justify-center active:bg-red disabled:opacity-50"
                           >✕</button>
                         )}
                       </div>
                     ))}
                    {canRateSelectedDay && <button
                      onClick={openMealRating}
                      className="w-14 h-14 rounded-md flex-shrink-0 border-2 border-dashed border-border2 flex flex-col items-center justify-center cursor-pointer transition-all active:border-primary active:text-primary text-text3"
                    >
                      <span className="text-base leading-none">+</span>
                      <span className="text-[11px]">添加</span>
                    </button>}
                  </div>
                </div>
              )
            })()}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mb-5">
          <StatCard value={stats?.total_records || 0} label="累计做饭" color="primary" />
          <StatCard value={topDish?.dish_name || "-"} label="最常吃的菜" color="mint" small />
          <StatCard value={stats?.lunch_count || 0} label="午餐次数" color="pink" />
          <StatCard value={stats?.dinner_count || 0} label="晚餐次数" color="yellow" />
        </div>

        <SectionHeader title="最近记录" />
        <div className="flex flex-col gap-2.5">
          {records.slice(0, 5).map((r) => (
            <SwipeRowCard key={r.id} onDelete={() => requestDelete(r)}>
              <HistoryRecordRow record={r} showDate {...rowActions} />
            </SwipeRowCard>
          ))}
          {records.length === 0 && (
            <div className="text-center py-12">
              <span className="text-[56px] block mb-4 animate-float">📅</span>
              <div className="text-base font-semibold mb-1.5">还没有记录</div>
              <div className="text-[13px] text-text2">去首页推荐一道菜吧~</div>
            </div>
          )}
        </div>
          </>
        )}
      </div>

      <ConsumeInventorySheet dish={consumption?.dish || null} portionScale={consumption?.portionScale || 1} recordId={consumption?.recordId || 0} onClose={() => setConsumption(null)} />
      <InventoryHistorySheet record={inventoryRecord} onClose={() => setInventoryRecord(null)} onSupplement={(record) => { if (!supplementMut.isPending) supplementMut.mutate(record) }} />
      {rescheduleRecord && <ReschedulePlanSheet key={rescheduleRecord.id} record={rescheduleRecord} pending={rescheduleMut.isPending} error={rescheduleMut.isError ? getUploadErrorMessage(rescheduleMut.error, "改期失败，请稍后重试") : undefined} onClose={() => setRescheduleRecord(null)} onSubmit={(data) => rescheduleMut.mutate({ record: rescheduleRecord, ...data })} />}
      {undoRecord && <UndoCompletionDialog key={undoRecord.id} record={undoRecord} pending={undoMut.isPending} error={undoMut.isError ? getUploadErrorMessage(undoMut.error, "撤销失败，请稍后重试") : undefined} onClose={() => setUndoRecord(null)} onConfirm={(entryId) => undoMut.mutate({ record: undoRecord, entryId })} />}

      {ratingRecord && createPortal(
        <div className="fixed inset-0 z-[400] bg-black/45 backdrop-blur-sm flex items-end justify-center" onClick={closeRating}>
          <div role="dialog" aria-modal="true" aria-label={`${ratingRecord.dish_name}评价`} className="bg-card w-full max-w-[640px] rounded-t-2xl animate-slide-in-up" onClick={(e) => e.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeRating() }}>
            <div className="w-9 h-1 rounded-full bg-border2 mx-auto mt-2" />
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="text-base font-bold">{ratingRecord.dish_name} — 这道菜怎么样？</div>
              <button onClick={closeRating} aria-label="关闭菜品评价" className="w-7 h-7 rounded-full flex items-center justify-center text-text3 hover:bg-bg text-sm">✕</button>
            </div>
            <div className="p-5">
              <div className="flex justify-center gap-4 mb-5">
                {moodOptions.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setRatingMood(m.key)}
                    disabled={ratingSaving}
                    className={`flex flex-col items-center gap-1.5 p-3 px-5 rounded-2xl border-2 transition-all active:scale-90 ${ratingMood === m.key ? "border-primary bg-primary-light" : "border-transparent bg-bg"}`}
                  >
                    <span className="text-3xl">{m.emoji}</span>
                    <span className={`text-xs font-medium ${ratingMood === m.key ? "text-primary" : "text-text2"}`}>{m.label}</span>
                  </button>
                ))}
              </div>
              <div className="mb-5">
                <div className="text-xs text-text2 font-semibold mb-2">打分（可选，再点一次取消）</div>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-label={`${s} 星`}
                      disabled={ratingSaving}
                      onClick={() => setRatingStars((cur) => (cur === s ? 0 : s))}
                      className="w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90"
                    >
                      <Star size={24} className={s <= ratingStars ? "text-yellow fill-yellow" : "text-text4"} />
                    </button>
                  ))}
                  {ratingStars > 0 && <span className="ml-1 text-xs font-semibold text-text2">{ratingStars} 分</span>}
                </div>
              </div>
              <div className="mb-5">
                <div className="text-xs text-text2 font-semibold mb-2">备注（可选）</div>
                <textarea
                  value={ratingRemark}
                  disabled={ratingSaving}
                  onChange={(e) => setRatingRemark(e.target.value)}
                  placeholder="这道菜怎么样..."
                  rows={2}
                  className="w-full p-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm resize-none focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                />
              </div>
              <div className="mb-5">
                <div className="text-xs text-text2 font-semibold mb-2">📷 成品照（可选，限1张）</div>
                {ratingPhoto ? (
                  <div className="relative w-20 h-20 rounded-[10px] overflow-hidden border border-border">
                    <img src={ratingPhoto} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={removeRatingPhoto}
                      aria-label="移除成品照"
                      disabled={ratingSaving}
                      className="absolute top-0.5 right-0.5 w-6 h-6 rounded-full bg-black/50 text-white text-xs flex items-center justify-center"
                    >✕</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="上传成品照"
                    onClick={handleRatingPhotoUpload}
                    disabled={ratingUploading || ratingSaving}
                    className={`w-20 h-20 rounded-[10px] border-2 border-dashed border-border2 flex flex-col items-center justify-center cursor-pointer transition-all active:border-primary active:text-primary disabled:opacity-50 ${isAdminLoggedIn ? "text-text3" : "text-text4 bg-bg/60"}`}
                  >
                    <span className="text-xl leading-none">+</span>
                    <span className="text-[11px]" role="status">{ratingUploading ? "上传中…" : "添加"}</span>
                  </button>
                )}
              </div>
              <button
                onClick={submitRating}
                disabled={!ratingMood || ratingUploading || ratingSaving}
                className="w-full py-3 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-40 disabled:active:scale-100"
              >{ratingUploading ? "照片上传中…" : ratingSaving ? "正在保存…" : "保存评价"}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showMealRating && createPortal(
        <div className="fixed inset-0 z-[400] bg-black/45 backdrop-blur-sm flex items-end justify-center" onClick={closeMealRating}>
          <div role="dialog" aria-modal="true" aria-label="整体用餐评价" className="bg-card w-full max-w-[640px] max-h-[90dvh] overflow-y-auto rounded-t-2xl animate-slide-in-up" onClick={(e) => e.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeMealRating() }}>
            <div className="w-9 h-1 rounded-full bg-border2 mx-auto mt-2" />
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="text-base font-bold">🍲 这顿饭怎么样？</div>
              <button onClick={closeMealRating} aria-label="关闭整体评价" className="w-7 h-7 rounded-full flex items-center justify-center text-text3 hover:bg-bg text-sm">✕</button>
            </div>
            <div className="p-5">
              <div className="text-center mb-3 text-[13px] text-text2">评价 {mealRatingDate} 的整体用餐感受</div>
              {mealReading && <p role="status" className="mb-4 text-center text-sm text-text3">正在读取最新评价…</p>}
              {mealReadError && <div role="alert" className="mb-4 rounded-xl border border-border bg-bg p-3 text-sm text-text2">
                <p>{mealReadError}</p>
                <button disabled={mealReading} onClick={() => { const session = mealSession.current; if (session) void readMealRating(session, !session.version) }} className="mt-2 min-h-11 rounded-full bg-card px-4 font-semibold text-primary disabled:opacity-50">重新读取评价</button>
              </div>}
              {mealConflict && <section role="alert" className="mb-4 rounded-xl border border-yellow/40 bg-yellow-light p-3 text-sm text-text2">
                <p className="font-semibold text-text">{mealConflict.reason === "changed" ? "评价或照片已变化，草稿已保留" : "保存结果未确认，草稿已保留"}</p>
                <p className="mt-1">请核对最新内容，再决定继续编辑草稿或载入最新评价。</p>
                {mealConflict.latest && <>
                  <p className="mt-2">最新评价：{mealMoodOptions.find(option => option.key === mealConflict.latest!.mood)?.label || "未评价"}</p>
                  <p className="mt-1 break-words">最新备注：{mealConflict.latest.remark || "未填写"}</p>
                  <p className="mt-1">最新照片：{parsePhotos(mealConflict.latest.photos).length} 张</p>
                  <div className="mt-2 flex flex-wrap gap-2">{parsePhotos(mealConflict.latest.photos).map((photo, index) => <img key={`${photo}-${index}`} src={thumbUrl(photo)} alt={`最新照片 ${index + 1}`} className="h-12 w-12 rounded-md object-cover" />)}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button disabled={mealSaving || mealReading} onClick={() => resolveMealConflict(true)} className="min-h-11 rounded-full bg-primary px-4 font-semibold text-white disabled:opacity-50">保留草稿继续编辑</button>
                    <button disabled={mealSaving || mealReading} onClick={() => resolveMealConflict(false)} className="min-h-11 rounded-full border border-border bg-card px-4 font-semibold disabled:opacity-50">载入最新评价</button>
                  </div>
                </>}
              </section>}
              {mealReady && <fieldset disabled={mealSaving || mealReading || !!mealReadError || !!mealConflict} className="min-w-0">
              <div className="flex justify-center gap-4 mb-5">
                {mealMoodOptions.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setMealRatingMood(m.key)}
                    disabled={mealSaving}
                    className={`flex flex-col items-center gap-1.5 p-3 px-5 rounded-2xl border-2 transition-all active:scale-90 ${mealRatingMood === m.key ? "border-primary bg-primary-light" : "border-transparent bg-bg"}`}
                  >
                    <span className="text-3xl">{m.emoji}</span>
                    <span className={`text-xs font-medium ${mealRatingMood === m.key ? "text-primary" : "text-text2"}`}>{m.label}</span>
                  </button>
                ))}
              </div>
              <div className="mb-5">
                <div className="text-xs text-text2 font-semibold mb-2">备注（可选）</div>
                <textarea
                  value={mealRatingRemark}
                  disabled={mealSaving}
                  onChange={(e) => setMealRatingRemark(e.target.value)}
                  placeholder="今天这顿饭的整体感受..."
                  rows={2}
                  className="w-full p-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm resize-none focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition-all"
                />
              </div>
              <div className="mb-5">
                <div className="text-xs text-text2 font-semibold mb-2">📷 上传照片（可选，最多9张）</div>
                <div className="flex gap-2 items-start">
                  <button
                    type="button"
                    aria-label="上传用餐照片"
                    onClick={handlePhotoUpload}
                    disabled={mealUploadRemaining > 0 || mealSaving || mealPhotos.length >= 9}
                    className={`w-16 h-16 rounded-[10px] border-2 border-dashed border-border2 flex flex-col items-center justify-center cursor-pointer transition-all active:border-primary active:text-primary flex-shrink-0 disabled:opacity-50 ${isAdminLoggedIn ? "text-text3" : "text-text4 bg-bg/60"}`}
                  >
                    <span className="text-xl leading-none">+</span>
                    <span className="text-[11px]" role="status">{mealUploadRemaining > 0 ? "上传中…" : "添加"}</span>
                  </button>
                  <div className="flex gap-2 flex-wrap">
                    {mealPhotos.map((p, i) => (
                       <div key={i} className="w-16 h-16 rounded-[10px] overflow-hidden relative bg-bg flex items-center justify-center border border-border">
                          <img src={thumbUrl(p)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
                          <button
                            onClick={(e) => { e.stopPropagation(); removeMealPhoto(i) }}
                            aria-label={`移除第 ${i + 1} 张用餐照片`}
                            disabled={mealSaving}
                            className="absolute top-0.5 right-0.5 w-6 h-6 rounded-full bg-black/50 text-white text-xs flex items-center justify-center active:bg-red"
                         >✕</button>
                       </div>
                     ))}
                  </div>
                </div>
              </div>
              <button
                onClick={submitMealRating}
                disabled={!mealRatingMood || mealUploadRemaining > 0 || mealSaving || mealReading || !!mealReadError || !!mealConflict}
                className="w-full py-3 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-40 disabled:active:scale-100"
              >{mealConflict ? "核对最新评价后继续" : mealUploadRemaining > 0 ? `照片上传中，还剩 ${mealUploadRemaining} 张…` : mealSaving ? "正在保存…" : "保存评价"}</button>
              </fieldset>}
            </div>
          </div>
        </div>,
        document.body
      )}

      {showViewer && viewerPhotos.length > 0 && createPortal(
        <PhotoViewer photos={viewerPhotos} idx={viewerIdx} setIdx={setViewerIdx} onClose={closeViewer} />,
        document.body
      )}
    </div>
  )
}
