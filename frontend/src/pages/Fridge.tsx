import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { isAxiosError } from "axios"
import { fridgeApi, shoppingListApi } from "@/api"
import { getUploadErrorMessage } from "@/api/client"
import PageHeader from "@/components/PageHeader"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import DishImage from "@/components/DishImage"
import { cardShadow } from "@/components/Card"
import type { FridgeMatch, InventoryBatch } from "@/types"
import { fridgeDaysLeft, matchesFridgeFilter, parseFridgeFilter, searchFridge, type FridgeFilter } from "@/lib/fridgeFilters"
import { Search, X } from "lucide-react"
import toast from "react-hot-toast"

const QUICK_ITEMS = ["鸡蛋", "番茄", "土豆", "青椒", "洋葱", "豆腐", "猪肉", "鸡翅", "虾仁", "白菜", "面条", "玉米"]

function todayStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// expiryBadge 保质期徽章：level 用于逻辑判断（urgent=临期/过期），cls 只管样式
function expiryBadge(expiry: string, today: string): { text: string; cls: string; level: "expired" | "urgent" | "soon" | "ok" } | null {
  const left = fridgeDaysLeft(expiry, today)
  if (left === null) return null
  if (left < 0) return { text: `已过期 ${-left} 天`, cls: "bg-red-light text-red", level: "expired" }
  if (left === 0) return { text: "今天到期", cls: "bg-red-light text-red", level: "urgent" }
  if (left <= 2) return { text: `${left} 天后到期`, cls: "bg-red-light text-red", level: "urgent" }
  if (left <= 4) return { text: `${left} 天后到期`, cls: "bg-yellow-light text-[#C8A23C]", level: "soon" }
  return { text: `${left} 天`, cls: "bg-bg text-text3", level: "ok" }
}

function coverageTone(coverage: number) {
  if (coverage >= 80) return { bg: "bg-mint-light", text: "text-mint", bar: "bg-mint" }
  if (coverage >= 50) return { bg: "bg-primary-light", text: "text-primary", bar: "bg-primary" }
  return { bg: "bg-yellow-light", text: "text-[#C8A23C]", bar: "bg-yellow" }
}

