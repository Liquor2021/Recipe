import { useState, useEffect, useRef, useMemo } from "react"
import { createPortal } from "react-dom"
import { useLocation, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { pickApi, dishesApi, recordsApi, dayRatingApi, fridgeApi, getUploadErrorMessage } from "@/api"
import type { Dish } from "@/types"
import DishImage from "@/components/DishImage"
import { useAuthStore } from "@/store/useAuthStore"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import { launchConfetti } from "@/lib/confetti"
import { isCurrentMoodChoice, savedHomeMood, selectedHomeMood } from "@/lib/homeMood"
import type { HomeMood, HomeMoodChoice } from "@/lib/homeMood"
import { scrollToElement } from "@/lib/gsap"
import toast from "react-hot-toast"
import { ArrowRight, Check, ChefHat, Clock3, Moon, RefreshCw, Scissors, Settings, Soup, Sun, Utensils, X } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
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
  const [todayKey, setTodayKey] = useState(dateKey)
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const appName = useAppInfoStore((s) => s.appName)

  // 今日推荐/换一个/猜你喜欢与转盘都是推荐位：后端按家庭忌口处理
  // （strict 剔除命中忌口的菜，avoid 把它们排到最后）
  const { data: dishesData, isPending: dishesLoading, isError: dishesError, refetch: reloadDishes } = useQuery({
    queryKey: ["dishes", "enabled"],
    queryFn: () => dishesApi.list({ enabled: "true", pageSize: "20", sort: "sort_order", order: "asc", recommend: "1" }),
  })
  const { data: recordsData } = useQuery({
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
  const [recQuote, setRecQuote] = useState<string>("")
  const [recMeal, setRecMeal] = useState<"lunch" | "dinner" | null>(null)
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
  const recCardRef = useRef<HTMLDivElement>(null)

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
  const currentRec = pickedRec || dishes[0] || null

  const { data: moodPick } = useQuery({
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

  // 午/晚餐推荐：触发后把结果写入当前推荐卡并滚动过去
  const pickMealMut = useMutation({
    mutationFn: (meal: "lunch" | "dinner") => (meal === "lunch" ? pickApi.lunch() : pickApi.dinner()),
    onSuccess: (data, meal) => {
      const dish = data?.dishes?.[0]
      if (!dish) {
        toast.error("暂无可推荐的菜品")
        return
      }
      setPickedRec(dish)
      setRecQuote(data.quote || "")
      setRecMeal(meal)
      qc.invalidateQueries({ queryKey: ["achievements"] })
      toast.success(`${meal === "lunch" ? "🍳 午餐" : "🍲 晚餐"}推荐：${dish.name}`)
      requestAnimationFrame(() => scrollToElement(recCardRef.current, { block: "center" }))
    },
    // 显示后端的原因（如 strict 忌口过滤后"没有可推荐的菜品"），不笼统说"稍后再试"
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "推荐失败，稍后再试")),
  })

  const recordMut = useMutation({
    mutationFn: (data: { dish_id: number; dish_name: string; meal_type: string; meal_date: string }) =>
      recordsApi.create({ ...data, status: "planned" }),
    onSuccess: (_saved, request) => {
      setWheelResult((current) => current?.id === request.dish_id ? null : current)
      toast.success("已加入今日计划，吃过后到记录页确认")
      launchConfetti(confettiRef.current)
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      qc.invalidateQueries({ queryKey: ["record"] })
      qc.invalidateQueries({ queryKey: ["dish-records"] })
      qc.invalidateQueries({ queryKey: ["admin", "records"] })
    },
    onError: (err: unknown) => {
      const msg = (err instanceof Error ? err.message : "") || "记录失败"
      toast.error(msg)
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
      const label = moods.find(mood => mood.key === request.mood)?.label || request.mood
      toast.success(`心情：${label}，已保存`)
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
        toast.success(`心情：${moods.find(mood => mood.key === request.mood)?.label || request.mood}，已保存`)
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
    setRecQuote("")
    setRecMeal(null)
    setWheelResult(dish)
    qc.invalidateQueries({ queryKey: ["achievements"] })
  }

  function recordForDish(dish: Dish, mealType: "lunch" | "dinner") {
    const alreadyPicked = todayRecords.some(
      (r) => r.status !== "cancelled" && r.dish_id === dish.id && r.meal_type === mealType && r.meal_date === todayKey
    )
    if (alreadyPicked) {
      toast.error(`${dish.name} 已在今日${mealType === "lunch" ? "午餐" : "晚餐"}中记录过啦~`)
      return
    }
    recordMut.mutate({
      dish_id: dish.id,
      dish_name: dish.name,
      meal_type: mealType,
      meal_date: todayKey,
    })
  }

  function handlePickMeal(mealType: "lunch" | "dinner") {
    if (!currentRec) return
    recordForDish(currentRec, mealType)
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
    setRecQuote("")
    setRecMeal(null)
  }

  const moodDishes = moodPick?.dishes
  const date = new Date(todayKey + "T12:00:00")
  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日 · 周${"日一二三四五六"[date.getDay()]}`
  const brand = appName === "NiniMenu" ? "小灶手账" : appName
  const isPlanned = (dish: Dish, meal: "lunch" | "dinner") => todayRecords.some(
    (r) => r.status !== "cancelled" && r.dish_id === dish.id && r.meal_type === meal && r.meal_date === todayKey
  )

  const mealButtons = (dish: Dish) => (
    <div className="kitchen-meal-actions">
      {(["lunch", "dinner"] as const).map((meal) => {
        const added = isPlanned(dish, meal)
        const Icon = added ? Check : meal === "lunch" ? Utensils : Soup
        return (
          <button
            key={meal}
            className={`kitchen-button ${meal === "lunch" ? "kitchen-button-ink" : "kitchen-button-outline"}`}
            disabled={recordMut.isPending || added}
            onClick={() => dish === currentRec ? handlePickMeal(meal) : recordForDish(dish, meal)}
          >
            <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
            {added ? `已加入${meal === "lunch" ? "午餐" : "晚餐"}` : `加入${meal === "lunch" ? "午餐" : "晚餐"}`}
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

        <section className="kitchen-recommendation" aria-labelledby="kitchen-rec-title">
          <div className="kitchen-section-heading">
            <h2 id="kitchen-rec-title">「今日推荐」</h2>
            <button className="kitchen-text-button" onClick={changeRecommend} disabled={dishes.length < 2}>
              <RefreshCw size={14} /> 换一道
            </button>
          </div>
          {currentRec ? (
            <article className="kitchen-polaroid" ref={recCardRef}>
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
                  {recMeal && <span className="kitchen-meal-mark">{recMeal === "lunch" ? "午餐推荐" : "晚餐推荐"}</span>}
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
          {recQuote && <p className="kitchen-recipe-quote">“{recQuote}”</p>}
        </section>

        <section className="kitchen-moods" aria-labelledby="kitchen-mood-title">
          <div className="kitchen-section-heading">
            <h2 id="kitchen-mood-title">「今天的心情」</h2>
            <span>按心情，找点好吃的</span>
          </div>
          <div className="kitchen-mood-grid">
            {moods.map((m) => (
              <button
                key={m.key}
                className={`kitchen-mood ${selectedMood === m.key ? "is-selected" : ""}`}
                aria-pressed={selectedMood === m.key}
                onClick={() => handleMoodPick(m.key)}
              >
                <span className="kitchen-mood-emoji" aria-hidden="true">{m.emoji}</span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </section>

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

        <button className="kitchen-tomorrow-note" onClick={() => navigate("/tomorrow")}>
          <Moon size={22} strokeWidth={1.4} />
          <span><strong>明天吃什么</strong><small>提前写好，明天少一点纠结</small></span>
          <ArrowRight size={16} />
        </button>

        <section className="kitchen-meal-picks" aria-label="按餐次推荐">
          <button disabled={pickMealMut.isPending} onClick={() => pickMealMut.mutate("lunch")}>
            <Sun size={18} />
            <span>
              <strong>中午吃点好的</strong>
              <small>{pickMealMut.isPending && pickMealMut.variables === "lunch" ? "正在翻菜谱…" : "找一道午餐"}</small>
            </span>
            <ArrowRight size={16} />
          </button>
          <button disabled={pickMealMut.isPending} onClick={() => pickMealMut.mutate("dinner")}>
            <Soup size={18} />
            <span>
              <strong>晚上吃点暖的</strong>
              <small>{pickMealMut.isPending && pickMealMut.variables === "dinner" ? "正在翻菜谱…" : "找一道晚餐"}</small>
            </span>
            <ArrowRight size={16} />
          </button>
        </section>

        {moodDishes && moodDishes.length > 0 && (
          <section className="kitchen-mood-recipes" aria-label="心情推荐">
            <div className="kitchen-section-heading"><h2>「跟着心情吃」</h2></div>
            <div className="kitchen-recipe-list">
              {moodDishes.slice(0, 4).map((d) => (
                <button key={d.id} onClick={() => navigate(`/dishes/${d.id}`)}>
                  <DishImage dish={d} className="kitchen-recipe-thumb" />
                  <span>
                    <strong>{d.name}</strong>
                    <small>{d.category} · {d.cook_time} 分钟</small>
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          </section>
        )}

        <footer className="kitchen-page-footer">
          <span>一餐一饭，都是生活。</span>
          <span>小灶手账 · {date.getFullYear()}</span>
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
