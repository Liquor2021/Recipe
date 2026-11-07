import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useInfiniteQuery, useMutation, useQueryClient, useMutationState } from "@tanstack/react-query"
import { dishesApi, favoritesApi, settingsApi, recordsApi, getUploadErrorMessage } from "@/api"
import { asArray } from "@/lib/utils"
import { readDishListSession, saveDishListSession, useDishListSession } from "@/lib/dishListSession"
import { hasPendingMealSelection, mealSelectionKey, mealSelectionMutationKey, pendingMealSelectionKey, reconcileMealSelection } from "@/lib/mealSelection"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import DishImage from "@/components/DishImage"
import SafeImage from "@/components/SafeImage"
import { isImageUrl, thumbUrl } from "@/lib/dishImage"
import type { Dish, MealRecord } from "@/types"
import PageHeader, { HeaderIconButton } from "@/components/PageHeader"
import { useAuthStore } from "@/store/useAuthStore"
import toast from "react-hot-toast"
import { Settings, UtensilsCrossed, Minus, Plus, ChefHat, X, Trash2, LoaderCircle } from "lucide-react"

const DEFAULT_CATEGORIES = ["川菜", "粤菜", "家常菜", "快手菜", "汤品", "主食"]
const DEFAULT_TASTES = ["酸", "甜", "辣", "鲜", "清淡", "咸鲜", "麻辣", "蒜香", "酱香", "糖醋", "酸辣", "香辣"]

function parseList(raw: unknown, fallback: string[]): string[] {
  const arr = asArray<string>(raw).filter((x) => typeof x === "string")
  return arr.length > 0 ? arr : fallback
}

function diffLabel(d: string) { return d === "easy" ? "简单" : d === "medium" ? "中等" : "困难" }
function diffColor(d: string) { return d === "easy" ? "text-mint" : d === "medium" ? "text-yellow" : "text-primary" }
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
}

const PAGE_SIZE = 30

type MealSelectionRequest = Pick<MealRecord, "dish_id" | "dish_name" | "meal_date" | "meal_type"> & { cancelRecordId?: number }

export default function DishList() {
  const generation = useDishListSession((s) => s.generation)
  const [today, setToday] = useState(dateKey)

  useEffect(() => {
    const checkDate = () => setToday(dateKey())
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 50)
    const timer = window.setTimeout(checkDate, midnight.getTime() - Date.now())
    document.addEventListener("visibilitychange", checkDate)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", checkDate)
    }
  }, [today])

  return <DishListPage key={`${today}:${generation}`} today={today} generation={generation} />
}

