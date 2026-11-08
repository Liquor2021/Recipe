import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { dishesApi } from "@/api"
import type { Dish } from "@/types"
import { Search, X, Plus } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
import HorizontalFilterStrip from "@/components/HorizontalFilterStrip"
import DishImage from "@/components/DishImage"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import "@/styles/kitchen-tools.css"
type MealType = "lunch" | "dinner"
const maxPerMeal = 5
const mealMeta = { lunch: { shortLabel: "午市" }, dinner: { shortLabel: "晚市" } }
function diffLabel(difficulty: string) { return difficulty === "easy" ? "简单" : difficulty === "medium" ? "中等" : "费点劲" }
function cookTimeText(dish: Dish) { return dish.cook_time > 0 ? `${dish.cook_time}分钟` : "时间未填" }

export default function DishPickerModal({
  date, singlePick = false, busy = false, lockedIds = [],
  meal,
  selectedMealById,
  onAdd,
  onRemove,
  onClose,
}: {
  date?: string
  singlePick?: boolean
  busy?: boolean
  lockedIds?: number[]
  meal: MealType
  selectedMealById: Map<number, MealType>
  onAdd: (dish: Dish) => void
  onRemove: (meal: MealType, dishId: number) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState("")
  const [keyword, setKeyword] = useState("")
  const [category, setCategory] = useState("全部")
  const categoryStripRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const meta = mealMeta[meal]
  const theme = useKitchenTheme(s => s.theme)
  const selectedCount = [...selectedMealById.values()].filter(selectedMeal => selectedMeal === meal).length
  const mealFull = !singlePick && selectedCount >= maxPerMeal

  // 输入停顿 250ms 再搜，避免每敲一个字发一次请求
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  // 按餐次、关键词和分类独立分页，所有候选菜均可继续浏览。
  const { data, isPending, isFetching, isError, isFetchingNextPage, isFetchNextPageError, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    queryKey: ["dishes", "tomorrow-picker-infinite", meal, keyword, category],
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string> = { enabled: "true", meal_type: meal, page: String(pageParam), pageSize: "40", sort: "sort_order", order: "asc" }
      if (keyword) params.search = keyword
      if (category !== "全部") params.category = category
      const page = await dishesApi.list(params)
      return { ...page, items: page.items ?? [] }
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages, lastPageParam) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0)
      return lastPage.items.length > 0 && loaded < lastPage.total ? lastPageParam + 1 : undefined
    },
  })
  const filtered = useMemo(() => {
    // 菜品排序可能在翻页间变动，保留首次出现的位置，避免重复行。
    const unique = new Map<number, Dish>()
    for (const page of data?.pages ?? []) {
      for (const dish of page.items) if (!unique.has(dish.id)) unique.set(dish.id, dish)
    }
    return [...unique.values()]
  }, [data])
  const total = data?.pages[0]?.total ?? 0
  const searchPending = search.trim() !== keyword

  useLayoutEffect(() => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0
  }, [meal, keyword, category])

  const { data: categoryCounts } = useQuery({
    queryKey: ["dishes", "category-counts"],
    queryFn: () => dishesApi.categoryCounts(),
  })
  const categories = useMemo(
    () => ["全部", ...(categoryCounts?.categories || []).map((c) => c.category).filter(Boolean)],
    [categoryCounts],
  )

  return (
    <KitchenSheet title={`${date ? date.slice(5) + " · " : ""}${singlePick ? "替换" : "挑选"}${meta.shortLabel}`} closeDisabled={busy} theme={theme} onClose={onClose} className="k-plan-picker" icon={<Search size={19} />} footer={<button className="is-ink" disabled={busy} onClick={onClose}>{busy ? "保存中…" : singlePick ? "返回菜单" : `选好了 · 本餐 ${selectedCount} 道`}</button>}>
        <div className="shrink-0 pt-2">
          <p className="mb-3 text-[12px] text-text3" role="status">
            {searchPending || isPending ? "正在找菜…" : data ? `${total} 道可选` : "暂时无法读取菜品"}
          </p>
          <p className="k-plan-picker-count" role="status" aria-live="polite">
            本餐已选 {selectedCount} / {maxPerMeal} 道
            {mealFull && <span> · 已满，移除一道后可继续添加</span>}
          </p>

          <label className="relative mb-3 block">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text3" size={17} strokeWidth={2.35} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索菜名、分类、配料"
              aria-label="搜索菜名、分类、配料"
              className="k-tool-field w-full pl-10"
            />
          </label>

          <HorizontalFilterStrip scrollRef={categoryStripRef} role="navigation" label="挑选菜品分类" itemCount={categories.length} className="k-plan-picker-categories">
            {categories.map((item) => (
              <button
                key={item}
                onClick={() => setCategory(item)}
                aria-pressed={category === item}
                className={`k-tool-chip ${category === item ? "is-active" : ""}`}
              >
                {item}
              </button>
            ))}
          </HorizontalFilterStrip>
        </div>

        <div ref={resultsRef} className="k-plan-picker-results min-h-0 flex-1 overflow-y-auto pb-4" aria-busy={isFetching || searchPending}>
          {isError && !isFetchNextPageError && (
            <div className="kitchen-empty my-3" role="alert">
              <strong>{data ? "菜品更新失败" : "菜品加载失败"}</strong>
              <p>{data ? "已加载的菜仍可查看，请稍后重试。" : "请检查网络后再试。"}</p>
              <button type="button" className="k-tool-button mt-3" disabled={isFetching || searchPending} onClick={() => { void refetch() }}>
                {isFetching ? "正在重试…" : "重新加载"}
              </button>
            </div>
          )}
          {isPending ? (
            <div className="space-y-2 py-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 rounded-2xl skeleton" />
              ))}
            </div>
          ) : filtered.length === 0 && !isError ? (
            <div className="py-14 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-bg text-text3">
                <Search size={23} strokeWidth={2.35} />
              </div>
              <div className="text-sm font-bold text-text2">没有找到合适的菜</div>
              <div className="mt-1 text-[12px] text-text3">换个关键词或分类试试</div>
            </div>
          ) : (
            <div className={`divide-y divide-border/70 transition-opacity ${searchPending ? "opacity-60" : ""}`}>
              {filtered.map((dish) => {
                const selectedMeal = selectedMealById.get(dish.id)
                const selectedHere = selectedMeal === meal
                const selectedOther = selectedMeal && selectedMeal !== meal
                return (
                  <div key={dish.id} className="k-plan-picker-row flex items-center gap-3 py-3">
                    <div className="k-tool-polaroid">
                      <DishImage dish={dish} className="h-full w-full" emojiSize="text-[27px]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="k-tool-section-title truncate" title={dish.name}>{dish.name}</div>
                      <div className="k-plan-picker-meta" title={[dish.category, cookTimeText(dish), diffLabel(dish.difficulty)].filter(Boolean).join(" · ")}>
                        {[dish.category, cookTimeText(dish), diffLabel(dish.difficulty)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {selectedOther ? (
                      <button
                        disabled
                        title={`已在${mealMeta[selectedMeal].shortLabel}`}
                        aria-label={`${dish.name}已在${mealMeta[selectedMeal].shortLabel}`}
                        className="k-tool-button shrink-0 text-[11px]"
                      >
                        已选
                      </button>
                    ) : selectedHere ? (
                      <button
                        onClick={() => onRemove(meal, dish.id)}
                        disabled={busy || singlePick || lockedIds.includes(dish.id) || searchPending}
                        className="k-tool-button shrink-0"
                      >
                        <X size={13} strokeWidth={2.5} />
                        {singlePick || lockedIds.includes(dish.id) ? "已选" : "移除"}
                      </button>
                    ) : (
                      <button
                        onClick={() => onAdd(dish)}
                        disabled={busy || mealFull || searchPending}
                        title={mealFull ? `每餐最多 ${maxPerMeal} 道，移除一道后可继续添加` : `加入${dish.name}`}
                        className="k-tool-button is-ink shrink-0"
                      >
                        <Plus size={13} strokeWidth={2.7} />
                        {mealFull ? "已满" : singlePick ? "选这道" : "加入"}
                      </button>
                    )}
                  </div>
                )
              })}
              {filtered.length > 0 && (
                <div className="py-4 text-center text-[12px] text-text3">
                  <p role="status">已显示 {filtered.length} / {total} 道{!hasNextPage && " · 已到底"}</p>
                  {isFetchNextPageError && <p role="alert" className="mt-2">后面的菜暂时没加载出来，已显示的菜还在。</p>}
                  {(hasNextPage || isFetchNextPageError) && (
                    <button type="button" className="k-tool-button mt-3" disabled={isFetching || searchPending} onClick={() => { if (!isFetching && !searchPending) void fetchNextPage({ cancelRefetch: false }) }}>
                      {isFetchingNextPage ? "正在加载…" : isFetchNextPageError ? "重试加载更多" : "加载更多菜品"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
    </KitchenSheet>
  )
}