function MatchCard({ match, onClick, onAddMissing, addingMissing }: { match: FridgeMatch; onClick: () => void; onAddMissing?: () => void; addingMissing?: boolean }) {
  const tone = coverageTone(match.coverage)
  // 后端字段可能为 null，统一兜底成数组
  const matched = match.matched || []
  const missing = match.missing || []
  const urgent = match.using_urgent || []
  // 写冰箱里的真实名字：冰箱里是五花肉、菜谱写瘦肉 → "五花肉（当瘦肉用）"
  const haveText = match.have
    ? match.have.map((h) => (h.substitute ? `${h.stock}（当${h.recipe}用）` : h.stock)).join("、")
    : matched.join("、")
  // 只有 100% 才叫"可以做"，其余是部分匹配，不夸大
  const badgeText = match.coverage === 100 ? "可以做" : `匹配 ${match.coverage}%`
  return (
    <div
      onClick={onClick}
      className={`bg-card rounded-2xl border border-border ${cardShadow} p-3 flex gap-3 cursor-pointer transition-all active:scale-98`}
    >
      <DishImage dish={match.dish} className="w-[72px] h-[72px] rounded-xl overflow-hidden flex-shrink-0 bg-gradient-to-br from-primary-light to-pink-light" emojiSize="text-[30px]" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[15px] font-bold truncate">{match.dish.name}</span>
          <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${tone.bg} ${tone.text}`}>
            {badgeText}
          </span>
          {urgent.length > 0 && (
            <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-light text-red">
              清临期
            </span>
          )}
        </div>
        <div className="h-1.5 rounded-full bg-bg overflow-hidden mb-1.5">
          <div className={`h-full rounded-full ${tone.bar} transition-all`} style={{ width: `${match.coverage}%` }} />
        </div>
        <div className="text-[11px] leading-relaxed text-text2 flex items-center gap-1.5">
          <span className="min-w-0 truncate">
            <span className="text-mint font-medium">有 {haveText}</span>
            {missing.length > 0 && (
              <span className="text-text3"> · 缺 {missing.slice(0, 3).join("、")}{missing.length > 3 ? "…" : ""}</span>
            )}
          </span>
          {missing.length > 0 && onAddMissing && (
            <button
              type="button"
              disabled={addingMissing}
              onClick={(e) => { e.stopPropagation(); onAddMissing() }}
              className="relative after:absolute after:-inset-2 flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold bg-yellow-light text-[#C8A23C] transition-all active:scale-95 disabled:opacity-50"
            >
              🛒 补料
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const EXPIRY_PRESETS = [
  { label: "3 天", days: 3 },
  { label: "1 周", days: 7 },
  { label: "2 周", days: 14 },
  { label: "1 个月", days: 30 },
]

export default function Fridge() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get("q") || ""
  const filter = parseFridgeFilter(searchParams.get("filter"))
  const [today, setToday] = useState(() => todayStr())
  const qc = useQueryClient()
  const [input, setInput] = useState("")
  const [quantityInput, setQuantityInput] = useState("")
  const draftRevision = useRef(0)
  const addInFlight = useRef(false)
  const batchWriteInFlight = useRef(false)
  // 编辑某一批次：数量 + 保质期
  const [editing, setEditing] = useState<InventoryBatch | null>(null)
  const [editQuantity, setEditQuantity] = useState("")
  const [editDate, setEditDate] = useState("")
  const [editConflict, setEditConflict] = useState(false)
  // undefined 尚未读取，null 表示最新库存中已没有这批。
  const [latestBatch, setLatestBatch] = useState<InventoryBatch | null | undefined>(undefined)
  const [batchRefreshing, setBatchRefreshing] = useState(false)
  const editSession = useRef(0)

  useEffect(() => {
    const checkDate = () => setToday(todayStr())
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 50)
    const timer = window.setTimeout(checkDate, midnight.getTime() - Date.now())
    window.addEventListener("focus", checkDate)
    document.addEventListener("visibilitychange", checkDate)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", checkDate)
      document.removeEventListener("visibilitychange", checkDate)
    }
  }, [today])

  function updateSearch(value: string) {
    setSearchParams((params) => {
      const next = new URLSearchParams(params)
      if (value) next.set("q", value)
      else next.delete("q")
      return next
    }, { replace: true })
  }

  function updateFilter(value: FridgeFilter) {
    setSearchParams((params) => {
      const next = new URLSearchParams(params)
      if (value === "all") next.delete("filter")
      else next.set("filter", value)
      return next
    }, { replace: true })
  }

  function resetFilters() {
    setSearchParams((params) => {
      const next = new URLSearchParams(params)
      next.delete("q")
      next.delete("filter")
      return next
    }, { replace: true })
  }

  const { data: items = [], isPending: itemsLoading, isError: itemsError, isFetching: itemsFetching, refetch: reloadItems } = useQuery({ queryKey: ["fridge"], queryFn: () => fridgeApi.list() })
  const { data: matches, isPending: matchesLoading, isError: matchesError, isFetching: matchesFetching, refetch: reloadMatches } = useQuery({
    queryKey: ["fridge-recipes"],
    queryFn: () => fridgeApi.recipes(20),
    enabled: items.length > 0,
  })

  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["fridge"] }),
    qc.invalidateQueries({ queryKey: ["fridge-recipes"] }),
    // 首页临期提醒条用的缓存也要失效，否则返回首页会显示旧提醒
    qc.invalidateQueries({ queryKey: ["fridge-urgent"] }),
  ])

  const addMut = useMutation({
    mutationFn: (p: { name: string; quantity?: string; expiry?: string }) => fridgeApi.add(p.name, p.quantity, p.expiry),
    onSuccess: async () => { await invalidate(); toast.success("🧊 已放入冰箱") },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "添加失败"),
    onSettled: () => { addInFlight.current = false },
  })
  // 批次编辑（数量/保质期）与"新放入"分开提示
  const batchMut = useMutation({
    retry: false,
    mutationFn: (p: { id: number; quantity: string; expiry: string; original: InventoryBatch }) => fridgeApi.updateBatch(p.id, p.quantity, p.expiry, {
      batch_id: p.original.id, quantity: p.original.quantity, updated_at: p.original.updated_at,
    }),
    onSuccess: async (_, saved) => {
      await invalidate()
      setEditing((current) => current?.id === saved.id ? null : current)
      toast.success("📅 批次已更新")
    },
    onError: (err: unknown) => {
      if (isAxiosError(err) && err.response?.status === 409) {
        setEditConflict(true)
        setLatestBatch(undefined)
      }
      toast.error(getUploadErrorMessage(err, "保存失败"))
    },
    onSettled: () => { batchWriteInFlight.current = false },
  })
  const removeBatchMut = useMutation({
    mutationFn: (id: number) => fridgeApi.removeBatch(id),
    onSuccess: async (_, id) => {
      await invalidate()
      setEditing((current) => current?.id === id ? null : current)
      toast.success("已移出冰箱")
    },
    onError: () => toast.error("移出失败，稍后再试"),
    onSettled: () => { batchWriteInFlight.current = false },
  })
  // 一键清理已过期批次（批量接口单次最多 100 批，分段提交）
  const clearExpiredMut = useMutation({
    mutationFn: async (ids: number[]) => {
      let removed = 0
      let skipped = 0
      try {
        for (let i = 0; i < ids.length; i += 100) {
          const result = await fridgeApi.clearExpired(ids.slice(i, i + 100))
          removed += result.removed
          skipped += result.skipped
        }
      } catch (err) {
        throw new Error(`${removed > 0 ? `已清理 ${removed} 批，其余` : ""}${getUploadErrorMessage(err, "清理失败，请重试")}`, { cause: err })
      }
      return { removed, skipped }
    },
    onSuccess: async ({ removed, skipped }) => {
      await invalidate()
      toast.success(`已清理 ${removed} 批过期食材${skipped > 0 ? `，${skipped} 批已变动或不再过期，已跳过` : ""}`)
    },
    onError: async (err: unknown) => { await invalidate(); toast.error(getUploadErrorMessage(err, "清理未完成，请检查库存后重试")) },
    onSettled: () => { batchWriteInFlight.current = false },
  })
  const batchBusy = batchMut.isPending || removeBatchMut.isPending || clearExpiredMut.isPending || batchRefreshing

  // 缺料一键补入买菜清单（今天去买，做今天的菜）
  const addMissingMut = useMutation({
    mutationFn: (p: { dish_id: number; dish_name: string; missing: string[] }) =>
      shoppingListApi.addItems({
        dish_id: p.dish_id,
        dish_name: p.dish_name,
        items: p.missing.map((name) => ({ name })),
      }),
    onSuccess: ({ added }) => {
      toast.success(added > 0 ? `🛒 已加入买菜清单 ${added} 项` : "买菜清单里已经有了")
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
    },
    onError: () => toast.error("加入失败，稍后再试"),
  })

  const matchingNames = useMemo(() => searchFridge(items, search), [items, search])
  const visibleItems = useMemo(() => matchingNames.filter((item) => matchesFridgeFilter(item, filter, today)), [matchingNames, filter, today])
  const filterCounts = {
    all: matchingNames.length,
    soon: matchingNames.filter((item) => matchesFridgeFilter(item, "soon", today)).length,
    expired: matchingNames.filter((item) => matchesFridgeFilter(item, "expired", today)).length,
  }
  // 先筛批次再分组：同一食材的新鲜批次不混进临期或过期结果。
  const groups = useMemo(() => {
    const m = new Map<string, InventoryBatch[]>()
    for (const b of visibleItems) {
      const arr = m.get(b.item_name) || []
      arr.push(b)
      m.set(b.item_name, arr)
    }
    return [...m.entries()]
  }, [visibleItems])

  const stocked = useMemo(() => new Set(items.map((i) => i.item_name)), [items])
  const quickLeft = QUICK_ITEMS.filter((n) => !stocked.has(n))
  const soonCount = items.filter((item) => matchesFridgeFilter(item, "soon", today)).length
  const expiredCount = items.filter((item) => matchesFridgeFilter(item, "expired", today)).length
  const expiredIds = visibleItems.filter((item) => matchesFridgeFilter(item, "expired", today)).map((item) => item.id)
  const hasFilters = search.trim() !== "" || filter !== "all"

  function handleAdd(raw: string, fromForm = false) {
    const name = raw.trim()
    if (!name || addInFlight.current) return
    const submittedRevision = draftRevision.current
    addInFlight.current = true
    // 同食材再添加 = 追加一个新批次（如今天又买了一袋）
    addMut.mutate({ name, quantity: quantityInput.trim() }, {
      onSuccess: () => {
        // 保存过程中可以继续准备下一项；旧请求成功不能清掉新草稿。
        if (draftRevision.current !== submittedRevision) return
        if (fromForm) setInput("")
        setQuantityInput("")
      },
    })
  }

  function openBatchEditor(batch: InventoryBatch) {
    if (batchWriteInFlight.current) return
    editSession.current++
    setEditing(batch)
    setEditQuantity(batch.quantity || "")
    setEditDate(batch.expiry_date || "")
    setEditConflict(false)
    setLatestBatch(undefined)
  }

  function saveBatch() {
    if (!editing || editConflict || batchWriteInFlight.current) return
    batchWriteInFlight.current = true
    batchMut.mutate({ id: editing.id, quantity: editQuantity, expiry: editDate, original: editing })
  }

  async function readLatestBatch() {
    if (!editing || batchWriteInFlight.current) return
    const id = editing.id
    const session = editSession.current
    batchWriteInFlight.current = true
    setBatchRefreshing(true)
    try {
      const fresh = await fridgeApi.list()
      qc.setQueryData(["fridge"], fresh)
      if (session === editSession.current) setLatestBatch(fresh.find((batch) => batch.id === id) ?? null)
    } catch (err) {
      toast.error(getUploadErrorMessage(err, "读取最新库存失败，请重试"))
    } finally {
      batchWriteInFlight.current = false
      setBatchRefreshing(false)
    }
  }

  function useLatestBatch() {
    if (!latestBatch || batchWriteInFlight.current) return
    // 用户明确选择重新编辑后才替换草稿，不自动重试旧写入。
    openBatchEditor(latestBatch)
  }

  function removeBatch(id: number) {
    if (batchWriteInFlight.current) return
    batchWriteInFlight.current = true
    removeBatchMut.mutate(id)
  }

  function clearExpired() {
    if (batchWriteInFlight.current || expiredIds.length === 0 || !confirm(`确定把当前${hasFilters ? "筛选" : "列表"}中的 ${expiredIds.length} 批过期食材移出冰箱吗？`)) return
    batchWriteInFlight.current = true
    clearExpiredMut.mutate(expiredIds)
  }

  return (
    <div className="animate-fadeUp">
      <PageHeader
        title="冰箱库存"
        subtitle="记下家里有什么，帮你清冰箱"
        onBack={() => navigate(-1)}
        meta={expiredCount + soonCount > 0 ? [expiredCount > 0 ? `${expiredCount} 批过期` : "", soonCount > 0 ? `${soonCount} 批临期` : ""].filter(Boolean).join(" · ") : items.length > 0 ? `${items.length} 批` : undefined}
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto pb-24">
        {/* 添加食材：同食材再添加 = 追加新批次 */}
        <form onSubmit={(e) => { e.preventDefault(); handleAdd(input, true) }} className="flex gap-2 mb-2.5">
          <input
            value={input}
            onChange={(e) => { draftRevision.current++; setInput(e.target.value) }}
            placeholder="冰箱里有什么？如：鸡蛋、番茄…"
            className="min-w-0 flex-1 h-11 rounded-2xl border-[1.5px] border-border bg-card px-4 text-sm font-medium outline-none transition-all focus:border-primary focus:shadow-[0_0_0_3px_rgba(232,115,74,.12)]"
          />
          <button
            type="submit"
            disabled={!input.trim() || addMut.isPending}
            className="h-11 px-5 rounded-2xl bg-primary text-white text-sm font-bold transition-all active:scale-95 disabled:opacity-50"
          >
            {addMut.isPending ? "放入中…" : "放入"}
          </button>
        </form>
        <input
          value={quantityInput}
          onChange={(e) => { draftRevision.current++; setQuantityInput(e.target.value) }}
          placeholder="数量（可选），如：3个、半袋"
          className="w-full h-9 mb-3 rounded-xl border border-border bg-bg px-3.5 text-xs text-text2 outline-none transition-all focus:border-primary"
        />

        {/* 快速添加 */}
        {quickLeft.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2.5 mb-4 scrollbar-none scroll-fade-x">
            {quickLeft.map((name) => (
              <button
                key={name}
                type="button"
                disabled={addMut.isPending}
                onClick={() => handleAdd(name)}
                className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-card border border-border text-text2 transition-all active:scale-95 hover:border-primary/30 hover:text-primary"
              >
                + {name}
              </button>
            ))}
          </div>
        )}

        {(items.length > 0 || hasFilters) && (
          <section aria-label="筛选冰箱库存" className="mb-4">
            <div className="relative mb-2.5">
              <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text3" />
              <input
                type="search"
                aria-label="搜索库存食材"
                placeholder="搜索库存食材"
                value={search}
                onChange={(event) => updateSearch(event.target.value)}
                className="w-full h-11 rounded-xl border border-border bg-card pl-10 pr-11 text-sm outline-none transition-all focus:border-primary [&::-webkit-search-cancel-button]:appearance-none"
              />
              {search && <button type="button" aria-label="清空库存搜索" onClick={() => updateSearch("")} className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-text3 active:text-text"><X size={16} /></button>}
            </div>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="按保质期筛选">
              {([{ key: "all", label: "全部" }, { key: "soon", label: "临期" }, { key: "expired", label: "已过期" }] as const).map(({ key, label }) => (
                <button key={key} type="button" onClick={() => updateFilter(key)} aria-pressed={filter === key}
                  className={`min-h-11 rounded-xl border text-[13px] font-semibold transition-all active:scale-95 ${filter === key ? "border-primary/30 bg-primary-light text-primary" : "border-border bg-card text-text2"}`}
                >{label} <span className="ml-1 text-xs tabular-nums">{filterCounts[key]}</span></button>
              ))}
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 mt-2 text-[11px] text-text2">
              <span role="status" aria-live="polite">{groups.length} 种食材 · {visibleItems.length} 批</span>
              <span>临期：今天至 2 天后到期</span>
            </div>
          </section>
        )}

        {expiredIds.length > 0 && (
          <div className="flex items-center justify-between gap-3 mb-3 px-3.5 py-2.5 rounded-2xl bg-red-light text-red">
            <span className="text-xs font-semibold">{hasFilters ? "当前结果" : "有"} {expiredIds.length} 批食材已过期</span>
            <button
              type="button"
              disabled={batchBusy}
              onClick={clearExpired}
              className="flex-shrink-0 px-3 py-1 rounded-full text-xs font-bold bg-red text-white transition-all active:scale-95 disabled:opacity-50"
            >
              清理这 {expiredIds.length} 批
            </button>
          </div>
        )}

        {/* 已有食材（按食材分组，组内批次） */}
        {itemsError && (
          <div role="alert" className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center mb-6`}>
            <div className="text-sm font-bold mb-1">{items.length > 0 ? "库存暂时无法更新" : "库存加载失败"}</div>
            <div className="text-xs text-text2">{items.length > 0 ? "下方保留上次读取的库存，可以重试更新。" : "请检查网络后重试，已有库存不会丢失。"}</div>
            <button type="button" disabled={itemsFetching} onClick={() => { void reloadItems() }} className="text-sm font-bold text-primary mt-3 disabled:opacity-50">
              {itemsFetching ? "正在重试…" : "重新加载"}
            </button>
          </div>
        )}
        {itemsLoading ? (
          <div role="status" className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center mb-6`}>
            <div className="text-sm text-text3">正在读取冰箱库存…</div>
          </div>
        ) : groups.length > 0 ? (
          <div aria-label="库存批次" className="flex flex-col gap-2.5 mb-6">
            {groups.map(([name, batches]) => {
              const hasUrgent = batches.some((b) => {
                const l = fridgeDaysLeft(b.expiry_date, today)
                return l !== null && l <= 2
              })
              return (
                <div
                  key={name}
                  className={`bg-card rounded-2xl border ${cardShadow} p-3.5 ${hasUrgent ? "border-red/20" : "border-border"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[15px] font-bold ${hasUrgent ? "text-red" : ""}`}>{name}</span>
                    {batches.length > 1 && (
                      <span className="text-[11px] font-semibold text-text3 bg-bg px-2 py-0.5 rounded-full">{batches.length} 批</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {batches.map((b) => {
                      const badge = expiryBadge(b.expiry_date, today)
                      return (
                        <div
                          key={b.id}
                          onClick={() => openBatchEditor(b)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm cursor-pointer transition-all active:scale-[.98] ${
                            badge?.level === "expired" || badge?.level === "urgent"
                              ? "bg-red-light/60 border-red/20 text-red"
                              : "bg-bg border-border text-text"
                          }`}
                        >
                          {b.quantity && <span className="font-semibold">{b.quantity}</span>}
                          {badge ? (
                            <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-bold ${badge.cls}`}>{badge.text}</span>
                          ) : <span className="text-[11px] text-text3">未设保质期</span>}
                          <button
                            type="button"
                            disabled={batchBusy}
                            aria-label={`移出${name}该批`}
                            onClick={(e) => { e.stopPropagation(); removeBatch(b.id) }}
                            // 透明 ::after 撑大点击区；删除不用确认，向左只扩一点，点行内其他地方仍是编辑
                            className="relative after:absolute after:-inset-y-2 after:-right-3 after:-left-1 ml-auto w-5 h-5 rounded-full flex items-center justify-center opacity-50 hover:bg-black/5 hover:opacity-100 transition-all active:scale-90 text-base leading-none"
                          >
                            ×
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        ) : !itemsError && items.length > 0 ? (
          <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center mb-6`}>
            <div className="text-[15px] font-bold mb-1">{search.trim() ? "没有符合条件的库存" : filter === "soon" ? "没有临期食材" : "没有已过期食材"}</div>
            <div className="text-xs text-text2">{search.trim() ? "换个名字试试，或清除筛选查看全部。" : "可以查看全部库存，继续安排做饭。"}</div>
            <button type="button" onClick={resetFilters} className="mt-3 min-h-10 px-4 text-sm font-semibold text-primary">查看全部库存</button>
          </div>
        ) : !itemsError ? (
          <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center mb-6`}>
            <div className="text-[40px] mb-2">🧊</div>
            <div className="text-[15px] font-bold mb-1">冰箱还是空的</div>
            <div className="text-xs text-text2 leading-relaxed">
              把现有食材记进来，马上告诉你能做什么菜。<br />
              买菜清单里点「家中有」也会自动记进来。
            </div>
          </div>
        ) : null}

        {/* 清冰箱推荐 */}
        {items.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-bold">🍳 清冰箱推荐</div>
              <span className="text-[11px] text-text3">临期批次会优先用掉</span>
            </div>
            {hasFilters && <div className="-mt-1 mb-3 text-xs text-text2">推荐基于全部可用库存</div>}
            {matchesError && (
              <div role="alert" className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center mb-3`}>
                <div className="text-sm font-bold mb-1">清冰箱推荐加载失败</div>
                <div className="text-xs text-text2">请检查网络后重试。</div>
                <button type="button" disabled={matchesFetching} onClick={() => { void reloadMatches() }} className="text-sm font-bold text-primary mt-3 disabled:opacity-50">
                  {matchesFetching ? "正在重试…" : "重新加载推荐"}
                </button>
              </div>
            )}
            {matchesLoading ? (
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center`}>
                <div className="text-sm text-text3">正在看你的冰箱…</div>
              </div>
            ) : matches && matches.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                {matches.map((m) => (
                  <MatchCard
                    key={m.dish.id}
                    match={m}
                    onClick={() => navigate(`/dishes/${m.dish.id}`)}
                    onAddMissing={() => addMissingMut.mutate({ dish_id: m.dish.id, dish_name: m.dish.name, missing: m.missing || [] })}
                    addingMissing={addMissingMut.isPending}
                  />
                ))}
              </div>
            ) : !matchesError ? (
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center`}>
                <div className="text-[32px] mb-2">🤔</div>
                <div className="text-sm font-bold mb-1">这些食材还凑不成一道菜</div>
                <div className="text-xs text-text2">再加一两种，或者去菜品页逛逛找找灵感</div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 批次编辑弹层 */}
      {editing && (
        <AnimatedBottomSheet onClose={() => { editSession.current++; setEditing(null) }} className="rounded-t-3xl p-5 max-h-[90dvh] overflow-y-auto">
          <div className="text-lg font-extrabold mb-0.5">{editing.item_name}</div>
          <div className="text-xs text-text3 mb-4">编辑这一批的数量和保质期</div>
          {editConflict && (
            <div role="alert" className="mb-4 rounded-xl border border-border bg-bg p-3 text-sm">
              <div className="font-bold">库存已变动，尚未保存</div>
              <p className="mt-1 text-xs text-text2">你的修改已保留。先读取最新库存，核对后再重新编辑。</p>
              {latestBatch === undefined ? (
                <button type="button" disabled={batchBusy} onClick={() => { void readLatestBatch() }} className="mt-2 min-h-10 text-sm font-bold text-primary disabled:opacity-50">
                  {batchRefreshing ? "读取中…" : "读取最新库存"}
                </button>
              ) : latestBatch === null ? (
                <p className="mt-2 text-xs text-text2">这批食材已被移出冰箱，不能再保存。</p>
              ) : (
                <>
                  <p className="mt-2 text-xs text-text2">最新数量：{latestBatch.quantity || "未填写"} · 到期日：{latestBatch.expiry_date || "未设置"}</p>
                  <button type="button" disabled={batchBusy} onClick={useLatestBatch} className="mt-2 min-h-10 text-sm font-bold text-primary disabled:opacity-50">用最新库存重新编辑</button>
                </>
              )}
            </div>
          )}
          <input
            value={editQuantity}
            disabled={batchBusy}
            onChange={(e) => setEditQuantity(e.target.value)}
            placeholder="数量（可选），如：3个、半袋"
            className="w-full h-10 mb-3 rounded-xl border-[1.5px] border-border bg-bg px-3.5 text-sm outline-none transition-all focus:border-primary"
          />
          <div className="grid grid-cols-4 gap-2 mb-3">
            {EXPIRY_PRESETS.map((p) => {
              const val = todayStr(p.days)
              const active = editDate === val
              return (
                <button
                  key={p.days}
                  type="button"
                  disabled={batchBusy}
                  onClick={() => setEditDate(val)}
                  className={`py-2.5 rounded-xl text-[13px] font-bold border-[1.5px] transition-all active:scale-95 ${active ? "border-primary bg-primary-light text-primary" : "border-border text-text2"}`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-text3 mb-4">
            或选具体日期
            <input
              type="date"
              disabled={batchBusy}
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="flex-1 h-9 rounded-xl border border-border bg-bg px-2.5 text-sm text-text font-medium outline-none focus:border-primary"
            />
          </label>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => removeBatch(editing.id)}
              disabled={batchBusy || editConflict}
              className="py-2.5 px-4 rounded-full text-sm font-semibold bg-red-light text-red active:scale-96 transition-all"
            >
              {removeBatchMut.isPending ? "移出中…" : "移出该批"}
            </button>
            <button
              type="button"
              onClick={saveBatch}
              disabled={batchBusy || editConflict}
              className="flex-1 py-2.5 rounded-full text-sm font-bold bg-primary text-white active:scale-96 transition-all"
            >
              {batchMut.isPending ? "保存中…" : "保存"}
            </button>
          </div>
        </AnimatedBottomSheet>
      )}
    </div>
  )
}
