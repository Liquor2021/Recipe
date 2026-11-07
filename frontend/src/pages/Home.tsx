import { useState, useEffect, useRef, useCallback, useMemo } from "react"
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
import { gsap, motionDuration, scrollToElement, useGSAP } from "@/lib/gsap"
import toast from "react-hot-toast"
import { ArrowRight, Check, ChefHat, Clock3, Dices, Gift, Moon, RefreshCw, Settings, Soup, Sun, Utensils, X } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
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
  const [playPanel, setPlayPanel] = useState<"wheel" | "blind" | null>(null)
  // Home stays mounted between tabs; changing routes must dismiss its portal.
  const [panelPath, setPanelPath] = useState(location.pathname)
  if (panelPath !== location.pathname) {
    setPanelPath(location.pathname)
    if (playPanel) setPlayPanel(null)
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
  const { data: wheelData } = useQuery({
    queryKey: ["dishes", "wheel"],
    queryFn: () => dishesApi.list({ enabled: "true", pageSize: "12", sort: "random", recommend: "1" }),
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
  const [spinning, setSpinning] = useState(false)
  const [wheelResult, setWheelResult] = useState<Dish | null>(null)
  // 临期提醒关闭状态按天持久化：当天关过就不再打扰，第二天重新出现
  const [urgentDismissedDate, setUrgentDismissedDate] = useState(() => {
    try { return localStorage.getItem("urgent_dismissed_date") } catch { return null }
  })
  const urgentDismissed = urgentDismissedDate === todayKey
  const wheelDegRef = useRef(0)
  const wheelHighlightRef = useRef(-1)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wheelRef = useRef<HTMLDivElement>(null)
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
  const wheelDishes = useMemo(() => wheelData?.items || [], [wheelData])

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
    onSuccess: () => {
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

  const drawWheel = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || wheelDishes.length === 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // 按 devicePixelRatio 放大画布，避免手机高分屏上文字发虚
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const size = 212
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr
      canvas.height = size * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cx = 106, cy = 106, r = 105
    const colors = ["#9B4935", "#7D684E", "#5F7052", "#AA714A", "#76604F", "#536657"]
    const n = wheelDishes.length
    const angle = (2 * Math.PI) / n
    ctx.clearRect(0, 0, size, size)
    const fontSize = n > 12 ? 9 : n > 8 ? 10 : 11
    // 文字沿半径方向从内向外排，超出可用长度的名字截断加省略号
    const textStart = r * 0.26
    const maxChars = Math.max(2, Math.floor((r * 0.66) / fontSize))
    for (let i = 0; i < n; i++) {
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, r, i * angle - Math.PI / 2, (i + 1) * angle - Math.PI / 2)
      ctx.closePath()
      ctx.fillStyle = colors[i % colors.length]
      ctx.fill()
      // 中奖扇区白色高亮
      if (i === wheelHighlightRef.current) {
        ctx.fillStyle = "rgba(255,255,255,.35)"
        ctx.fill()
        ctx.strokeStyle = "#fff"
        ctx.lineWidth = 3
        ctx.stroke()
      }
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(i * angle + angle / 2 - Math.PI / 2)
      ctx.fillStyle = "#fff"
      ctx.font = `bold ${fontSize}px -apple-system, sans-serif`
      ctx.textAlign = "left"
      ctx.textBaseline = "middle"
      ctx.shadowColor = "rgba(0,0,0,.22)"
      ctx.shadowBlur = 3
      let label = wheelDishes[i].name
      if (label.length > maxChars) {
        label = label.slice(0, maxChars - 1) + "…"
      }
      ctx.fillText(label, textStart, 0)
      ctx.restore()
    }
    // 扇区分隔线
    ctx.strokeStyle = "rgba(255,255,255,.85)"
    ctx.lineWidth = 2.5
    for (let i = 0; i < n; i++) {
      const a = i * angle - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r * 0.16, cy + Math.sin(a) * r * 0.16)
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      ctx.stroke()
    }
  }, [wheelDishes])

  useEffect(() => {
    drawWheel()
  }, [drawWheel, playPanel])

  useGSAP(() => {
    if (playPanel !== "wheel" || !wheelRef.current) return
    const wheel = wheelRef.current
    gsap.set(wheel, { rotation: wheelDegRef.current, transformOrigin: "50% 50%" })
    return () => { gsap.killTweensOf(wheel) }
  }, { dependencies: [playPanel], revertOnUpdate: true, scope: wheelRef })

  function spinWheel() {
    if (spinning || wheelDishes.length === 0) return
    setSpinning(true)
    setWheelResult(null)
    const pickIdx = Math.floor(Math.random() * wheelDishes.length)
    const seg = 360 / wheelDishes.length
    const targetWithin = (360 - (pickIdx * seg + seg / 2)) % 360
    const base = wheelDegRef.current - (wheelDegRef.current % 360)
    const nextRotation = base + 360 * 6 + targetWithin
    wheelDegRef.current = nextRotation
    wheelHighlightRef.current = -1
    drawWheel()

    gsap.to(wheelRef.current, {
      rotation: nextRotation,
      duration: motionDuration(3.2),
      ease: "power4.out",
      overwrite: true,
      onComplete: () => {
        setSpinning(false)
        const pick = wheelDishes[pickIdx]
        wheelHighlightRef.current = pickIdx
        drawWheel()
        setPickedRec(pick)
        setRecQuote("")
        setRecMeal(null)
        setWheelResult(pick)
        qc.invalidateQueries({ queryKey: ["achievements"] })
      },
    })
  }

  function resetBlindBox() {
    blindBoxMut.reset()
    setBlindRevealed(false)
  }

  function closePlayPanel() {
    gsap.killTweensOf(wheelRef.current)
    setSpinning(false)
    setPlayPanel(null)
    setWheelResult(null)
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
    closePlayPanel()
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

        <div className="kitchen-play-strip" aria-label="更多选菜方式">
          <button onClick={() => { setWheelResult(null); setSpinning(false); setPlayPanel("wheel") }}>
            <Dices size={23} strokeWidth={1.3} />
            <span><strong>转一转</strong><small>纠结交给它</small></span>
          </button>
          <button onClick={() => setPlayPanel("blind")}>
            <Gift size={23} strokeWidth={1.3} />
            <span><strong>惊喜盲盒</strong><small>随机一点鲜</small></span>
          </button>
          <button onClick={() => navigate("/tomorrow")}>
            <Moon size={23} strokeWidth={1.3} />
            <span><strong>明天吃什么</strong><small>提前安排好</small></span>
          </button>
        </div>

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

      {playPanel && location.pathname === "/" && (
        <KitchenSheet
          theme={theme}
          title={playPanel === "wheel" ? "「转一转」" : "「惊喜盲盒」"}
          onClose={closePlayPanel}
        >
          {playPanel === "wheel" ? (
            <div className="kitchen-play-content">
              <p className="kitchen-sheet-intro">今天吃什么，让小转盘来拿主意。</p>
              <div className={`kitchen-wheel-wrap ${wheelResult ? "has-result" : ""}`}>
                <div className="kitchen-wheel-pointer" />
                <div ref={wheelRef} className="kitchen-wheel">
                  <canvas ref={canvasRef} aria-label="随机选菜转盘" />
                </div>
                <button
                  className="kitchen-wheel-spin"
                  onClick={spinWheel}
                  disabled={spinning || wheelDishes.length === 0}
                  aria-label="开始转盘"
                >
                  {spinning ? "…" : "转"}
                </button>
              </div>
              {wheelResult ? (
                <div className="kitchen-wheel-result" aria-live="polite">
                  <button
                    className="kitchen-result-dish"
                    onClick={() => { closePlayPanel(); navigate(`/dishes/${wheelResult.id}`) }}
                  >
                    <DishImage dish={wheelResult} className="kitchen-recipe-thumb" />
                    <span>
                      <strong>{wheelResult.name}</strong>
                      <small>{wheelResult.cook_time} 分钟 · 查看做法</small>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                  {mealButtons(wheelResult)}
                  <button
                    className="kitchen-text-button kitchen-another"
                    onClick={() => { setWheelResult(null); spinWheel() }}
                  >
                    再转一次 <RefreshCw size={14} />
                  </button>
                </div>
              ) : (
                <p className="kitchen-wheel-hint" role="status">
                  {spinning ? "好菜马上出锅…" : wheelDishes.length ? "轻轻一点，把纠结放下。" : "暂时没有可参与转盘的菜品"}
                </p>
              )}
            </div>
          ) : (
            <div className="kitchen-play-content">
              {blindRevealed && blindBoxMut.data ? (
                <div className="kitchen-blind-result">
                  <button
                    className="kitchen-blind-photo"
                    onClick={() => { closePlayPanel(); navigate(`/dishes/${blindBoxMut.data.dish.id}`) }}
                    aria-label={`查看${blindBoxMut.data.dish.name}的做法`}
                  >
                    <DishImage dish={blindBoxMut.data.dish} full className="kitchen-food-photo" />
                  </button>
                  <h3>{blindBoxMut.data.dish.name}</h3>
                  <p>
                    {blindBoxMut.data.dish.category} · {blindBoxMut.data.dish.cook_time} 分钟 · {diffLabel(blindBoxMut.data.dish.difficulty)}
                  </p>
                  {mealButtons(blindBoxMut.data.dish)}
                  <button className="kitchen-text-button kitchen-another" onClick={resetBlindBox}>
                    再拆一份 <RefreshCw size={14} />
                  </button>
                </div>
              ) : (
                <button className="kitchen-blind-envelope" onClick={handleBlindBox} disabled={blindBoxMut.isPending}>
                  <span className="kitchen-envelope-seal"><Gift size={34} strokeWidth={1.3} /></span>
                  <strong>{blindBoxMut.isPending ? "正在准备惊喜…" : "给今天留一点惊喜"}</strong>
                  <span>点一下，拆开今日菜单</span>
                </button>
              )}
            </div>
          )}
        </KitchenSheet>
      )}
    </div>
  )
}
