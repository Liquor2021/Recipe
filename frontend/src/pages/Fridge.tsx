import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { fridgeApi, shoppingListApi } from "@/api"
import PageHeader from "@/components/PageHeader"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import DishImage from "@/components/DishImage"
import { cardShadow } from "@/components/Card"
import type { FridgeMatch, InventoryBatch } from "@/types"
import toast from "react-hot-toast"

const QUICK_ITEMS = ["鸡蛋", "番茄", "土豆", "青椒", "洋葱", "豆腐", "猪肉", "鸡翅", "虾仁", "白菜", "面条", "玉米"]

function todayStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// daysLeft 距过期天数；null 表示未设置保质期
function daysLeft(expiry: string): number | null {
  if (!expiry) return null
  const d = new Date(expiry + "T00:00:00")
  if (Number.isNaN(d.getTime())) return null
  const today = new Date(todayStr() + "T00:00:00")
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}

// expiryBadge 保质期徽章：level 用于逻辑判断（urgent=临期/过期），cls 只管样式
function expiryBadge(expiry: string): { text: string; cls: string; level: "expired" | "urgent" | "soon" | "ok" } | null {
  const left = daysLeft(expiry)
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
          <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold ${tone.bg} ${tone.text}`}>
            {badgeText}
          </span>
          {urgent.length > 0 && (
            <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-light text-red">
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
              className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-light text-[#C8A23C] transition-all active:scale-95 disabled:opacity-50"
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
  const qc = useQueryClient()
  const [input, setInput] = useState("")
  const [quantityInput, setQuantityInput] = useState("")
  // 编辑某一批次：数量 + 保质期
  const [editing, setEditing] = useState<InventoryBatch | null>(null)
  const [editQuantity, setEditQuantity] = useState("")
  const [editDate, setEditDate] = useState("")

  const { data: items = [] } = useQuery({ queryKey: ["fridge"], queryFn: () => fridgeApi.list() })
  const { data: matches, isLoading: matchesLoading } = useQuery({
    queryKey: ["fridge-recipes"],
    queryFn: () => fridgeApi.recipes(20),
    enabled: items.length > 0,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["fridge"] })
    qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
    // 首页临期提醒条用的缓存也要失效，否则返回首页会显示旧提醒
    qc.invalidateQueries({ queryKey: ["fridge-urgent"] })
  }

  const addMut = useMutation({
    mutationFn: (p: { name: string; quantity?: string; expiry?: string }) => fridgeApi.add(p.name, p.quantity, p.expiry),
    onSuccess: () => { invalidate(); toast.success("🧊 已放入冰箱") },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "添加失败"),
  })
  // 批次编辑（数量/保质期）与"新放入"分开提示
  const batchMut = useMutation({
    mutationFn: (p: { id: number; quantity: string; expiry: string }) => fridgeApi.updateBatch(p.id, p.quantity, p.expiry),
    onSuccess: () => { invalidate(); setEditing(null); toast.success("📅 批次已更新") },
    onError: () => toast.error("保存失败"),
  })
  const removeBatchMut = useMutation({
    mutationFn: (id: number) => fridgeApi.removeBatch(id),
    onSuccess: () => { invalidate(); setEditing(null); toast.success("已移出冰箱") },
    onError: () => toast.error("移出失败，稍后再试"),
  })
  // 一键清理已过期批次（批量接口单次最多 100 批，分段提交）
  const clearExpiredMut = useMutation({
    mutationFn: async (ids: number[]) => {
      let removed = 0
      for (let i = 0; i < ids.length; i += 100) {
        removed += (await fridgeApi.consume(ids.slice(i, i + 100))).removed
      }
      return removed
    },
    onSuccess: (removed) => { invalidate(); toast.success(`已清理 ${removed} 批过期食材`) },
    onError: () => toast.error("清理失败，稍后再试"),
  })

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

  // 按食材名分组：组 = 一种食材，组内可能多批次
  const groups = useMemo(() => {
    const m = new Map<string, InventoryBatch[]>()
    for (const b of items) {
      const arr = m.get(b.item_name) || []
      arr.push(b)
      m.set(b.item_name, arr)
    }
    return [...m.entries()]
  }, [items])

  const stocked = useMemo(() => new Set(items.map((i) => i.item_name)), [items])
  const quickLeft = QUICK_ITEMS.filter((n) => !stocked.has(n))
  const urgentCount = items.filter((i) => {
    const left = daysLeft(i.expiry_date)
    return left !== null && left <= 2
  }).length
  const expiredIds = items
    .filter((i) => {
      const left = daysLeft(i.expiry_date)
      return left !== null && left < 0
    })
    .map((i) => i.id)

  function handleAdd(raw: string) {
    const name = raw.trim()
    if (!name) return
    // 同食材再添加 = 追加一个新批次（如今天又买了一袋）
    addMut.mutate({ name, quantity: quantityInput.trim() })
    setInput("")
    setQuantityInput("")
  }

  function openBatchEditor(batch: InventoryBatch) {
    setEditing(batch)
    setEditQuantity(batch.quantity || "")
    setEditDate(batch.expiry_date || "")
  }

  function saveBatch() {
    if (!editing) return
    batchMut.mutate({ id: editing.id, quantity: editQuantity, expiry: editDate })
  }

  return (
    <div className="animate-fadeUp">
      <PageHeader
        title="冰箱库存"
        subtitle="记下家里有什么，帮你清冰箱"
        onBack={() => navigate(-1)}
        meta={urgentCount > 0 ? `${urgentCount} 批临期` : items.length > 0 ? `${items.length} 批` : undefined}
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto pb-24">
        {/* 添加食材：同食材再添加 = 追加新批次 */}
        <form onSubmit={(e) => { e.preventDefault(); handleAdd(input) }} className="flex gap-2 mb-2.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="冰箱里有什么？如：鸡蛋、番茄…"
            className="flex-1 h-11 rounded-2xl border-[1.5px] border-border bg-card px-4 text-sm font-medium outline-none transition-all focus:border-primary focus:shadow-[0_0_0_3px_rgba(232,115,74,.12)]"
          />
          <button
            type="submit"
            disabled={!input.trim() || addMut.isPending}
            className="h-11 px-5 rounded-2xl bg-primary text-white text-sm font-bold transition-all active:scale-95 disabled:opacity-50"
          >
            放入
          </button>
        </form>
        <input
          value={quantityInput}
          onChange={(e) => setQuantityInput(e.target.value)}
          placeholder="数量（可选），如：3个、半袋"
          className="w-full h-9 mb-3 rounded-xl border border-border bg-bg px-3.5 text-xs text-text2 outline-none transition-all focus:border-primary"
        />

        {/* 快速添加 */}
        {quickLeft.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2.5 mb-4 scrollbar-none scroll-fade-x">
            {quickLeft.map((name) => (
              <button
                key={name}
                onClick={() => handleAdd(name)}
                className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-card border border-border text-text2 transition-all active:scale-95 hover:border-primary/30 hover:text-primary"
              >
                + {name}
              </button>
            ))}
          </div>
        )}

        {expiredIds.length > 0 && (
          <div className="flex items-center justify-between gap-3 mb-3 px-3.5 py-2.5 rounded-2xl bg-red-light text-red">
            <span className="text-xs font-semibold">有 {expiredIds.length} 批食材已过期</span>
            <button
              type="button"
              disabled={clearExpiredMut.isPending}
              onClick={() => { if (confirm(`确定把 ${expiredIds.length} 批过期食材移出冰箱吗？`)) clearExpiredMut.mutate(expiredIds) }}
              className="flex-shrink-0 px-3 py-1 rounded-full text-xs font-bold bg-red text-white transition-all active:scale-95 disabled:opacity-50"
            >
              一键清理
            </button>
          </div>
        )}

        {/* 已有食材（按食材分组，组内批次） */}
        {groups.length > 0 ? (
          <div className="flex flex-col gap-2.5 mb-6">
            {groups.map(([name, batches]) => {
              const hasUrgent = batches.some((b) => {
                const l = daysLeft(b.expiry_date)
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
                      <span className="text-[10px] font-semibold text-text3 bg-bg px-2 py-0.5 rounded-full">{batches.length} 批</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {batches.map((b) => {
                      const badge = expiryBadge(b.expiry_date)
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
                          {badge && (
                            <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${badge.cls}`}>{badge.text}</span>
                          )}
                          <button
                            type="button"
                            aria-label={`移出${name}该批`}
                            onClick={(e) => { e.stopPropagation(); removeBatchMut.mutate(b.id) }}
                            className="ml-auto w-5 h-5 rounded-full flex items-center justify-center opacity-50 hover:bg-black/5 hover:opacity-100 transition-all active:scale-90 text-base leading-none"
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
        ) : (
          <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center mb-6`}>
            <div className="text-[40px] mb-2">🧊</div>
            <div className="text-[15px] font-bold mb-1">冰箱还是空的</div>
            <div className="text-xs text-text2 leading-relaxed">
              把现有食材记进来，马上告诉你能做什么菜。<br />
              买菜清单里点「家中有」也会自动记进来。
            </div>
          </div>
        )}

        {/* 清冰箱推荐 */}
        {items.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-bold">🍳 清冰箱推荐</div>
              <span className="text-[11px] text-text3">临期批次会优先用掉</span>
            </div>
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
            ) : (
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-6 text-center`}>
                <div className="text-[32px] mb-2">🤔</div>
                <div className="text-sm font-bold mb-1">这些食材还凑不成一道菜</div>
                <div className="text-xs text-text2">再加一两种，或者去菜品页逛逛找找灵感</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 批次编辑弹层 */}
      {editing && (
        <AnimatedBottomSheet onClose={() => setEditing(null)} className="rounded-t-3xl p-5">
          <div className="text-lg font-extrabold mb-0.5">{editing.item_name}</div>
          <div className="text-xs text-text3 mb-4">编辑这一批的数量和保质期</div>
          <input
            value={editQuantity}
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
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="flex-1 h-9 rounded-xl border border-border bg-bg px-2.5 text-sm text-text font-medium outline-none focus:border-primary"
            />
          </label>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => removeBatchMut.mutate(editing.id)}
              disabled={removeBatchMut.isPending}
              className="py-2.5 px-4 rounded-full text-sm font-semibold bg-red-light text-red active:scale-96 transition-all"
            >
              移出该批
            </button>
            <button
              type="button"
              onClick={saveBatch}
              className="flex-1 py-2.5 rounded-full text-sm font-bold bg-primary text-white active:scale-96 transition-all"
            >
              保存
            </button>
          </div>
        </AnimatedBottomSheet>
      )}
    </div>
  )
}
