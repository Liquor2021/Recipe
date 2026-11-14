import { useState, useEffect, useRef, useMemo } from "react"
import { createPortal } from "react-dom"
import { useLocation, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { pickApi, dishesApi, recordsApi, dayRatingApi, fridgeApi, getUploadErrorMessage } from "@/api"
import type { Dish } from "@/types"
import DishImage from "@/components/DishImage"
import { useAuthStore } from "@/store/useAuthStore"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import { launchConfetti } from "@/lib/confetti"
import { isCurrentMoodChoice, savedHomeMood, selectedHomeMood } from "@/lib/homeMood"
import type { HomeMood, HomeMoodChoice } from "@/lib/homeMood"
import { getMealSelectionRecord, getMealSelectionRequest, hasPendingMealSelection, mealSelectionKey, mealSelectionMutationKey, pendingMealSelectionKey, reconcileMealSelection } from "@/lib/mealSelection"
import type { MealSelectionRequest } from "@/lib/mealSelection"
import toast from "react-hot-toast"
import { ArrowRight, Check, ChefHat, Clock3, LoaderCircle, Moon, RefreshCw, Scissors, Settings, Soup, Sun, Utensils, X } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
import LedgerHomeNote from "@/components/LedgerHomeNote"
import HomeOccasionNote from "@/components/HomeOccasionNote"
import TodayMenuNote from "@/components/TodayMenuNote"
import KitchenWheel from "@/components/KitchenWheel"
import type { KitchenWheelHandle } from "@/components/KitchenWheel"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import "@/styles/kitchen-fonts.css"
import "@/styles/kitchen-home.css"

const moods: Array<{ key: HomeMood; emoji: string; label: string }> = [
  { key: "happy", emoji: "😊", label: "开心" },
  { key: "tired", emoji: "😫", label: "疲惫" },
  { key: "lazy", emoji: "😌", label: "想偷懒" },
  { key: "spicy", emoji: "🤤", label: "想吃辣" },
  { key: "healthy", emoji: "🌿", label: "想养生" },
]

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 6) return "夜深了"
  if (h < 11) return "早上好"
  if (h < 14) return "中午好"
  if (h < 18) return "下午好"
  return "晚上好"
}

function diffLabel(d: string) { return d === "easy" ? "简单" : d === "medium" ? "中等" : "困难" }
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
}

