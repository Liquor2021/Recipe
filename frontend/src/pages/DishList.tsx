import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useQuery, useInfiniteQuery, useMutation, useQueryClient, useMutationState } from "@tanstack/react-query"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { dishesApi, favoritesApi, settingsApi, recordsApi, getUploadErrorMessage } from "@/api"
import { asArray } from "@/lib/utils"
import { readDishListSession, saveDishListSession, useDishListSession } from "@/lib/dishListSession"
import { restoreListScroll } from "@/lib/listScroll"
import { buildDishVirtualRows, includeFocusedNeighbours, resetDishMeasurements } from "@/lib/dishVirtualRows"
import { hasPendingMealSelection, mealSelectionKey, mealSelectionMutationKey, pendingMealSelectionKey, reconcileMealSelection } from "@/lib/mealSelection"
import KitchenTodayMenu from "@/components/KitchenTodayMenu"
import HorizontalFilterStrip from "@/components/HorizontalFilterStrip"
import DishImage from "@/components/DishImage"
import type { Dish, MealRecord } from "@/types"
import PageHeader, { HeaderIconButton } from "@/components/PageHeader"
import { useAuthStore } from "@/store/useAuthStore"
import toast from "react-hot-toast"
import "@/styles/kitchen-dishes.css"
import { Settings, Plus, Check, Heart, Search, X, ArrowRight, LoaderCircle } from "lucide-react"

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
  "use no memo" // TanStack Virtual exposes a live instance; compiler memoization would freeze its reads.
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const [session] = useState(() => readDishListSession(today))
  const [search, setSearch] = useState(session.search)
  const [activeCategory, setActiveCategory] = useState(session.activeCategory)
  const [activeTaste, setActiveTaste] = useState(session.activeTaste)
  const [showTodayModal, setShowTodayModal] = useState(false)
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null)
  // Tab pages remain mounted: dismiss the portal when browser navigation leaves.
  const [menuPath, setMenuPath] = useState(location.pathname)
  if (menuPath !== location.pathname) {
    setMenuPath(location.pathname)
    if (showTodayModal) setShowTodayModal(false)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const tasteRef = useRef<HTMLDivElement>(null)
  const restoreScrollRef = useRef<number | null>(session.scrollTop)
  const measuredWidthRef = useRef<number | null>(session.virtualSnapshot?.width ?? null)
  const leavingListRef = useRef(false)
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

  const showGrouped = activeCategory === "全部" && activeTaste === "全部" && !search
  const virtualRows = useMemo(() => buildDishVirtualRows(allDishes, showGrouped), [allDishes, showGrouped])
  const focusedIndex = useMemo(() => virtualRows.findIndex(row => row.key === focusedRowKey), [virtualRows, focusedRowKey])
  // This component explicitly opts out of the compiler above and reads the
  // mutable instance directly on every render, without memoizing its output.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => listRef.current,
    getItemKey: useCallback((index: number) => virtualRows[index].key, [virtualRows]),
    estimateSize: useCallback((index: number) => virtualRows[index].kind === "category" ? 31 : 138, [virtualRows]),
    overscan: 5,
    initialOffset: session.scrollTop,
    initialMeasurementsCache: session.virtualSnapshot?.measurements,
    // New pages can add dishes to earlier categories. Keep the current recipe
    // in view when those insertions move its index; never follow new items.
    anchorTo: "end",
    followOnAppend: false,
    rangeExtractor: useCallback(range => includeFocusedNeighbours(defaultRangeExtractor(range), focusedIndex, range.count), [focusedIndex]),
  })

  const saveVirtualPosition = useCallback((container: HTMLDivElement) => {
    if (useDishListSession.getState().generation !== generation || restoreScrollRef.current !== null) return
    const anchor = virtualizer.getVirtualItemForOffset(container.scrollTop)
    saveDishListSession(today, {
      scrollTop: container.scrollTop,
      virtualSnapshot: {
        width: container.clientWidth,
        measurements: virtualizer.takeSnapshot(),
        anchor: anchor ? { key: String(anchor.key), offset: container.scrollTop - anchor.start } : null,
      },
    })
  }, [generation, today, virtualizer])

  useLayoutEffect(() => {
    const container = listRef.current
    if (container) return () => saveVirtualPosition(container)
  }, [saveVirtualPosition])

  useLayoutEffect(() => {
    const container = listRef.current
    if (!container) return
    const updateWidth = () => {
      if (container.clientWidth <= 0 || virtualRows.length === 0) return
      if (measuredWidthRef.current === null) measuredWidthRef.current = container.clientWidth
      if (container.clientWidth === measuredWidthRef.current) return
      const item = virtualizer.getVirtualItemForOffset(container.scrollTop)
      const savedAnchor = restoreScrollRef.current !== null ? session.virtualSnapshot?.anchor : null
      const key = savedAnchor?.key ?? item?.key
      const offset = savedAnchor?.offset ?? (item ? container.scrollTop - item.start : 0)
      measuredWidthRef.current = container.clientWidth
      // Off-screen rows also need fresh estimates after text reflows.
      // Surviving DOM nodes keep the same ref, so clearing the cache alone
      // would leave their new heights unmeasured until another resize.
      resetDishMeasurements(virtualizer, Array.from(container.querySelectorAll<HTMLDivElement>(".kitchen-dishes-virtual-row"), node => ({ index: Number(node.dataset.index), size: node.offsetHeight })))
      const index = virtualizer.options.count > 0 ? virtualRows.findIndex(row => row.key === key) : -1
      if (index >= 0) {
        const start = virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0
        if (restoreScrollRef.current !== null) restoreScrollRef.current = start + offset
        virtualizer.scrollToOffset(start + offset)
      }
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [session.virtualSnapshot, virtualizer, virtualRows])

  const paramsKey = JSON.stringify(queryParams)
  const previousParamsRef = useRef(paramsKey)
  useLayoutEffect(() => {
    if (location.pathname === "/dishes") leavingListRef.current = false
  }, [location.key, location.pathname])

  useLayoutEffect(() => {
    const container = listRef.current
    if (!container) return
    if (previousParamsRef.current !== paramsKey) {
      previousParamsRef.current = paramsKey
      restoreScrollRef.current = null
      virtualizer.scrollToOffset(0)
      saveDishListSession(today, { scrollTop: 0, virtualSnapshot: undefined })
    }
    if (!dishesData || location.pathname !== "/dishes" || leavingListRef.current) return
    const restore = () => {
      const target = restoreScrollRef.current
      if (target === null) return
      if (restoreListScroll(container, target, hasNextPage)) {
        restoreScrollRef.current = null
        saveDishListSession(today, { scrollTop: container.scrollTop })
      }
      else if (container.clientHeight > 0 && !isError) loadMore()
    }
    restore()
    if (restoreScrollRef.current === null) return
    // 懒加载/隐藏页签可能还没有可用高度；不要把这一帧的 0 当作恢复成功。
    const observer = new ResizeObserver(restore)
    observer.observe(container)
    return () => observer.disconnect()
  }, [dishesData, hasNextPage, isError, loadMore, location.pathname, paramsKey, today, virtualizer])

  useEffect(() => {
    saveDishListSession(today, { search, activeCategory, activeTaste })
  }, [today, search, activeCategory, activeTaste])

  useLayoutEffect(() => {
    if (sidebarRef.current) sidebarRef.current.scrollLeft = session.categoryScrollTop
    if (tasteRef.current) tasteRef.current.scrollLeft = session.tasteScrollLeft
  }, [session])

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current
    const selected = sidebar?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    if (!sidebar || !selected) return
    const bounds = sidebar.getBoundingClientRect()
    const itemBounds = selected.getBoundingClientRect()
    if (itemBounds.left < bounds.left) sidebar.scrollLeft += itemBounds.left - bounds.left
    else if (itemBounds.right > bounds.right) sidebar.scrollLeft += itemBounds.right - bounds.right
  }, [activeCategory, sidebarCats])

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

  function scrollToCategory(cat: string) {
    restoreScrollRef.current = null
    setActiveCategory(cat)
    setSearch("")
    if (listRef.current) listRef.current.scrollTop = 0
    saveDishListSession(today, { scrollTop: 0 })
  }

  function openDish(path: string) {
    // 点击后立即保存，避免路由卸载前尚未派发的 scroll 事件漏掉最后一段位置。
    const container = listRef.current
    if (container && restoreScrollRef.current === null) {
      saveVirtualPosition(container)
    }
    leavingListRef.current = true
    navigate(path)
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

  return (
    <div className="kitchen-dishes animate-fadeUp flex flex-col h-full">
      <PageHeader
        title="菜品"
        meta={`共 ${enabledTotal} 道`}
        actions={
          <>
            <HeaderIconButton onClick={() => navigate(isLoggedIn ? "/admin/dashboard" : "/admin/login")} aria-label="管理设置"><Settings size={18} strokeWidth={1.7} /></HeaderIconButton>
            <HeaderIconButton className="kitchen-dishes-add" onClick={() => navigate(isLoggedIn ? "/admin/dishes/new" : "/admin/login")} aria-label="添加菜品"><Plus size={20} strokeWidth={1.7} /></HeaderIconButton>
          </>
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
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="kitchen-dishes-search">
              <Search size={17} aria-hidden="true" />
              <input type="search" aria-label="搜索菜品或配料" placeholder="写个名字，翻翻看…" value={search}
                onChange={(e) => { setSearch(e.target.value); setActiveCategory("全部"); setActiveTaste("全部") }} />
              {search && <button type="button" aria-label="清空搜索" onClick={() => setSearch("")}><X size={17} /></button>}
            </div>
            <HorizontalFilterStrip scrollRef={sidebarRef} role="navigation" label="菜品分类" itemCount={sidebarCats.length}
              onScroll={(event) => saveDishListSession(today, { categoryScrollTop: event.currentTarget.scrollLeft })}
              className="kitchen-category-tabs scrollbar-none">
              {sidebarCats.map((cat) => <button key={cat} onClick={() => scrollToCategory(cat)} aria-current={activeCategory === cat ? "true" : undefined}>
                {cat}
              </button>)}
            </HorizontalFilterStrip>
            <HorizontalFilterStrip
              scrollRef={tasteRef}
              itemCount={tastes.length}
              onScroll={(event) => saveDishListSession(today, { tasteScrollLeft: event.currentTarget.scrollLeft })}
              className="kitchen-taste-tabs scrollbar-none"
              role="group"
              label="按口味筛选"
            >
              {tastes.map((t) => (
                <button
                  key={t}
                  onClick={() => setActiveTaste(t)}
                  className={activeTaste === t ? "is-active" : undefined}
                  aria-pressed={activeTaste === t}
                >
                  {t}
                </button>
              ))}
            </HorizontalFilterStrip>

            {isError && dishesData && !isFetchNextPageError && (
              <div role="alert" className="py-3 text-center text-[12px] text-text2">
                <span>更新菜品失败，正在显示上次加载的内容</span>
                <button onClick={() => void refetch()} disabled={isFetching} className="ml-2 px-2 py-1 text-primary disabled:opacity-50">重试</button>
              </div>
            )}
            <div
              ref={listRef}
              role="region"
              aria-label="菜品列表"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.altKey || event.metaKey || virtualRows.length === 0) return
                if (event.key === "Home" || event.key === "End") {
                  event.preventDefault()
                  virtualizer.scrollToIndex(event.key === "Home" ? 0 : virtualRows.length - 1, { align: event.key === "Home" ? "start" : "end" })
                }
              }}
              onFocusCapture={(event) => setFocusedRowKey((event.target as HTMLElement).closest<HTMLElement>("[data-virtual-key]")?.dataset.virtualKey ?? null)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedRowKey(null)
              }}
              onScroll={(event) => {
                if (location.pathname === "/dishes" && !leavingListRef.current && restoreScrollRef.current === null && event.currentTarget.clientHeight > 0) {
                  saveDishListSession(today, { scrollTop: event.currentTarget.scrollTop })
                }
              }}
              className="kitchen-dishes-scroll flex-1 overflow-y-auto scrollbar-none overscroll-y-contain"
            >
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
              ) : (
                <div className="kitchen-dishes-virtual" data-loaded-count={allDishes.length} style={{ height: virtualizer.getTotalSize() }}>
                  {virtualizer.getVirtualItems().map(item => {
                    const row = virtualRows[item.index]
                    return <div key={row.key} data-index={item.index} data-virtual-key={row.key}
                      ref={virtualizer.measureElement} className="kitchen-dishes-virtual-row"
                      style={{ transform: `translateY(${item.start}px)` }}>
                      {row.kind === "category" ? (
                        <div className="kitchen-dish-group" role="heading" aria-level={2}>
                          <span aria-hidden="true">「</span>{row.category}
                          <span className="text-[11px] text-text3 font-normal">{categoryCountMap.get(row.category) ?? row.count}道</span>
                        </div>
                      ) : (
                        <DishRow
                          dish={row.dish}
                          alternate={row.alternate}
                          isFav={favIds.has(row.dish.id)}
                          isLunch={todayLunchIds.has(row.dish.id)}
                          isDinner={todayDinnerIds.has(row.dish.id)}
                          lunchPending={pendingMeals.has(mealSelectionKey({ meal_date: today, meal_type: "lunch", dish_id: row.dish.id }))}
                          dinnerPending={pendingMeals.has(mealSelectionKey({ meal_date: today, meal_type: "dinner", dish_id: row.dish.id }))}
                          mealDisabled={mealStateUnavailable}
                          onToggleFav={() => favMut.mutate({ id: row.dish.id, active: favIds.has(row.dish.id) })}
                          onToggleMeal={(mt) => toggleMeal(row.dish, mt)}
                          onClick={() => openDish(`/dishes/${row.dish.id}`)}
                        />
                      )}
                    </div>
                  })}
                </div>
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
        <div className="kitchen-picked-bar">
          <span className="kitchen-picked-count">{totalPicked}</span>
          <div className="kitchen-picked-label"><strong>已选 {totalPicked} 道</strong><span>午 {todayLunchIds.size} · 晚 {todayDinnerIds.size}</span></div>
          <button onClick={() => setShowTodayModal(true)}>今日菜单 <ArrowRight size={16} /></button>
        </div>
      )}

      {showTodayModal && location.pathname === "/dishes" && (
        <KitchenTodayMenu
          today={today}
          lunchRecords={todayLunchRecords}
          dinnerRecords={todayDinnerRecords}
          dishes={dishMap}
          pendingMeals={pendingMeals}
          unavailable={mealStateUnavailable}
          refreshing={recordsFetching}
          onRetry={() => { void reloadRecords() }}
          onClose={() => setShowTodayModal(false)}
          onCancel={cancelMeal}
          onOpenDish={(record) => {
            setShowTodayModal(false)
            openDish(`/dishes/${record.dish_id}?record_id=${record.id}`)
          }}
        />
      )}
    </div>
  )
}

