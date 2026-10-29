import { useState, useRef, useMemo, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { dishesApi, recordsApi, getUploadErrorMessage } from "@/api"
import { asArray } from "@/lib/utils"
import ConsumeInventorySheet from "@/components/ConsumeInventorySheet"
import type { Dish } from "@/types"
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
  const navigate = useNavigate()
  const dishId = Number(id)

  const { data: dish } = useQuery({
    queryKey: ["dish", dishId],
    queryFn: () => dishesApi.get(dishId),
    enabled: !!dishId,
  })

  const steps = useMemo(() => dish ? parseSteps(dish.steps) : [], [dish])
  const [currentStep, setCurrentStep] = useState(0)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [activeTotal, setActiveTotal] = useState(0)
  const [paused, setPaused] = useState(true)
  const [timerActive, setTimerActive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 最后一步做完：给出"记为午餐/晚餐"，记完接着弹扣库存
  const [finished, setFinished] = useState(false)
  const [consumeDish, setConsumeDish] = useState<Dish | null>(null)
  const qc = useQueryClient()
  const suggestedMeal: "lunch" | "dinner" = new Date().getHours() < 15 ? "lunch" : "dinner"
  const recordMut = useMutation({
    mutationFn: (mealType: "lunch" | "dinner") =>
      recordsApi.create({ dish_id: dishId, dish_name: dish?.name || "", meal_type: mealType, meal_date: todayKey() }),
    onSuccess: () => {
      toast.success("❤ 已记录！")
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      qc.invalidateQueries({ queryKey: ["dish-records", dishId] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      if (dish) setConsumeDish(dish)
    },
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "记录失败")),
  })

  const stepTime = steps[currentStep]?.time || 0
  const totalSec = stepTime * 60

  const speakStep = useCallback(() => {
    if ("speechSynthesis" in window && steps[currentStep]) {
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(steps[currentStep].text)
      u.lang = "zh-CN"; u.rate = 0.9
      speechSynthesis.speak(u)
      toast("🔊 正在播报当前步骤")
    }
  }, [steps, currentStep])

  function startTimer(secs: number) {
    if (timerRef.current) clearInterval(timerRef.current)
    // 计时开始时就确定是不是最后一步：时间到后最后一步直接进入"做好了"
    const isLastStep = currentStep >= steps.length - 1
    setActiveTotal(secs)
    setSecondsLeft(secs)
    setPaused(false)
    setTimerActive(true)
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!)
          timerRef.current = null
          setPaused(true)
          setTimerActive(false)
          toast("⏰ 时间到！该进行下一步了~", { icon: "⏰" })
          speakStep()
          setTimeout(() => {
            if (isLastStep) setFinished(true)
            else setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1))
          }, 3000)
          return 0
        }
        return s - 1
      })
    }, 1000)
  }

  function toggleTimer() {
    if (paused) {
      const secs = secondsLeft > 0 ? secondsLeft : totalSec
      if (secs > 0) startTimer(secs)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setPaused(true)
      setTimerActive(false)
    }
  }

  function goToStep(idx: number) {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setPaused(true)
    setTimerActive(false)
    setSecondsLeft(0)
    setCurrentStep(idx)
  }

  if (!dish) return <div className="bg-[#1A1A2E] min-h-screen text-white flex items-center justify-center">加载中...</div>

  const step = steps[currentStep]
  const progress = steps.length > 0 ? ((currentStep + 1) / steps.length) * 100 : 0
  const circumference = 2 * Math.PI * 80
  const currentTotal = activeTotal || totalSec
  const offset = currentTotal > 0 ? circumference * (1 - secondsLeft / currentTotal) : 0

  return (
    <div className="fixed inset-0 z-[300] bg-[#1A1A2E] text-white flex flex-col">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="text-lg font-bold">🍳 {dish.name}</div>
        <button onClick={() => { if (timerRef.current) clearInterval(timerRef.current); navigate(-1) }} className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-lg">✕</button>
      </div>

      <div className="px-5 mb-2">
        <div className="h-1 bg-white/10 rounded overflow-hidden">
          <div className="h-full bg-primary rounded transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-10 text-center">
        <div className="text-sm text-white/50 mb-2">步骤 <span>{currentStep + 1}</span> / <span>{steps.length}</span></div>
        <div className="text-[64px] font-extrabold text-primary leading-none mb-4">{currentStep + 1}</div>
        <div className="text-xl font-semibold leading-relaxed mb-6 max-w-[400px]">{step?.text}</div>

        {step?.time && step.time > 0 && (
          <div className="relative w-[160px] h-[160px] mb-6">
            <div className="w-[160px] h-[160px] rounded-full border-4 border-white/10 relative flex items-center justify-center">
              <svg viewBox="0 0 168 168" className="absolute inset-[-4px]" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="84" cy="84" r="80" fill="none" stroke="#E8734A" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={circumference} strokeDashoffset={timerActive ? offset : 0} style={{ transition: "stroke-dashoffset .5s ease" }} />
              </svg>
              <div>
                <div className={`text-4xl font-extrabold tracking-wider ${timerActive && secondsLeft <= 0 ? "animate-countdown-pulse" : ""}`}>
                  {!timerActive && secondsLeft === 0 ? `${step.time}:00` : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
                </div>
                <div className="text-xs text-white/40 mt-1">{!timerActive ? "准备开始" : paused ? "已暂停" : "进行中..."}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-5 px-5 py-5" style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}>
        <button onClick={() => currentStep > 0 && goToStep(currentStep - 1)} className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all ${currentStep === 0 ? "opacity-30" : ""}`}>◀◀</button>
        <button onClick={speakStep} className="w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all">🔊</button>
        <button onClick={toggleTimer} className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-[28px] bg-primary transition-all active:scale-90">{paused ? "▶" : "⏸"}</button>
        <button onClick={() => currentStep < steps.length - 1 && goToStep(currentStep + 1)} className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all ${currentStep >= steps.length - 1 ? "opacity-30" : ""}`}>▶▶</button>
        <button
          onClick={() => { if (currentStep < steps.length - 1) goToStep(currentStep + 1); else setFinished(true) }}
          aria-label={currentStep < steps.length - 1 ? "下一步" : "做好了"}
          className="w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-white/10 hover:bg-white/20 transition-all"
        >
          {currentStep < steps.length - 1 ? "⏭" : "✓"}
        </button>
      </div>

      {finished && (
        <div className="absolute inset-0 z-[10] bg-[#1A1A2E]/96 flex flex-col items-center justify-center px-8 text-center">
          <div className="text-[56px] mb-3">🎉</div>
          <div className="text-xl font-extrabold mb-1">{dish.name} 做好了！</div>
          <div className="text-sm text-white/60 mb-8">记一笔，顺便更新冰箱</div>
          <div className="w-full max-w-[320px] flex flex-col gap-3">
            {(suggestedMeal === "lunch" ? (["lunch", "dinner"] as const) : (["dinner", "lunch"] as const)).map((meal, i) => (
              <button
                key={meal}
                disabled={recordMut.isPending || recordMut.isSuccess}
                onClick={() => recordMut.mutate(meal)}
                className={`w-full py-3 rounded-full text-[15px] font-bold transition-all active:scale-96 disabled:opacity-50 ${i === 0 ? "bg-primary text-white" : "bg-white/10 text-white"}`}
              >
                {meal === "lunch" ? "🍳 记为午餐" : "🍲 记为晚餐"}
              </button>
            ))}
            <button
              onClick={() => navigate(-1)}
              className="w-full py-2.5 text-sm font-semibold text-white/60"
            >
              不记了，返回
            </button>
          </div>
        </div>
      )}
      {/* 做菜模式是 z-[300] 的全屏层，扣库存弹层要盖在它上面；关掉后回到菜品详情 */}
      <ConsumeInventorySheet dish={consumeDish} onClose={() => navigate(-1)} zIndexClass="z-[320]" />
    </div>
  )
}