export default function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const theme = useKitchenTheme((s) => s.theme)
  const toggleTheme = useKitchenTheme((s) => s.toggleTheme)
  const [wheelResult, setWheelResult] = useState<Dish | null>(null)
  const wheelHandle = useRef<KitchenWheelHandle>(null)
  // 首页保留挂载，离开时关闭抽签票据。
  const [panelPath, setPanelPath] = useState(location.pathname)
  if (panelPath !== location.pathname) {
    setPanelPath(location.pathname)
    if (wheelResult) setWheelResult(null)
  }
  const qc = useQueryClient()
  const mealEditLocks = useRef(new Set<string>())
  const pendingMealKeys = useMutationState({
    filters: { mutationKey: mealSelectionMutationKey, status: "pending" },
    select: mutation => pendingMealSelectionKey(mutation.state.variables),
  })
  const pendingMeals = new Set(pendingMealKeys)
  const [todayKey, setTodayKey] = useState(dateKey)
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const appName = useAppInfoStore((s) => s.appName)

  // 今日推荐/换一个/猜你喜欢与转盘都是推荐位：后端按家庭忌口处理
  // （strict 剔除命中忌口的菜，avoid 把它们排到最后）
  const { data: dishesData, isPending: dishesLoading, isError: dishesError, refetch: reloadDishes } = useQuery({
    queryKey: ["dishes", "enabled"],
    queryFn: () => dishesApi.list({ enabled: "true", pageSize: "20", sort: "sort_order", order: "asc", recommend: "1" }),
  })
  const { data: recordsData, isPending: recordsPending, isError: recordsError, fetchStatus: recordsFetchStatus, refetch: reloadRecords } = useQuery({
    queryKey: ["records", "today", todayKey],
    queryFn: () => recordsApi.list({ pageSize: "100", date_from: todayKey, date_to: todayKey }),
  })
  const { data: todayRating } = useQuery({
    queryKey: ["day-rating", todayKey],
    queryFn: () => dayRatingApi.get(todayKey),
  })
  const { data: urgentItems } = useQuery({
    queryKey: ["fridge-urgent"],
    queryFn: () => fridgeApi.urgent(),
  })

  const [pickedRec, setPickedRec] = useState<Dish | null>(null)
  const [moodChoice, setMoodChoice] = useState<HomeMoodChoice | null>(null)
  const latestMoodChoice = useRef<HomeMoodChoice | null>(null)
  const moodRequestId = useRef(0)
  const selectedMood = selectedHomeMood(moodChoice, todayKey, todayRating?.home_mood)
  const [blindRevealed, setBlindRevealed] = useState(false)
  // 临期提醒关闭状态按天持久化：当天关过就不再打扰，第二天重新出现
  const [urgentDismissedDate, setUrgentDismissedDate] = useState(() => {
    try { return localStorage.getItem("urgent_dismissed_date") } catch { return null }
  })
  const urgentDismissed = urgentDismissedDate === todayKey
  const confettiRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refreshDate = () => {
      setTodayKey(dateKey())
      window.clearTimeout(timer)
      const now = new Date()
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      timer = window.setTimeout(refreshDate, midnight.getTime() - now.getTime() + 50)
    }
    refreshDate()
    window.addEventListener("focus", refreshDate)
    document.addEventListener("visibilitychange", refreshDate)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", refreshDate)
      document.removeEventListener("visibilitychange", refreshDate)
    }
  }, [])

  const dishes = dishesData?.items || []

  // 临期提醒文案：已过期与快过期分开说（过去只要有一批过期，就把快过期的也说成"已过期"）；
  // 同一食材多批只列一次名字，过期的排前面
  const urgentSummary = useMemo(() => {
    const items = urgentItems || []
    const today = new Date(todayKey + "T00:00:00").getTime()
    const isExpired = (expiry: string) => !!expiry && new Date(expiry + "T00:00:00").getTime() < today
    const expired = items.filter((i) => isExpired(i.expiry_date))
    const soon = items.filter((i) => !isExpired(i.expiry_date))
    const parts = [expired.length > 0 ? `${expired.length} 批已过期` : "", soon.length > 0 ? `${soon.length} 批快过期` : ""].filter(Boolean)
    const names = [...new Set([...expired, ...soon].map((i) => i.item_name))]
    return {
      title: `冰箱里 ${parts.join("、")}${expired.length > 0 ? "，尽快处理" : ""}`,
      names: names.slice(0, 3).join("、") + (names.length > 3 ? " 等" : ""),
      filter: expired.length > 0 ? "expired" : "soon",
    }
  }, [urgentItems, todayKey])
  const todayRecords = recordsData?.items || []
  const mealStateUnavailable = !recordsData || recordsError || recordsFetchStatus === "paused"
  const currentRec = pickedRec || dishes[0] || null

  const { data: moodPick, isFetching: moodFetching, isError: moodError, refetch: reloadMoodPick } = useQuery({
    queryKey: ["pick", "mood", selectedMood],
    queryFn: () => pickApi.mood(selectedMood!),
    enabled: !!selectedMood,
  })

  useEffect(() => {
    if (moodPick?.dishes?.length) {
      qc.invalidateQueries({ queryKey: ["achievements"] })
    }
  }, [moodPick, qc])

  const blindBoxMut = useMutation({
    mutationFn: () => pickApi.blindBox(),
  })

  const recordMut = useMutation({
    mutationKey: mealSelectionMutationKey,
    retry: false,
    mutationFn: ({ cancelRecordId, ...data }: MealSelectionRequest) => cancelRecordId !== undefined
      ? recordsApi.update(cancelRecordId, { status: "cancelled" })
      : recordsApi.create({ ...data, status: "planned" }),
    onSuccess: (_saved, request) => {
      if (request.cancelRecordId !== undefined) {
        toast.success("已取消计划")
      } else {
        setWheelResult((current) => current?.id === request.dish_id ? null : current)
        toast.success("已加入今日计划")
        launchConfetti(confettiRef.current)
      }
    },
    onError: (err: unknown, request) => {
      toast.error(getUploadErrorMessage(err, request.cancelRecordId !== undefined ? "取消失败" : "加入计划失败"))
    },
    onSettled: async (saved, _error, request) => {
      try {
        // 与菜品页共用写入锁；成功或超时后都等权威读取完成，不能用旧状态再次提交。
        await Promise.all([
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

  const homeMoodMut = useMutation({
    // Serial writes ensure a slower earlier click cannot overwrite the last choice on the server.
    scope: { id: "home-mood-save" },
    mutationFn: (request: HomeMoodChoice) => dayRatingApi.updateHomeMood({ meal_date: request.date, home_mood: request.mood }),
    onMutate: (request) => qc.cancelQueries({ queryKey: ["day-rating", request.date], exact: true }),
    onSuccess: async (saved, request) => {
      await qc.cancelQueries({ queryKey: ["day-rating", request.date], exact: true })
      qc.setQueryData(["day-rating", request.date], saved)
      qc.invalidateQueries({ queryKey: ["day-ratings"] })
      qc.invalidateQueries({ queryKey: ["photo-wall"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      if (!isCurrentMoodChoice(latestMoodChoice.current, request, dateKey())) return
      latestMoodChoice.current = null
      setMoodChoice(null)
    },
    onError: async (_error, request) => {
      // A timed-out response may still have saved. Read back before rolling the selection back.
      let confirmedMood: HomeMood | null = null
      try {
        await qc.cancelQueries({ queryKey: ["day-rating", request.date], exact: true })
        const saved = await qc.fetchQuery({
          queryKey: ["day-rating", request.date], queryFn: () => dayRatingApi.get(request.date), staleTime: 0, retry: false,
        })
        confirmedMood = savedHomeMood(saved.home_mood)
      } catch { /* Retain the last known server snapshot when the network is unavailable. */ }
      if (!isCurrentMoodChoice(latestMoodChoice.current, request, dateKey())) return
      latestMoodChoice.current = null
      setMoodChoice(null)
      if (confirmedMood === request.mood) {
        qc.invalidateQueries({ queryKey: ["day-ratings"] })
        qc.invalidateQueries({ queryKey: ["photo-wall"] })
        qc.invalidateQueries({ queryKey: ["achievements"] })
      } else {
        toast.error("心情保存失败，请重试")
      }
    },
  })

  function resetBlindBox() {
    blindBoxMut.reset()
    setBlindRevealed(false)
  }

  function handleWheelPick(dish: Dish) {
    setPickedRec(dish)
    setWheelResult(dish)
    qc.invalidateQueries({ queryKey: ["achievements"] })
  }

  function recordForDish(dish: Dish, mealType: "lunch" | "dinner") {
    const date = dateKey()
    if (date !== todayKey) { setTodayKey(date); return }
    if (mealStateUnavailable) return
    const selection = { dish_id: dish.id, dish_name: dish.name, meal_type: mealType, meal_date: date }
    const request = getMealSelectionRequest(todayRecords, selection)
    if (!request) return // 已吃记录不能从推荐入口取消。
    const key = mealSelectionKey(request)
    if (mealEditLocks.current.has(key) || hasPendingMealSelection(qc, request)) return
    mealEditLocks.current.add(key)
    recordMut.mutate(request)
  }

  function handleMoodPick(mood: HomeMood) {
    const date = dateKey()
    setTodayKey(date)
    if (latestMoodChoice.current?.date === date && latestMoodChoice.current.mood === mood) return
    const request = { id: ++moodRequestId.current, date, mood }
    latestMoodChoice.current = request
    setMoodChoice(request)
    homeMoodMut.mutate(request)
  }

  function handleBlindBox() {
    if (blindRevealed || blindBoxMut.isPending) return
    blindBoxMut.mutate(undefined, {
      onSuccess: () => {
        setBlindRevealed(true)
        qc.invalidateQueries({ queryKey: ["achievements"] })
      },
      onError: () => toast.error("暂无盲盒菜品"),
    })
  }

  function changeRecommend() {
    if (dishes.length === 0) return
    const idx = currentRec ? dishes.findIndex((d) => d.id === currentRec.id) : -1
    const next = dishes[(idx + 1) % dishes.length]
    setPickedRec(next)
  }

  const moodDishes = moodPick?.dishes
  const currentMood = moods.find((mood) => mood.key === selectedMood)
  const date = new Date(todayKey + "T12:00:00")
  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日 · 周${"日一二三四五六"[date.getDay()]}`
  const brand = appName
  const mealButtons = (dish: Dish) => (
    <div className="kitchen-meal-actions">
      {(["lunch", "dinner"] as const).map((meal) => {
        const selection = { dish_id: dish.id, meal_type: meal, meal_date: todayKey }
        const record = getMealSelectionRecord(todayRecords, selection)
        const added = !!record
        const completed = record?.status === "completed"
        const pending = pendingMeals.has(mealSelectionKey(selection))
        const label = meal === "lunch" ? "午餐" : "晚餐"
        const Icon = pending ? LoaderCircle : added ? Check : meal === "lunch" ? Utensils : Soup
        return (
          <button
            key={meal}
            type="button"
            className={`kitchen-button ${meal === "lunch" ? "kitchen-button-ink" : "kitchen-button-outline"}`}
            disabled={mealStateUnavailable || pending || completed}
            aria-pressed={added}
            aria-busy={pending}
            aria-label={`${dish.name}，${pending ? "正在更新" + label + "计划" : completed ? label + "已吃" : added ? "取消" + label + "计划" : "加入" + label}`}
            title={completed ? "已标记吃过，请到记录页撤销已吃" : added ? `已加入今日${label}，再点即可取消计划` : undefined}
            onClick={() => recordForDish(dish, meal)}
          >
            <Icon size={17} strokeWidth={1.6} className={pending ? "animate-spin" : undefined} aria-hidden="true" />
            {pending ? "更新中…" : completed ? `${label}已吃` : `${added ? "取消" : "加入"}${label}`}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="kitchen-home">
      {createPortal(
        <div ref={confettiRef} className="fixed inset-0 z-50 pointer-events-none overflow-hidden" />,
        document.body,
      )}
      <header className="kitchen-masthead">
        <div className="kitchen-brand">
          <span className="kitchen-seal" aria-hidden="true">灶</span>
          <span title={brand}>{brand}</span>
        </div>
        <div className="kitchen-header-actions">
          <time dateTime={todayKey}>{dateLabel}</time>
          <button
            className="kitchen-icon-button"
            onClick={() => navigate(isLoggedIn ? "/admin/dashboard" : "/admin/login")}
            aria-label="管理设置"
          >
            <Settings size={18} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <main className="kitchen-page">
        <section className="kitchen-greeting" aria-labelledby="kitchen-greeting-title">
          <div className="kitchen-kicker">
            <div className="kitchen-hello">{getGreeting()}，今天也好好吃饭</div>
            <button
              className="kitchen-theme-toggle"
              onClick={toggleTheme}
              aria-label={`切换到${theme === "day" ? "深夜" : "白日"}厨房`}
            >
              {theme === "day" ? <Sun size={13} /> : <Moon size={13} />}
              {theme === "day" ? "白日厨房" : "深夜厨房"}
            </button>
          </div>
          <h1 id="kitchen-greeting-title">
            今天，<span>
              想吃点什么？<svg viewBox="0 0 230 12" preserveAspectRatio="none" aria-hidden="true">
                <path d="M3 7 Q35 2 65 7 T130 6 T190 6 L226 4" />
              </svg>
            </span>
          </h1>
          <span className="kitchen-margin-note" aria-hidden="true">好好吃饭</span>
        </section>

        <HomeOccasionNote today={todayKey} active={location.pathname === "/"} />

        <section className="kitchen-recommendation" aria-labelledby="kitchen-rec-title">
          <div className="kitchen-section-heading">
            <h2 id="kitchen-rec-title">「今日推荐」</h2>
            <button className="kitchen-text-button" onClick={changeRecommend} disabled={dishes.length < 2}>
              <RefreshCw size={14} /> 换一道
            </button>
          </div>
          {currentRec ? (
            <article className="kitchen-polaroid">
              <span className="kitchen-tape" aria-hidden="true" />
              <button
                className="kitchen-photo-link"
                aria-label={`查看${currentRec.name}的做法`}
                onClick={() => navigate(`/dishes/${currentRec.id}`)}
              >
                <DishImage dish={currentRec} full className="kitchen-food-photo" emojiSize="text-6xl" />
                <span className="kitchen-daily-stamp" aria-hidden="true">今日<br />推荐</span>
                <span className="kitchen-photo-caption">查看做法 <ArrowRight size={13} /></span>
              </button>
              <div className="kitchen-recipe-note">
                <button className="kitchen-dish-name" onClick={() => navigate(`/dishes/${currentRec.id}`)}>
                  <h3>{currentRec.name}</h3>
                </button>
                <div className="kitchen-recipe-meta">
                  <span>{currentRec.category || "家常菜"}</span>
                  <span><Clock3 size={12} />{currentRec.cook_time} 分钟</span>
                  <span className="kitchen-difficulty">{diffLabel(currentRec.difficulty)}</span>
                </div>
                {mealButtons(currentRec)}
              </div>
            </article>
          ) : (
            <div className="kitchen-empty" role="status">
              <ChefHat size={28} />
              <p>{dishesLoading ? "正在翻开今天的菜谱…" : dishesError ? "菜谱暂时没加载出来" : "今天还没有可推荐的菜"}</p>
              <button className="kitchen-text-button" onClick={() => dishesError ? reloadDishes() : navigate("/dishes")}>
                {dishesError ? "重新加载" : "去看看菜品"}<ArrowRight size={14} />
              </button>
            </div>
          )}
        </section>

        <TodayMenuNote date={todayKey} records={todayRecords} mood={todayRating?.mood} pending={recordsPending} error={recordsError} onRetry={() => void reloadRecords()}>
          <div className="kitchen-mood-row">
            <span id="kitchen-mood-label">跟着心情吃</span>
            <div className="kitchen-mood-options" role="group" aria-labelledby="kitchen-mood-label">
              {moods.map((m) => (
                <button
                  type="button"
                  key={m.key}
                  aria-label={`${m.label}，推荐菜品`}
                  title={m.label}
                  aria-pressed={selectedMood === m.key}
                  onClick={() => handleMoodPick(m.key)}
                >
                  <span aria-hidden="true">{m.emoji}</span>
                </button>
              ))}
            </div>
          </div>
          {currentMood && <div className="kitchen-mood-suggestions" role="region" aria-label="心情推荐" aria-busy={moodFetching}>
            <div className="kitchen-mood-summary">
              <span>{currentMood.label} · 试试这两道</span>
              <button type="button" className="kitchen-text-button" disabled={moodFetching} onClick={() => void reloadMoodPick()}>
                <RefreshCw size={12} aria-hidden="true" />{moodFetching ? "正在找菜…" : moodError ? "重试" : "换一批"}
              </button>
            </div>
            <div className="kitchen-mood-dishes" aria-live="polite">
              {moodError ? <span role="status">心情推荐暂时没加载出来，点重试再看看。</span> : moodDishes?.length ? moodDishes.slice(0, 2).map((dish) => (
                <button type="button" key={dish.id} aria-label={`查看${dish.name}的做法，${dish.cook_time}分钟`} onClick={() => navigate(`/dishes/${dish.id}`)}>
                  <strong>{dish.name}</strong><small>{dish.cook_time} 分钟</small><ArrowRight size={12} aria-hidden="true" />
                </button>
              )) : <span role="status">{moodFetching ? "正在按心情翻菜谱…" : "暂时没有合适的菜，换个心情试试吧。"}</span>}
            </div>
          </div>}
        </TodayMenuNote>

        {urgentItems && urgentItems.length > 0 && !urgentDismissed && (
          <aside className="kitchen-urgent">
            <button onClick={() => navigate(`/fridge?filter=${urgentSummary.filter}`)}>
              <strong>{urgentSummary.title}</strong>
              <span>
                {urgentSummary.names} · {urgentSummary.filter === "expired" ? "先检查并处理" : "看看能做什么"} <ArrowRight size={12} />
              </span>
            </button>
            <button
              className="kitchen-icon-button"
              aria-label="关闭提醒"
              onClick={() => {
                setUrgentDismissedDate(todayKey)
                try {
                  localStorage.setItem("urgent_dismissed_date", todayKey)
                } catch { /* 隐私模式下不持久化关闭状态。 */ }
              }}
            >
              <X size={17} />
            </button>
          </aside>
        )}

        <KitchenWheel
          ref={wheelHandle}
          theme={theme}
          active={location.pathname === "/"}
          onPick={handleWheelPick}
        />

        <section className="kitchen-blind-section" aria-labelledby="kitchen-blind-title">
          <div className="kitchen-section-heading">
            <h2 id="kitchen-blind-title">「惊喜盲盒」</h2>
            {blindRevealed && <button className="kitchen-text-button" onClick={resetBlindBox}>
              <RefreshCw size={14} /> 再拆一份
            </button>}
          </div>
          <div className={`kitchen-blind-paper ${blindRevealed ? "is-open" : ""}`}>
            <span className="kitchen-blind-tape tape-left" aria-hidden="true" />
            <span className="kitchen-blind-tape tape-right" aria-hidden="true" />
            {blindRevealed && blindBoxMut.data ? (
              <div className="kitchen-blind-reveal" aria-live="polite">
                <button className="kitchen-blind-dish" onClick={() => navigate(`/dishes/${blindBoxMut.data.dish.id}`)}>
                  <DishImage dish={blindBoxMut.data.dish} className="kitchen-blind-thumb" />
                  <span><small>今日拆到</small><strong>{blindBoxMut.data.dish.name}</strong>
                    <span>{blindBoxMut.data.dish.category} · {blindBoxMut.data.dish.cook_time} 分钟</span>
                  </span>
                </button>
                {mealButtons(blindBoxMut.data.dish)}
                <button className="kitchen-text-button kitchen-blind-recipe" onClick={() => navigate(`/dishes/${blindBoxMut.data.dish.id}`)}>
                  看看这道菜怎么做 <ArrowRight size={14} />
                </button>
              </div>
            ) : (
              <button className="kitchen-blind-lid" onClick={handleBlindBox} disabled={blindBoxMut.isPending} aria-busy={blindBoxMut.isPending}>
                <span className="kitchen-question-stamp" aria-hidden="true">?</span>
                <strong>{blindBoxMut.isPending ? "正在准备惊喜…" : "今日惊喜"}</strong>
                <span>点我拆开 · 随机一道菜</span>
              </button>
            )}
          </div>
        </section>

        <LedgerHomeNote month={todayKey.slice(0, 7)} active={location.pathname === "/"} />
        <button className="kitchen-tomorrow-note" onClick={() => navigate("/tomorrow")}>
          <Moon size={22} strokeWidth={1.4} />
          <span><strong>明天吃什么</strong><small>提前写好，明天少一点纠结</small></span>
          <ArrowRight size={16} />
        </button>

        <footer className="kitchen-page-footer">
          <span>一餐一饭，都是生活。</span>
          <span>{appName} · {date.getFullYear()}</span>
        </footer>
      </main>

      {wheelResult && location.pathname === "/" && (
        <KitchenSheet
          theme={theme}
          title="转盘开出的菜单"
          className="kitchen-ticket-sheet"
          hideHeading
          onClose={() => setWheelResult(null)}
        >
          <div className="kitchen-ticket-cut" aria-hidden="true"><span /><Scissors size={16} strokeWidth={1.4} /><span /></div>
          <div className="kitchen-ticket-body">
            <button className="kitchen-ticket-photo" aria-label={`查看${wheelResult.name}的做法`}
              onClick={() => { setWheelResult(null); navigate(`/dishes/${wheelResult.id}`) }}>
              <DishImage dish={wheelResult} className="kitchen-ticket-image" />
            </button>
            <div className="kitchen-ticket-recipe">
              <p>转盘开出</p>
              <h3>{wheelResult.name}</h3>
              <div>{wheelResult.category} · {wheelResult.cook_time} 分钟</div>
              <span className="kitchen-difficulty">{diffLabel(wheelResult.difficulty)}</span>
            </div>
            <aside className="kitchen-ticket-stub" aria-hidden="true"><span>今日加菜</span><b>中</b></aside>
          </div>
          {mealButtons(wheelResult)}
          <div className="kitchen-ticket-footer">
            <button className="kitchen-text-button" onClick={() => { setWheelResult(null); wheelHandle.current?.spin() }} disabled={recordMut.isPending}>
              <RefreshCw size={14} /> 再转一次
            </button>
            <button className="kitchen-text-button" onClick={() => { setWheelResult(null); navigate(`/dishes/${wheelResult.id}`) }}>
              看看怎么做 <ArrowRight size={14} />
            </button>
          </div>
        </KitchenSheet>
      )}
    </div>
  )
}