interface DishRowProps {
  dish: Dish
  alternate: boolean
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

function DishRow({ dish, alternate, isFav, isLunch, isDinner, lunchPending, dinnerPending, mealDisabled, onToggleFav, onToggleMeal, onClick }: DishRowProps) {
  return (
    <article className={`kitchen-dish-row${alternate ? " is-alternate" : ""}`}>
      <button type="button" onClick={onClick} className="kitchen-dish-photo" aria-label={`查看${dish.name}的做法`}>
        <DishImage dish={dish} className="w-full h-full" emojiSize="text-[28px]" />
      </button>
      <div className="kitchen-dish-info">
        <div className="kitchen-dish-title">
          <button type="button" onClick={onClick}>{dish.name}</button>
          <button type="button" onClick={onToggleFav} aria-label={`${isFav ? "取消收藏" : "收藏"}${dish.name}`} aria-pressed={isFav} className={`kitchen-dish-heart${isFav ? " is-active" : ""}`}><Heart size={17} fill={isFav ? "currentColor" : "none"} strokeWidth={1.5} /></button>
        </div>
        <div className="kitchen-dish-meta">
          <span>{dish.category}</span>
          {dish.cook_time > 0 && <span>{dish.cook_time}分钟</span>}
          <span className={`kitchen-dish-difficulty ${diffColor(dish.difficulty)}`}>火候·{diffLabel(dish.difficulty)}</span>
          {dish.taste && <span className="kitchen-dish-taste">{dish.taste}</span>}
        </div>
        <div className="kitchen-dish-meals">
          <MealToggle active={isLunch} pending={lunchPending} disabled={mealDisabled} label="午餐" onClick={() => onToggleMeal("lunch")} color="primary" />
          <MealToggle active={isDinner} pending={dinnerPending} disabled={mealDisabled} label="晚餐" onClick={() => onToggleMeal("dinner")} color="mint" />
        </div>
      </div>
    </article>
  )
}

interface MealToggleProps {
  active: boolean
  pending: boolean
  disabled: boolean
  label: string
  onClick: () => void
  color: "primary" | "mint"
}

function MealToggle({ active, pending, disabled, label, onClick, color }: MealToggleProps) {
  return <button type="button" onClick={onClick} disabled={disabled || pending} aria-busy={pending} aria-pressed={active}
    aria-label={pending ? `正在更新${label}计划` : `${active ? "已选" : "选择"}${label}`}
    className={`kitchen-meal-toggle is-${color}${active ? " is-active" : ""}`}>
    {pending ? <LoaderCircle size={13} className="animate-spin" /> : active ? <Check size={13} /> : <Plus size={13} />}
    {label}
  </button>
}
