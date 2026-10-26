import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { fridgeApi } from "@/api"
import PageHeader from "@/components/PageHeader"
import DishImage from "@/components/DishImage"
import { cardShadow } from "@/components/Card"
import type { FridgeMatch } from "@/types"
import toast from "react-hot-toast"

const QUICK_ITEMS = ["鸡蛋", "番茄", "土豆", "青椒", "洋葱", "豆腐", "猪肉", "鸡翅", "虾仁", "白菜", "面条", "玉米"]

function coverageTone(coverage: number) {
  if (coverage >= 80) return { bg: "bg-mint-light", text: "text-mint", bar: "bg-mint", label: "马上能做" }
  if (coverage >= 50) return { bg: "bg-primary-light", text: "text-primary", bar: "bg-primary", label: "加一步就成" }
  return { bg: "bg-yellow-light", text: "text-[#C8A23C]", bar: "bg-yellow", label: "还缺不少" }
}

function MatchCard({ match, onClick }: { match: FridgeMatch; onClick: () => void }) {
  const tone = coverageTone(match.coverage)
  // 后端全命中/全缺失时字段可能为 null，统一兜底成数组
  const matched = match.matched || []
  const missing = match.missing || []
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
            能做 {match.coverage}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-bg overflow-hidden mb-1.5">
          <div className={`h-full rounded-full ${tone.bar} transition-all`} style={{ width: `${match.coverage}%` }} />
        </div>
        <div className="text-[11px] leading-relaxed text-text2">
          <span className="text-mint font-medium">有 {matched.join("、")}</span>
          {missing.length > 0 && (
            <span className="text-text3"> · 缺 {missing.slice(0, 3).join("、")}{missing.length > 3 ? "…" : ""}</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Fridge() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [input, setInput] = useState("")

  const { data: items = [] } = useQuery({ queryKey: ["fridge"], queryFn: () => fridgeApi.list() })
  const { data: matches } = useQuery({
    queryKey: ["fridge-recipes"],
    queryFn: () => fridgeApi.recipes(20),
    enabled: items.length > 0,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["fridge"] })
    qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
  }

  const addMut = useMutation({
    mutationFn: (name: string) => fridgeApi.add(name),
    onSuccess: () => { invalidate(); toast.success("🧊 已放入冰箱") },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "添加失败"),
  })
  const removeMut = useMutation({
    mutationFn: (name: string) => fridgeApi.remove(name),
    onSuccess: () => invalidate(),
  })

  const stocked = useMemo(() => new Set(items.map((i) => i.item_name)), [items])
  const quickLeft = QUICK_ITEMS.filter((n) => !stocked.has(n))

  function handleAdd(raw: string) {
    const name = raw.trim()
    if (!name) return
    if (stocked.has(name)) {
      toast("冰箱里已经有啦~")
      setInput("")
      return
    }
    addMut.mutate(name)
    setInput("")
  }

  return (
    <div className="animate-fadeUp">
      <PageHeader
        title="冰箱库存"
        subtitle="记下家里有什么，帮你清冰箱"
        onBack={() => navigate(-1)}
        meta={items.length > 0 ? `${items.length} 种食材` : undefined}
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto pb-24">
        {/* 添加食材 */}
        <form onSubmit={(e) => { e.preventDefault(); handleAdd(input) }} className="flex gap-2.5 mb-3">
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

        {/* 已有食材 */}
        {items.length > 0 ? (
          <div className="mb-6">
            <div className="text-[13px] font-semibold text-text3 mb-2.5">🧊 我家有 {items.length} 种</div>
            <div className="flex flex-wrap gap-2">
              {items.map((item) => (
                <span
                  key={item.id}
                  className="inline-flex items-center gap-1.5 pl-3.5 pr-2 py-1.5 rounded-full bg-mint-light border border-mint/25 text-sm font-medium text-[#2E8577] animate-pop-soft"
                >
                  {item.item_name}
                  <button
                    onClick={() => removeMut.mutate(item.item_name)}
                    aria-label={`移出${item.item_name}`}
                    className="w-5 h-5 rounded-full flex items-center justify-center text-mint/70 hover:bg-mint/15 hover:text-mint transition-all active:scale-90"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
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
              <span className="text-[11px] text-text3">按主要食材匹配 · 葱姜蒜不算</span>
            </div>
            {matches && matches.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                {matches.map((m) => (
                  <MatchCard key={m.dish.id} match={m} onClick={() => navigate(`/dishes/${m.dish.id}`)} />
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
    </div>
  )
}
