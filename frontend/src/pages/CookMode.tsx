import { useState, useMemo, useCallback, useEffect } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { isAxiosError } from "axios"
import { dishesApi, recordsApi, getUploadErrorMessage } from "@/api"
import { asArray } from "@/lib/utils"
import { parsePortionScale, portionLabel, scaleAmount } from "@/lib/portions"
import { createCookTimer, pauseCookTimer, startCookTimer, syncCookTimer } from "@/lib/cookTimer"
import ConsumeInventorySheet from "@/components/ConsumeInventorySheet"
import type { Dish, DishIngredient } from "@/types"
import toast from "react-hot-toast"

interface Step { text: string; time?: number }

function isValidId(value: string | null | undefined) {
  return !!value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
}

function CookModeMessage({ message, onBack, onRetry, retrying = false, loading = false }: {
  message: string
  onBack: () => void
  onRetry?: () => void
  retrying?: boolean
  loading?: boolean
}) {
  return (
    <div className="bg-[#1A1A2E] min-h-screen text-white flex flex-col items-center justify-center gap-4 px-5 text-center">
      <p role={loading ? "status" : "alert"}>{message}</p>
      {onRetry && <button onClick={onRetry} disabled={retrying} className="px-5 py-2 rounded-full bg-primary text-white disabled:opacity-50">{retrying ? "重试中..." : "重试"}</button>}
      <button onClick={onBack} className="px-5 py-2 rounded-full bg-white/10 text-white">返回菜品列表</button>
    </div>
  )
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function parseSteps(value: unknown): Step[] {
  return asArray(value).map((item) => {
    if (typeof item === "string") return { text: item }
    if (typeof item === "object" && item !== null) return { text: (item as Record<string, unknown>).text as string || "", time: (item as Record<string, unknown>).time as number | undefined }
    return { text: String(item) }
  })
}

export default function CookMode() {
  const { id } = useParams()
  const [params] = useSearchParams()
  return <CookModeContent key={`${id}:${params.get("record_id") || ""}:${params.get("portion_scale") || ""}`} />
}

function CookModeContent() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const dishId = Number(id)
  const validDishId = isValidId(id)
  const recordParam = searchParams.get("record_id")
  const validRecordParam = recordParam === null || isValidId(recordParam)
  const requestedRecordId = validRecordParam ? Number(recordParam) : 0

  const dishQuery = useQuery({
    queryKey: ["dish", dishId],
    queryFn: () => dishesApi.get(dishId),
    enabled: validDishId,
    retry: false,
  })
  const dish = dishQuery.data

  const suggestedMeal: "lunch" | "dinner" = new Date().getHours() < 15 ? "lunch" : "dinner"
  const dishHistoryQuery = useQuery({
    queryKey: ["dish-records", dishId],
    queryFn: () => dishesApi.records(dishId),
    enabled: validDishId && validRecordParam && !requestedRecordId,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
  const { data: dishRecordsData, isFetchedAfterMount: dishHistoryFetched, isSuccess: dishHistoryReady, isError: dishHistoryError } = dishHistoryQuery
  const todayPlans = (dishRecordsData?.records || []).filter((r) => r.status === "planned" && r.meal_date === todayKey())
  const inferredPlan = todayPlans.find((r) => r.meal_type === suggestedMeal) || todayPlans[0]
  const recordId = requestedRecordId || inferredPlan?.id || 0
  // 普通菜谱入口也接续今天已保存的计划；固定到 URL，完成后的列表刷新不会丢失这份计划。
  useEffect(() => {
    if (validDishId && validRecordParam && !requestedRecordId && dishHistoryFetched && dishHistoryReady && inferredPlan?.id) {
      navigate(`/dishes/${dishId}/cook?record_id=${inferredPlan.id}`, { replace: true })
    }
  }, [dishId, validDishId, validRecordParam, requestedRecordId, dishHistoryFetched, dishHistoryReady, inferredPlan?.id, navigate])
  const recordQuery = useQuery({
    queryKey: ["record", recordId],
    queryFn: () => recordsApi.get(recordId),
    enabled: validDishId && validRecordParam && recordId > 0,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
  const { data: linkedRecord, isFetchedAfterMount: recordFetched, isError: recordError } = recordQuery
  const historyUnavailable = !requestedRecordId && (dishHistoryError || (dishHistoryReady && !dishRecordsData))
  const recordMismatch = recordId > 0 && recordQuery.isSuccess && (!linkedRecord || linkedRecord.dish_id !== dishId)
  const planError = historyUnavailable || (recordId > 0 && recordError) || recordMismatch
  const planReady = validRecordParam && !planError && (!requestedRecordId ? dishHistoryFetched && dishHistoryReady && dishHistoryQuery.fetchStatus === "idle" : true)
    && (recordId > 0 ? recordFetched && recordQuery.isSuccess && recordQuery.fetchStatus === "idle" && linkedRecord?.dish_id === dishId : true)
  const [planResolved, setPlanResolved] = useState(false)
  // 首次核实计划并固定 URL 后才开放步骤；之后刷新失败不再收起已进入的做菜界面。
  if (!planResolved && validDishId && planReady && (requestedRecordId > 0 || !inferredPlan)) {
    setPlanResolved(true)
  }
  const planRetrying = (!requestedRecordId && dishHistoryQuery.isFetching) || (recordId > 0 && recordQuery.isFetching)
  const portionScale = parsePortionScale(linkedRecord?.portion_scale ?? searchParams.get("portion_scale"))
  const canComplete = planReady && (!linkedRecord || (linkedRecord.status === "planned" && linkedRecord.meal_date <= todayKey()))

  function retryPlan() {
    if (!requestedRecordId) void dishHistoryQuery.refetch()
    if (recordId > 0) void recordQuery.refetch()
  }

  const steps = useMemo(() => dish ? parseSteps(dish.steps) : [], [dish])
  const [currentStep, setCurrentStep] = useState(0)
  const [timer, setTimer] = useState(() => createCookTimer(0))
  useEffect(() => {
    if (timer.status !== "running") return
    let active = true
    // 回调可能因切后台或锁屏延迟，始终按截止时间重算，而不是按回调次数扣秒。
    const sync = () => {
      if (active) setTimer((state) => syncCookTimer(state, Date.now()))
    }
    const interval = window.setInterval(sync, 250)
    document.addEventListener("visibilitychange", sync)
    window.addEventListener("focus", sync)
    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", sync)
      window.removeEventListener("focus", sync)
    }
  }, [timer.status, timer.deadlineMs])
  useEffect(() => {
    if (timer.status === "elapsed") toast("时间到！确认这一步完成后再继续", { icon: "⏰" })
  }, [timer.status])
  useEffect(() => () => {
    if ("speechSynthesis" in window) speechSynthesis.cancel()
  }, [])

  // 最后一步做完：给出"记为午餐/晚餐"，记完接着弹扣库存
  const [finished, setFinished] = useState(false)
  const [consumeDish, setConsumeDish] = useState<Dish | null>(null)
  const [consumedScale, setConsumedScale] = useState(1)
  const [consumedRecordId, setConsumedRecordId] = useState(0)
  const qc = useQueryClient()
  const recordMut = useMutation({
    mutationFn: (mealType: "lunch" | "dinner") => {
      if (!dish || !canComplete) throw new Error("请先确认用餐计划已读取成功，再记录吃过。")
      return linkedRecord
        ? recordsApi.update(linkedRecord.id, { status: "completed" })
        : recordsApi.create({ dish_id: dishId, dish_name: dish.name, meal_type: mealType, meal_date: todayKey(), status: "completed", portion_scale: portionScale })
    },
    onSuccess: (record) => {
      toast.success("已记为吃过，做菜辛苦啦！")
      for (const key of ["records", "stats", "achievements", "dish-records", "shopping-list", "report", "favorites", "photo-wall", "admin"]) {
        qc.invalidateQueries({ queryKey: [key] })
      }
      qc.setQueryData(["record", record.id], record)
      setConsumedScale(record.portion_scale)
      setConsumedRecordId(record.id)
      if (dish) setConsumeDish(dish)
    },
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "记录失败")),
  })

  const stepTime = steps[currentStep]?.time || 0
  const totalMs = createCookTimer(stepTime * 60_000).totalMs

  const speakStep = useCallback(() => {
    if ("speechSynthesis" in window && steps[currentStep]) {
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(steps[currentStep].text)
      u.lang = "zh-CN"; u.rate = 0.9
      speechSynthesis.speak(u)
      toast("🔊 正在播报当前步骤")
    }
  }, [steps, currentStep])

  function toggleTimer() {
    if (totalMs <= 0) return
    const now = Date.now()
    setTimer((state) => state.status === "running"
      ? pauseCookTimer(state, now)
      : startCookTimer(state.status === "idle" ? createCookTimer(totalMs) : state, now))
  }

  function goToStep(idx: number) {
    setTimer(createCookTimer((steps[idx]?.time || 0) * 60_000))
    if ("speechSynthesis" in window) speechSynthesis.cancel()
    setCurrentStep(idx)
  }

  function finishStep() {
    if (currentStep < steps.length - 1) goToStep(currentStep + 1)
    else {
      setTimer(createCookTimer(totalMs))
      if ("speechSynthesis" in window) speechSynthesis.cancel()
      setFinished(true)
    }
  }

  const backToDishes = () => navigate("/dishes", { replace: true })
  if (!validDishId) return <CookModeMessage message="菜谱链接无效，请从菜品列表重新打开。" onBack={backToDishes} />
  if (!validRecordParam) return <CookModeMessage message="计划链接无效，请重新打开这份用餐计划。" onBack={backToDishes} />
  if (!dish && (dishQuery.isError || dishQuery.isSuccess)) {
    const notFound = (isAxiosError(dishQuery.error) && dishQuery.error.response?.status === 404) || dishQuery.isSuccess
    return <CookModeMessage message={notFound ? "这道菜不存在或已删除。" : "菜谱暂时无法读取，请重试。"} onBack={backToDishes} onRetry={notFound ? undefined : () => { void dishQuery.refetch() }} retrying={dishQuery.isFetching} />
  }
  // 先处理已经确定的失败，再等待其他请求，避免被另一份数据的加载状态遮住。
  if (recordMismatch || (planError && (!planResolved || (!requestedRecordId && !dishRecordsData) || (recordId > 0 && !linkedRecord)))) {
    return <CookModeMessage message={recordMismatch ? "这份用餐计划与当前菜谱不匹配，请重新打开。" : "这份计划暂时无法读取，请重试。"} onBack={backToDishes} onRetry={recordMismatch ? undefined : retryPlan} retrying={planRetrying} />
  }
  if (!dish || !planResolved || (!requestedRecordId && !dishRecordsData) || (recordId > 0 && !linkedRecord)) {
    return <CookModeMessage message={!dish ? "正在加载菜谱..." : "正在读取用餐计划..."} onBack={backToDishes} loading />
  }

  const step = steps[currentStep]
  const progress = steps.length > 0 ? ((currentStep + 1) / steps.length) * 100 : 0
  const circumference = 2 * Math.PI * 80
  const secondsLeft = Math.ceil((timer.status === "idle" ? totalMs : timer.remainingMs) / 1000)
  const offset = timer.totalMs > 0 ? circumference * (1 - timer.remainingMs / timer.totalMs) : 0
  const timerStatusText = { idle: "准备开始", running: "进行中...", paused: "已暂停", elapsed: "时间到" }[timer.status]
  const timerAction = { idle: "开始计时", running: "暂停计时", paused: "继续计时", elapsed: "重新计时" }[timer.status]
  const ingredients = [...asArray<string | DishIngredient>(dish.ingredients), ...asArray<string | DishIngredient>(dish.seasonings)]
  const meals = linkedRecord ? [linkedRecord.meal_type as "lunch" | "dinner"] : suggestedMeal === "lunch" ? ["lunch", "dinner"] as const : ["dinner", "lunch"] as const

  return (
    <div className="fixed inset-0 z-[300] bg-[#1A1A2E] text-white flex flex-col">
      <div className="flex items-center justify-between gap-3 px-5 py-4 shrink-0">
        <div className="min-w-0">
          <div className="text-lg font-bold truncate">🍳 {dish.name}</div>
          <div className="text-xs text-white/60 mt-1">{portionLabel(portionScale)}{linkedRecord ? ` · ${linkedRecord.meal_date} ${linkedRecord.meal_type === "lunch" ? "午餐" : "晚餐"}` : ""}</div>
        </div>
        <button onClick={() => navigate(-1)} aria-label="退出做菜" className="w-10 h-10 shrink-0 rounded-full bg-white/10 flex items-center justify-center text-lg">✕</button>
      </div>

      {(dishQuery.isError || planError) && (
        <div className="px-5 mb-3 text-sm text-white/70" role="alert">
          {dishQuery.isError && <div className="flex items-center justify-between gap-3"><span>菜谱更新失败，已保留当前步骤。</span><button onClick={() => { void dishQuery.refetch() }} disabled={dishQuery.isFetching} className="shrink-0 px-3 py-2 rounded-full bg-white/10 text-white disabled:opacity-50">{dishQuery.isFetching ? "重试中..." : "重试菜谱"}</button></div>}
          {planError && <div className="flex items-center justify-between gap-3"><span>计划更新失败，重试成功后再记录吃过。</span><button onClick={retryPlan} disabled={planRetrying} className="shrink-0 px-3 py-2 rounded-full bg-white/10 text-white disabled:opacity-50">{planRetrying ? "重试中..." : "重试计划"}</button></div>}
        </div>
      )}

      <div className="px-5 mb-2">
        <div className="h-1 bg-white/10 rounded overflow-hidden">
          <div className="h-full bg-primary rounded transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 text-center">
        {todayPlans.length > 1 && (
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            {todayPlans.map((r) => <button key={r.id} disabled={r.id === recordId} onClick={() => navigate(`/dishes/${dishId}/cook?record_id=${r.id}`, { replace: true })} className={`px-3 py-2 rounded-full ${r.id === recordId ? "bg-primary" : "bg-white/10"}`}>今天{r.meal_type === "lunch" ? "午餐" : "晚餐"} · {portionLabel(r.portion_scale)}</button>)}
          </div>
        )}
        {ingredients.length > 0 && (
          <details className="my-3 mx-auto max-w-[400px] rounded-xl bg-white/5 text-left">
            <summary className="cursor-pointer px-4 py-3 text-sm text-white/80">食材用量 · {portionLabel(portionScale)}</summary>
            <div className="px-4 pb-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs text-white/70">
              {ingredients.map((ing, i) => <div key={i}>{typeof ing === "string" ? ing : `${ing.name} ${scaleAmount(ing.amount || "", portionScale)}`}</div>)}
            </div>
          </details>
        )}
        <div className="flex flex-col items-center justify-center min-h-[250px] py-4">
        <div className="text-sm text-white/50 mb-2">步骤 <span>{currentStep + 1}</span> / <span>{steps.length}</span></div>
        <div className="text-[64px] font-extrabold text-primary leading-none mb-4">{currentStep + 1}</div>
        <div className="text-xl font-semibold leading-relaxed mb-6 max-w-[400px]">{step?.text || "这道菜还没有步骤，做好后可直接记录。"}</div>

        {totalMs > 0 && (
          <div className="relative w-[160px] h-[160px] mb-6">
            <div className="w-[160px] h-[160px] rounded-full border-4 border-white/10 relative flex items-center justify-center">
              <svg viewBox="0 0 168 168" className="absolute inset-[-4px]" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="84" cy="84" r="80" fill="none" stroke="#E8734A" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={circumference} strokeDashoffset={offset} style={{ transition: "stroke-dashoffset .5s ease" }} />
              </svg>
              <div>
                <div role="timer" aria-label="剩余时间" className={`text-4xl font-extrabold tracking-wider ${timer.status === "elapsed" ? "animate-countdown-pulse" : ""}`}>
                  {`${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
                </div>
                <div role="status" className="text-xs text-white/40 mt-1">{timerStatusText}</div>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 px-4 py-5 shrink-0" style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}>
        <button onClick={() => goToStep(currentStep - 1)} disabled={currentStep === 0} aria-label="上一步" className="w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all disabled:opacity-30">◀◀</button>
        <button onClick={speakStep} aria-label="朗读当前步骤" disabled={!step?.text} className="w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all disabled:opacity-30">🔊</button>
        <button onClick={toggleTimer} disabled={totalMs <= 0} aria-label={totalMs > 0 ? timerAction : "当前步骤无需计时"} title={totalMs > 0 ? timerAction : "当前步骤无需计时"} className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-[28px] bg-primary transition-all active:scale-90 disabled:opacity-30">{timer.status === "running" ? "⏸" : "▶"}</button>
        <button onClick={() => setTimer(createCookTimer(totalMs))} disabled={totalMs <= 0 || timer.status === "idle"} aria-label="重置计时" title="重置计时" className="w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all disabled:opacity-30">↺</button>
        <button
          onClick={finishStep}
          aria-label={currentStep < steps.length - 1 ? "下一步" : "做好了"}
          className="w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all"
        >
          {currentStep < steps.length - 1 ? "⏭" : "✓"}
        </button>
      </div>

      {finished && (
        <div className="absolute inset-0 z-[10] bg-[#1A1A2E]/96 flex flex-col items-center justify-center px-8 py-6 overflow-y-auto text-center">
          <div className="text-[56px] mb-3">🎉</div>
          <div className="text-xl font-extrabold mb-1">{dish.name} 做好了！</div>
          <div className="text-sm text-white/60 mb-8">{portionLabel(portionScale)} · {planError ? "计划暂时无法读取，重试成功后再记录吃过。" : !planReady ? "正在核对用餐计划..." : canComplete ? "确认吃过，再更新冰箱" : linkedRecord?.status === "completed" ? "这份用餐已经记录" : linkedRecord?.status === "cancelled" ? "这份计划已取消，请先在用餐记录中恢复" : "到计划用餐当天，再记为已吃"}</div>
          <div className="w-full max-w-[320px] flex flex-col gap-3">
            {planError && <button onClick={retryPlan} disabled={planRetrying} className="w-full py-3 rounded-full text-[15px] font-bold bg-white/10 text-white disabled:opacity-50">{planRetrying ? "重试中..." : "重试读取计划"}</button>}
            {meals.map((meal, i) => (
              <button
                key={meal}
                disabled={!canComplete || recordMut.isPending || recordMut.isSuccess}
                onClick={() => recordMut.mutate(meal)}
                className={`w-full py-3 rounded-full text-[15px] font-bold transition-all active:scale-96 disabled:opacity-50 ${i === 0 ? "bg-primary text-white" : "bg-white/10 text-white"}`}
              >
                {recordMut.isSuccess ? "已记录" : linkedRecord ? `确认 ${linkedRecord.meal_date.slice(5)} ${meal === "lunch" ? "午餐" : "晚餐"}已吃` : meal === "lunch" ? "🍳 今天午餐已吃" : "🍲 今天晚餐已吃"}
              </button>
            ))}
            <button
              onClick={() => navigate(-1)}
              className="w-full py-2.5 text-sm font-semibold text-white/60"
            >
              {recordMut.isSuccess || !canComplete ? "返回" : "先不记录，返回"}
            </button>
          </div>
        </div>
      )}
      {/* 做菜模式是 z-[300] 的全屏层，扣库存弹层要盖在它上面；关掉后回到菜品详情 */}
      <ConsumeInventorySheet dish={consumeDish} recordId={consumedRecordId} portionScale={consumedScale} onClose={() => navigate(-1)} zIndexClass="z-[320]" />
    </div>
  )
}