function DishListPage({ today, generation }: { today: string; generation: number }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const [session] = useState(() => readDishListSession(today))
  const [search, setSearch] = useState(session.search)
  const [activeCategory, setActiveCategory] = useState(session.activeCategory)
  const [activeTaste, setActiveTaste] = useState(session.activeTaste)
  const [showTodayModal, setShowTodayModal] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const tasteRef = useRef<HTMLDivElement>(null)
  const restoreScrollRef = useRef<number | null>(session.scrollTop)
  const mealEditLocks = useRef(new Set<string>())
  const pendingMealKeys = useMutationState({
    filters: { mutationKey: mealSelectionMutationKey, status: "pending" },
    select: mutation => pendingMealSelectionKey(mutation.state.variables),
  })
  const pendingMeals = new Set(pendingMealKeys)

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get(),
  })

  const { data: categoryCountsData } = useQuery({
    queryKey: ["dishes", "category-counts"],
    queryFn: () => dishesApi.categoryCounts(),
  })
  const categoryCountMap = useMemo(() => {
    const m = new Map<string, number>()
    if (categoryCountsData?.categories) {
      for (const c of categoryCountsData.categories) m.set(c.category, c.count)
    }
    return m
  }, [categoryCountsData])
  const enabledTotal = categoryCountsData?.total ?? 0

  const tastes = useMemo(() => ["全部", ...parseList(settings?.tastes, DEFAULT_TASTES)], [settings])
  const sidebarCats = useMemo(() => {
    const cats = parseList(settings?.categories, DEFAULT_CATEGORIES)
    return ["全部", ...cats]
  }, [settings])

  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      pageSize: String(PAGE_SIZE),
      sort: "sort_order",
      order: "asc",
    }
    if (activeCategory !== "全部") params.category = activeCategory
    if (activeTaste !== "全部") params.taste = activeTaste
    if (search) params.search = search
    return params
  }, [activeCategory, activeTaste, search])

  const {
    data: dishesData, isPending, isFetching, isFetchingNextPage,
    isError, isFetchNextPageError, hasNextPage, fetchNextPage, refetch,
  } = useInfiniteQuery({
    queryKey: ["dishes", "infinite", generation, today, queryParams],
    queryFn: async ({ pageParam }) => {
      const page = await dishesApi.list({ ...queryParams, page: String(pageParam) })
      // An unmatched search is returned as items: null by the Go API.
      return { ...page, items: page.items ?? [] }
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages, lastPageParam) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0)
      return lastPage.items.length > 0 && loaded < lastPage.total ? lastPageParam + 1 : undefined
    },
    gcTime: 30 * 60 * 1000,
  })

  const allDishes = useMemo(() => {
    // The sort order can change while paging; do not render the same dish twice.
    const dishes = new Map<number, Dish>()
    for (const page of dishesData?.pages ?? []) {
      for (const dish of page.items) if (!dishes.has(dish.id)) dishes.set(dish.id, dish)
    }
    return Array.from(dishes.values())
  }, [dishesData])

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage({ cancelRefetch: false })
  }, [fetchNextPage, hasNextPage, isFetching])

  const paramsKey = JSON.stringify(queryParams)
  const previousParamsRef = useRef(paramsKey)
  useLayoutEffect(() => {
    const container = listRef.current
    if (!container) return
    if (previousParamsRef.current !== paramsKey) {
      previousParamsRef.current = paramsKey
      restoreScrollRef.current = null
      container.scrollTop = 0
      saveDishListSession(today, { scrollTop: 0 })
    }
    const target = restoreScrollRef.current
    if (target === null || !dishesData) return
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.min(target, maxScroll)
    if (maxScroll >= target || !hasNextPage) restoreScrollRef.current = null
  }, [dishesData, hasNextPage, paramsKey, today])

  useEffect(() => {
    saveDishListSession(today, { search, activeCategory, activeTaste })
  }, [today, search, activeCategory, activeTaste])

  useLayoutEffect(() => {
    if (sidebarRef.current) sidebarRef.current.scrollTop = session.categoryScrollTop
    if (tasteRef.current) tasteRef.current.scrollLeft = session.tasteScrollLeft
  }, [session])

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current
    const selected = sidebar?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    if (!sidebar || !selected) return
    const bounds = sidebar.getBoundingClientRect()
    const itemBounds = selected.getBoundingClientRect()
    if (itemBounds.top < bounds.top) sidebar.scrollTop += itemBounds.top - bounds.top
    else if (itemBounds.bottom > bounds.bottom) sidebar.scrollTop += itemBounds.bottom - bounds.bottom
  }, [activeCategory, sidebarCats])

  useEffect(() => {
    // If the cache expired during a long detail visit, refill only as far as the
    // saved position. Failed requests wait for the explicit retry button.
    if (restoreScrollRef.current !== null && dishesData && !isError) loadMore()
  }, [dishesData, isError, loadMore])

  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!hasNextPage || isError) return
    const el = loadMoreRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore()
      },
      { root: listRef.current, rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isError, loadMore])

  const { data: favDishes } = useQuery({
    queryKey: ["favorites"],
    queryFn: () => favoritesApi.list(),
  })
  const favIds = useMemo(() => new Set((favDishes || []).map((d: Dish) => d.id)), [favDishes])

  const { data: recordsData, isError: recordsError, isFetching: recordsFetching, fetchStatus: recordsFetchStatus, refetch: reloadRecords } = useQuery({
    queryKey: ["records", "today", today],
    queryFn: () => recordsApi.list({ pageSize: "100", date_from: today, date_to: today }),
  })
  const mealStateUnavailable = !recordsData || recordsError || recordsFetchStatus === "paused"
  const todayRecords = useMemo(() => (recordsData?.items || []).filter(r => r.status !== "cancelled"), [recordsData])

  const todayLunchIds = useMemo(() => new Set(
    todayRecords.filter(r => r.meal_type === "lunch" && r.meal_date === today).map(r => r.dish_id)
  ), [todayRecords, today])
  const todayDinnerIds = useMemo(() => new Set(
    todayRecords.filter(r => r.meal_type === "dinner" && r.meal_date === today).map(r => r.dish_id)
  ), [todayRecords, today])

  const favMut = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      active ? favoritesApi.remove(id) : favoritesApi.add(id),
    onSuccess: (_, { active }) => {
      qc.invalidateQueries({ queryKey: ["favorites"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      toast.success(active ? "已取消收藏" : "❤ 已收藏")
    },
    onError: () => toast.error("操作失败"),
  })

  const mealMut = useMutation({
    mutationKey: mealSelectionMutationKey,
    retry: false,
    mutationFn: ({ cancelRecordId, ...data }: MealSelectionRequest) => cancelRecordId !== undefined
      ? recordsApi.update(cancelRecordId, { status: "cancelled" })
      : recordsApi.create({ ...data, status: "planned" }),
    onSuccess: (_saved, request) => {
      toast.success(request.cancelRecordId !== undefined ? "已取消计划，可在记录页恢复" : "已加入今日计划")
    },
    onError: (err: unknown, request) => {
      // Until success the row is unchanged, so no whole-list rollback is needed.
      toast.error(getUploadErrorMessage(err, request.cancelRecordId !== undefined ? "取消失败" : "加入计划失败"))
    },
    onSettled: async (saved, _error, request) => {
      try {
        await Promise.all([
          // Reconcile this page even while unmounted; a timed-out write may have
          // reached the server, so returning must not expose the old toggle.
          reconcileMealSelection(qc, request.meal_date, saved),
          qc.invalidateQueries({ queryKey: ["records"], predicate: query => !(query.queryKey.length === 3 && query.queryKey[1] === "today" && query.queryKey[2] === request.meal_date) }),
          qc.invalidateQueries({ queryKey: ["achievements"] }),
          qc.invalidateQueries({ queryKey: ["shopping-list"] }),
          qc.invalidateQueries({ queryKey: ["record"] }),
          qc.invalidateQueries({ queryKey: ["dish-records"] }),
          qc.invalidateQueries({ queryKey: ["admin", "records"] }),
        ])
      } finally {
        mealEditLocks.current.delete(mealSelectionKey(request))
      }
    },
  })

  const startMealEdit = useCallback((request: MealSelectionRequest) => {
    const key = mealSelectionKey(request)
    if (mealStateUnavailable || mealEditLocks.current.has(key) || hasPendingMealSelection(qc, request)) return
    mealEditLocks.current.add(key)
    mealMut.mutate(request)
  }, [mealStateUnavailable, qc, mealMut])

  function cancelMeal(record: MealRecord) {
    if (record.status !== "planned") return
    startMealEdit({ ...record, cancelRecordId: record.id })
  }

  function toggleMeal(dish: Dish, mealType: "lunch" | "dinner") {
    const isAdded = mealType === "lunch" ? todayLunchIds.has(dish.id) : todayDinnerIds.has(dish.id)
    if (isAdded) {
      const record = todayRecords.find(r => r.dish_id === dish.id && r.meal_type === mealType && r.meal_date === today)
      if (record?.status === "completed") toast("这道菜已吃过，可在记录页查看或删除")
      else if (record) cancelMeal(record)
    } else {
      startMealEdit({
        dish_id: dish.id,
        dish_name: dish.name,
        meal_type: mealType,
        meal_date: today,
      })
    }
  }

  const groupedByCategory = useMemo(() => {
    const map = new Map<string, Dish[]>()
    for (const d of allDishes) {
      const cat = d.category || "其他"
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(d)
    }
    return map
  }, [allDishes])

  const categoryRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [highlightCat, setHighlightCat] = useState("")

  const categoryRefCallback = useCallback((cat: string) => (el: HTMLDivElement | null) => {
    if (el) categoryRefs.current.set(cat, el)
    else categoryRefs.current.delete(cat)
  }, [])

  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const sections = categoryRefs.current
    if (sections.size === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setHighlightCat(entry.target.getAttribute("data-category") || "")
          }
        }
      },
      { root: container, rootMargin: "-60px 0px -70% 0px", threshold: 0 }
    )
    sections.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [allDishes])

  function scrollToCategory(cat: string) {
    restoreScrollRef.current = null
    setActiveCategory(cat)
    setSearch("")
    if (listRef.current) listRef.current.scrollTop = 0
    saveDishListSession(today, { scrollTop: 0 })
  }

  const totalPicked = todayLunchIds.size + todayDinnerIds.size

  const dishMap = useMemo(() => {
    const map = new Map<number, Dish>()
    for (const d of allDishes) map.set(d.id, d)
    return map
  }, [allDishes])

  const todayLunchRecords = useMemo(() =>
    todayRecords.filter(r => r.meal_type === "lunch" && r.meal_date === today),
    [todayRecords, today]
  )
  const todayDinnerRecords = useMemo(() =>
    todayRecords.filter(r => r.meal_type === "dinner" && r.meal_date === today),
    [todayRecords, today]
  )
  const todayMenuCount = todayLunchRecords.length + todayDinnerRecords.length
  const todayLunchCookMinutes = useMemo(() => (
    todayLunchRecords.reduce((sum, record) => {
      const cookTime = dishMap.get(record.dish_id)?.cook_time || 0
      return sum + Math.max(0, cookTime)
    }, 0)
  ), [dishMap, todayLunchRecords])
  const todayDinnerCookMinutes = useMemo(() => (
    todayDinnerRecords.reduce((sum, record) => {
      const cookTime = dishMap.get(record.dish_id)?.cook_time || 0
      return sum + Math.max(0, cookTime)
    }, 0)
  ), [dishMap, todayDinnerRecords])

  const showGrouped = activeCategory === "全部" && activeTaste === "全部" && !search

  return (
    <div className="animate-fadeUp flex flex-col h-full">
      <PageHeader
        title="菜品"
        subtitle="选菜加餐，一键搞定"
        icon={UtensilsCrossed}
        actions={
           <HeaderIconButton onClick={() => navigate(isLoggedIn ? "/admin/dashboard" : "/admin/login")} aria-label="管理设置">
            <Settings size={18} strokeWidth={2.3} />
          </HeaderIconButton>
        }
      />

      {(recordsError || recordsFetchStatus === "paused") && (
        <div role="alert" className="px-5 py-2 text-xs text-text2 bg-card border-b border-border">
          今日菜单状态读取失败，暂时不能点菜。
          <button type="button" disabled={recordsFetching} onClick={() => { void reloadRecords() }} className="ml-2 min-h-9 px-2 text-primary disabled:opacity-50">重新读取</button>
        </div>
      )}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div className="absolute inset-0 flex">
          <div
            ref={sidebarRef}
            role="navigation"
            aria-label="菜品分类"
            onScroll={(event) => saveDishListSession(today, { categoryScrollTop: event.currentTarget.scrollTop })}
            className="w-[76px] flex-shrink-0 bg-card border-r border-border overflow-y-auto overscroll-y-contain scrollbar-none"
          >
            {sidebarCats.map((cat) => {
              const count = cat === "全部" ? enabledTotal : (categoryCountMap.get(cat) ?? 0)
              return (
                <button
                  key={cat}
                  onClick={() => scrollToCategory(cat)}
                  aria-current={activeCategory === cat ? "true" : undefined}
                  className={`w-full py-3 px-1.5 text-[12px] font-medium text-center transition-all relative whitespace-pre-line leading-tight ${
                    (activeCategory === cat || (cat !== "全部" && highlightCat === cat && activeCategory === "全部"))
                      ? "bg-bg text-primary font-bold before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-[3px] before:h-5 before:bg-primary before:rounded-r-full"
                      : "text-text2 bg-card"
                  }`}
                >
                  {cat}<span className="block text-[11px] text-text3 font-normal">{count}道</span>
                </button>
              )
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-3 pt-3 pb-2">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text3 text-sm">🔍</span>
                <input
                  type="text"
                  placeholder="搜索菜品、配料..."
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setActiveCategory("全部"); setActiveTaste("全部") }}
                  className="w-full py-2 pl-9 pr-3 rounded-full bg-bg border border-border text-[13px] transition-all focus:border-primary focus:shadow-[0_0_0_3px_rgba(232,115,74,.12)] outline-none"
                />
              </div>
            </div>

            <div className="px-3 pb-2">
              <div
                ref={tasteRef}
                onScroll={(event) => saveDishListSession(today, { tasteScrollLeft: event.currentTarget.scrollLeft })}
                className="flex items-center gap-1.5 overflow-x-auto scrollbar-none scroll-fade-x"
              >
                {tastes.map((t) => (
                  <button
                    key={t}
                    onClick={() => setActiveTaste(t)}
                    className={`px-3 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-all active:scale-95 ${
                      activeTaste === t
                        ? "bg-pink text-white"
                        : "bg-card border border-border text-text2"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={listRef}
              role="region"
              aria-label="菜品列表"
              onScroll={(event) => {
                if (restoreScrollRef.current === null) saveDishListSession(today, { scrollTop: event.currentTarget.scrollTop })
              }}
              className="flex-1 overflow-y-auto px-3 scrollbar-none overscroll-y-contain"
            >
              {isError && dishesData && !isFetchNextPageError && (
                <div role="alert" className="py-3 text-center text-[12px] text-text2">
                  <span>更新菜品失败，正在显示上次加载的内容</span>
                  <button onClick={() => void refetch()} disabled={isFetching} className="ml-2 px-2 py-1 text-primary disabled:opacity-50">重试</button>
                </div>
              )}
              {isPending ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex gap-3 p-2 rounded-xl">
                      <div className="skeleton w-[72px] h-[72px] rounded-xl flex-shrink-0" />
                      <div className="flex-1 space-y-2 py-1">
                        <div className="skeleton h-3.5 w-3/4 rounded" />
                        <div className="skeleton h-2.5 w-1/2 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : isError && !dishesData ? (
                <div role="alert" className="text-center py-16">
                  <div className="text-base font-semibold mb-1.5">菜品加载失败</div>
                  <div className="text-[13px] text-text2">暂时没能加载菜品，请重试</div>
                  <button onClick={() => void refetch()} disabled={isFetching} className="mt-3 px-4 py-2 rounded-full bg-primary text-white text-[13px] font-semibold disabled:opacity-50">重新加载</button>
                </div>
              ) : allDishes.length === 0 ? (
                <div className="text-center py-16">
                  <span className="text-[56px] block mb-4 animate-float">🍽</span>
                  <div className="text-base font-semibold mb-1.5">没有找到菜品</div>
                  <div className="text-[13px] text-text2">换个关键词试试？</div>
                </div>
              ) : showGrouped ? (
                Array.from(groupedByCategory.entries()).map(([cat, dishes]) => (
                  <div key={cat} ref={categoryRefCallback(cat)} data-category={cat}>
                    <div className="sticky top-0 z-10 bg-bg/92 backdrop-blur-sm py-2 px-1 text-[13px] font-bold text-text2 flex items-center gap-2">
                       <span className="w-1 h-4 bg-primary rounded-full" />
                       {cat}
                       <span className="text-[11px] text-text3 font-normal">{categoryCountMap.get(cat) ?? dishes.length}道</span>
                    </div>
                    {dishes.map((d) => (
                      <DishRow
                        key={d.id}
                        dish={d}
                        isFav={favIds.has(d.id)}
                        isLunch={todayLunchIds.has(d.id)}
                        isDinner={todayDinnerIds.has(d.id)}
                        lunchPending={pendingMeals.has(mealSelectionKey({ meal_date: today, meal_type: "lunch", dish_id: d.id }))}
                        dinnerPending={pendingMeals.has(mealSelectionKey({ meal_date: today, meal_type: "dinner", dish_id: d.id }))}
                        mealDisabled={mealStateUnavailable}
                        onToggleFav={() => favMut.mutate({ id: d.id, active: favIds.has(d.id) })}
                        // The ref is read only when this click callback runs, never during render.
                        // eslint-disable-next-line react-hooks/refs
                        onToggleMeal={(mt) => toggleMeal(d, mt)}
                        onClick={() => navigate(`/dishes/${d.id}`)}
                      />
                    ))}
                  </div>
                ))
              ) : (
                allDishes.map((d) => (
                  <DishRow
                    key={d.id}
                    dish={d}
                    isFav={favIds.has(d.id)}
                    isLunch={todayLunchIds.has(d.id)}
                    isDinner={todayDinnerIds.has(d.id)}
                    lunchPending={pendingMeals.has(mealSelectionKey({ meal_date: today, meal_type: "lunch", dish_id: d.id }))}
                    dinnerPending={pendingMeals.has(mealSelectionKey({ meal_date: today, meal_type: "dinner", dish_id: d.id }))}
                    mealDisabled={mealStateUnavailable}
                    onToggleFav={() => favMut.mutate({ id: d.id, active: favIds.has(d.id) })}
                    // The ref is read only when this click callback runs, never during render.
                    // eslint-disable-next-line react-hooks/refs
                    onToggleMeal={(mt) => toggleMeal(d, mt)}
                    onClick={() => navigate(`/dishes/${d.id}`)}
                  />
                ))
              )}

              {hasNextPage && (
                <div ref={loadMoreRef} className="py-4 text-center text-[12px] text-text3">
                  {isFetchNextPageError ? (
                    <div role="alert">
                      <span>后续菜品加载失败</span>
                      <button onClick={loadMore} disabled={isFetching} className="ml-2 px-2 py-1 text-primary disabled:opacity-50">点击重试</button>
                    </div>
                  ) : isFetchingNextPage ? "加载中..." : "下滑加载更多"}
                </div>
              )}
              {!hasNextPage && allDishes.length > 0 && (
                <div className="py-3 text-center text-[11px] text-text3">共 {allDishes.length} 道菜</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {totalPicked > 0 && (
        <div className="flex-shrink-0 bg-card/95 backdrop-blur-xl border-t border-border px-4 py-2.5 flex items-center gap-3 z-20">
          <div className="flex items-center gap-2">
            <div className="relative">
              <ChefHat size={22} className="text-primary" />
              <span className="absolute -top-1.5 -right-2 bg-primary text-white text-[11px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">{totalPicked}</span>
            </div>
            <div className="text-[13px]">
              {todayLunchIds.size > 0 && <span className="text-primary font-semibold">🍳午餐{todayLunchIds.size}道</span>}
              {todayLunchIds.size > 0 && todayDinnerIds.size > 0 && <span className="text-text3 mx-1">·</span>}
              {todayDinnerIds.size > 0 && <span className="text-mint font-semibold">🍲晚餐{todayDinnerIds.size}道</span>}
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setShowTodayModal(true)}
            className="py-2 px-5 rounded-full text-[13px] font-semibold bg-primary text-white transition-all active:scale-96"
          >
            今日菜单
          </button>
        </div>
      )}

      {showTodayModal && (
        <AnimatedBottomSheet
          onClose={() => setShowTodayModal(false)}
          className="flex max-h-[70dvh] flex-col rounded-t-2xl"
        >
          {({ close }) => (
            <>
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <div className="text-base font-bold">📋 今日菜单</div>
                <button onClick={close} className="w-8 h-8 rounded-full bg-bg flex items-center justify-center text-text2 active:scale-95 transition-transform">
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-3 scrollbar-none">
                <div className="mb-4 grid grid-cols-3 gap-2">
                  <div className="rounded-2xl bg-bg px-3 py-2.5">
                    <div className="text-[11px] font-semibold text-text3">菜品</div>
                    <div className="text-lg font-extrabold leading-tight">{todayMenuCount} 道</div>
                  </div>
                  <div className="rounded-2xl bg-bg px-3 py-2.5">
                    <div className="text-lg font-extrabold leading-tight">午餐 {todayLunchRecords.length} 道</div>
                    <div className="mt-0.5 truncate text-[11px] font-semibold text-text3">
                      约用时 {todayLunchCookMinutes > 0 ? `${todayLunchCookMinutes}m` : "-"}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-bg px-3 py-2.5">
                    <div className="text-lg font-extrabold leading-tight">晚餐 {todayDinnerRecords.length} 道</div>
                    <div className="mt-0.5 truncate text-[11px] font-semibold text-text3">
                      约用时 {todayDinnerCookMinutes > 0 ? `${todayDinnerCookMinutes}m` : "-"}
                    </div>
                  </div>
                </div>

                {todayLunchRecords.length > 0 && (
                  <div className="mb-5">
                    <div className="text-[13px] font-bold text-primary mb-2.5 flex items-center gap-1.5">🍳 午餐</div>
                    <div className="space-y-2">
                      {todayLunchRecords.map((r) => (
                        <TodayMenuItem
                          key={r.id}
                          record={r}
                          dish={dishMap.get(r.dish_id)}
                          pending={pendingMeals.has(mealSelectionKey(r))}
                          disabled={mealStateUnavailable}
                          onDelete={() => cancelMeal(r)}
                          onClick={() => { close(); navigate(`/dishes/${r.dish_id}?record_id=${r.id}`) }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {todayDinnerRecords.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[13px] font-bold text-mint mb-2.5 flex items-center gap-1.5">🍲 晚餐</div>
                    <div className="space-y-2">
                      {todayDinnerRecords.map((r) => (
                        <TodayMenuItem
                          key={r.id}
                          record={r}
                          dish={dishMap.get(r.dish_id)}
                          pending={pendingMeals.has(mealSelectionKey(r))}
                          disabled={mealStateUnavailable}
                          onDelete={() => cancelMeal(r)}
                          onClick={() => { close(); navigate(`/dishes/${r.dish_id}?record_id=${r.id}`) }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {todayLunchRecords.length === 0 && todayDinnerRecords.length === 0 && (
                  <div className="text-center py-8 text-text3 text-sm">还没有选择今日菜品</div>
                )}
              </div>

              <div className="px-5 py-3 border-t border-border" style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}>
                <button onClick={close} className="w-full py-2.5 rounded-full text-[13px] font-semibold bg-primary text-white transition-all active:scale-96">
                  继续选菜
                </button>
              </div>
            </>
          )}
        </AnimatedBottomSheet>
      )}
    </div>
  )
}

function TodayMenuItem({ record, dish, pending, disabled, onDelete, onClick }: { record: MealRecord; dish?: Dish; pending: boolean; disabled: boolean; onDelete: () => void; onClick: () => void }) {
  const dishHasImage = dish && isImageUrl(dish.image_url)
  const recordHasImage = !dishHasImage && isImageUrl(record.dish_image_url)
  return (
    <div className="flex items-center gap-3 p-2.5 bg-bg rounded-xl transition-all active:scale-98" onClick={onClick}>
      <div className="w-[52px] h-[52px] rounded-lg overflow-hidden flex-shrink-0 bg-gradient-to-br from-primary-light to-pink-light cursor-pointer">
        {dishHasImage ? (
          <DishImage dish={dish!} className="w-full h-full" emojiSize="text-[20px]" />
        ) : recordHasImage ? (
          <SafeImage
            src={thumbUrl(record.dish_image_url)}
            alt={record.dish_name}
            className="w-full h-full object-cover"
            fallback={<div className="w-full h-full flex items-center justify-center text-[20px]">{record.dish_emoji || "🍽"}</div>}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[20px]">{record.dish_emoji || "🍽"}</div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold truncate">{record.dish_name}</div>
        <div className="text-[11px] text-primary mt-0.5">{record.status === "completed" ? "已吃" : "计划中"} · 原量 × {record.portion_scale || 1}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-text2 mt-0.5">
          {dish?.category && <span>{dish.category}</span>}
          {dish?.cook_time != null && dish.cook_time > 0 && (
            <>
              <span className="w-[3px] h-[3px] rounded-full bg-text3" />
              <span>{dish.cook_time}分钟</span>
            </>
          )}
          {dish?.difficulty && (
            <>
              <span className="w-[3px] h-[3px] rounded-full bg-text3" />
              <span className={diffColor(dish.difficulty)}>{diffLabel(dish.difficulty)}</span>
            </>
          )}
        </div>
      </div>
      {record.status === "planned" && <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        aria-label={pending ? `正在更新${record.dish_name}的计划` : `取消${record.dish_name}的计划`}
        aria-busy={pending}
        disabled={disabled || pending}
        className="w-8 h-8 rounded-full bg-red-light text-red flex items-center justify-center transition-all active:scale-90 flex-shrink-0 disabled:opacity-50"
      >
        <Trash2 size={14} />
      </button>}
    </div>
  )
}

interface DishRowProps {
  dish: Dish
  isFav: boolean
  isLunch: boolean
  isDinner: boolean
  lunchPending: boolean
  dinnerPending: boolean
  mealDisabled: boolean
  onToggleFav: () => void
  onToggleMeal: (mealType: "lunch" | "dinner") => void
  onClick: () => void
}

function DishRow({ dish, isFav, isLunch, isDinner, lunchPending, dinnerPending, mealDisabled, onToggleFav, onToggleMeal, onClick }: DishRowProps) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-1 rounded-xl transition-all active:bg-card group">
      <div
        onClick={onClick}
        className="w-[72px] h-[72px] rounded-xl overflow-hidden flex-shrink-0 bg-gradient-to-br from-primary-light to-pink-light cursor-pointer"
      >
        <DishImage dish={dish} className="w-full h-full" emojiSize="text-[28px]" />
      </div>

      <div className="flex-1 min-w-0" onClick={onClick}>
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[14px] font-semibold truncate">{dish.name}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFav() }}
            className={`text-[14px] transition-all active:scale-90 flex-shrink-0 ${isFav ? "text-primary animate-heartbeat" : "text-text3 opacity-0 group-hover:opacity-100"}`}
          >
            {isFav ? "❤" : "♡"}
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text2 mb-1.5">
          <span>{dish.category}</span>
          <span className="w-[3px] h-[3px] rounded-full bg-text3" />
          <span>{dish.cook_time}分钟</span>
          <span className="w-[3px] h-[3px] rounded-full bg-text3" />
          <span className={diffColor(dish.difficulty)}>{diffLabel(dish.difficulty)}</span>
          {dish.taste && (
            <>
              <span className="w-[3px] h-[3px] rounded-full bg-text3" />
              <span>{dish.taste}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <MealToggle active={isLunch} pending={lunchPending} disabled={mealDisabled} emoji="🍳" label="午餐" onClick={() => onToggleMeal("lunch")} color="primary" />
          <MealToggle active={isDinner} pending={dinnerPending} disabled={mealDisabled} emoji="🍲" label="晚餐" onClick={() => onToggleMeal("dinner")} color="mint" />
        </div>
      </div>
    </div>
  )
}

interface MealToggleProps {
  active: boolean
  pending: boolean
  disabled: boolean
  emoji: string
  label: string
  onClick: () => void
  color: "primary" | "mint"
}

function MealToggle({ active, pending, disabled, emoji, label, onClick, color }: MealToggleProps) {
  const activeClass = color === "primary"
    ? "bg-primary text-white border-primary"
    : "bg-mint text-white border-mint"
  const inactiveClass = "bg-card border-border text-text2"

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={disabled || pending}
      aria-busy={pending}
      aria-label={pending ? `正在更新${label}计划` : undefined}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all active:scale-95 disabled:opacity-50 ${
        active ? activeClass : inactiveClass
      }`}
    >
      {pending ? <LoaderCircle size={10} className="animate-spin" /> : active ? <Minus size={10} /> : <Plus size={10} />}
      <span>{emoji}</span>
      <span>{label}</span>
    </button>
  )
}
