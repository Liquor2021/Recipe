import { useState, useMemo, useCallback, useEffect } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { dishesApi, recordsApi, getUploadErrorMessage } from "@/api"
import { asArray } from "@/lib/utils"
import { parsePortionScale, portionLabel, scaleAmount } from "@/lib/portions"
import { createCookTimer, pauseCookTimer, startCookTimer, syncCookTimer } from "@/lib/cookTimer"
import ConsumeInventorySheet from "@/components/ConsumeInventorySheet"
import type { Dish, DishIngredient } from "@/types"
import toast from "react-hot-toast"

interface Step { text: string; time?: number }

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
  const requestedRecordId = Number(searchParams.get("record_id")) || 0

  const { data: dish } = useQuery({
    queryKey: ["dish", dishId],
    queryFn: () => dishesApi.get(dishId),
    enabled: !!dishId,
  })

  const suggestedMeal: "lunch" | "dinner" = new Date().getHours() < 15 ? "lunch" : "dinner"
  const { data: dishRecordsData, isFetchedAfterMount: dishHistoryFetched, isSuccess: dishHistoryReady, isError: dishHistoryError } = useQuery({
    queryKey: ["dish-records", dishId],
    queryFn: () => dishesApi.records(dishId),
    enabled: !!dishId && !requestedRecordId,
    staleTime: 0,
    refetchOnMount: "always",
  })
  const todayPlans = (dishRecordsData?.records || []).filter((r) => r.status === "planned" && r.meal_date === todayKey())
  const inferredPlan = todayPlans.find((r) => r.meal_type === suggestedMeal) || todayPlans[0]
  const recordId = requestedRecordId || inferredPlan?.id || 0
  // 普通菜谱入口也接续今天已保存的计划；固定到 URL，完成后的列表刷新不会丢失这份计划。
  useEffect(() => {
    if (!requestedRecordId && dishHistoryFetched && dishHistoryReady && inferredPlan?.id) {
      navigate(`/dishes/${dishId}/cook?record_id=${inferredPlan.id}`, { replace: true })
    }
  }, [dishId, requestedRecordId, dishHistoryFetched, dishHistoryReady, inferredPlan?.id, navigate])
  const { data: linkedRecord, isFetchedAfterMount: recordFetched, isError: recordError } = useQuery({
    queryKey: ["record", recordId],
    queryFn: () => recordsApi.get(recordId),
    enabled: recordId > 0,
    staleTime: 0,
  })
  const portionScale = parsePortionScale(linkedRecord?.portion_scale ?? searchParams.get("portion_scale"))
  const canComplete = !linkedRecord || (linkedRecord.status === "planned" && linkedRecord.meal_date <= todayKey())

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
    mutationFn: (mealType: "lunch" | "dinner") =>
      linkedRecord
        ? recordsApi.update(linkedRecord.id, { status: "completed" })
        : recordsApi.create({ dish_id: dishId, dish_name: dish?.name || "", meal_type: mealType, meal_date: todayKey(), status: "completed", portion_scale: portionScale }),
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

  if (!dish || (!requestedRecordId && !dishHistoryError && (!dishHistoryFetched || !dishHistoryReady)) || (recordId > 0 && !recordError && !recordFetched)) return <div className="bg-[#1A1A2E] min-h-screen text-white flex items-center justify-center">加载中...</div>
  if ((!requestedRecordId && dishHistoryError) || (recordId > 0 && (recordError || !linkedRecord || linkedRecord.dish_id !== dishId))) return (
    <div className="bg-[#1A1A2E] min-h-screen text-white flex flex-col items-center justify-center gap-4 px-5 text-center">
      <p>这份计划暂时无法读取，请返回重试。</p>
      <button onClick={() => navigate(-1)} className="px-5 py-2 rounded-full bg-primary text-white">返回</button>
    </div>
  )

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
          <div className="text-sm text-white/60 mb-8">{portionLabel(portionScale)} · {canComplete ? "确认吃过，再更新冰箱" : linkedRecord?.status === "completed" ? "这份用餐已经记录" : linkedRecord?.status === "cancelled" ? "这份计划已取消，请先在用餐记录中恢复" : "到计划用餐当天，再记为已吃"}</div>
          <div className="w-full max-w-[320px] flex flex-col gap-3">
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
