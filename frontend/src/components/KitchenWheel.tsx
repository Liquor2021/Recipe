import { useId, useImperativeHandle, useMemo, useRef, useState } from "react"
import type { Ref } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw, Scissors } from "lucide-react"
import { dishesApi } from "@/api"
import { gsap, motionDuration, useGSAP } from "@/lib/gsap"
import type { Dish } from "@/types"
import "@/styles/kitchen-wheel.css"

export interface KitchenWheelHandle {
  spin: () => void
}

interface KitchenWheelProps {
  ref?: Ref<KitchenWheelHandle>
  theme: "day" | "night"
  active: boolean
  onPick: (dish: Dish) => void
}

const WHEEL_SIZE = 240
const WHEEL_CENTER = WHEEL_SIZE / 2
const WHEEL_RADIUS = WHEEL_CENTER - 1

function pointAt(angle: number) {
  const radians = angle * Math.PI / 180
  return [WHEEL_CENTER + WHEEL_RADIUS * Math.cos(radians), WHEEL_CENTER + WHEEL_RADIUS * Math.sin(radians)]
}

function sectorPath(index: number, count: number) {
  const angle = 360 / count
  const start = pointAt(index * angle - 90)
  const end = pointAt((index + 1) * angle - 90)
  return `M ${WHEEL_CENTER} ${WHEEL_CENTER} L ${start.join(" ")} A ${WHEEL_RADIUS} ${WHEEL_RADIUS} 0 ${angle > 180 ? 1 : 0} 1 ${end.join(" ")} Z`
}

export default function KitchenWheel({ ref, theme, active, onPick }: KitchenWheelProps) {
  const headingId = useId()
  const descriptionId = useId()
  const wheelRef = useRef<HTMLDivElement>(null)
  const spinLock = useRef(false)
  const rotation = useRef(0)
  const [spinning, setSpinning] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [lastActive, setLastActive] = useState(active)
  // 主布局保留首页实例；离开后停止旋转，再回来仍可重新开始。
  if (lastActive !== active) {
    setLastActive(active)
    if (!active && spinning) setSpinning(false)
  }

  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["dishes", "wheel", "notebook"],
    queryFn: () => dishesApi.list({ enabled: "true", pageSize: "8", sort: "random", recommend: "1" }),
    enabled: active && !spinning,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  // 后端在严格忌口过滤后可能返回 items: null。
  const dishes = useMemo(() => (data?.items ?? []).slice(0, 8), [data])
  const selectedDish = dishes.find((dish) => dish.id === selectedId)
  const busy = spinning || isFetching

  useGSAP(() => {
    const wheel = wheelRef.current
    if (!wheel) return
    gsap.set(wheel, { rotation: rotation.current, transformOrigin: "50% 50%" })
    return () => {
      gsap.killTweensOf(wheel)
      spinLock.current = false
    }
  }, { dependencies: [active], revertOnUpdate: true, scope: wheelRef })

  function spin() {
    const wheel = wheelRef.current
    if (!active || spinLock.current || busy || !wheel || dishes.length === 0) return
    spinLock.current = true
    setSpinning(true)
    setSelectedId(null)
    const selectedIndex = Math.floor(Math.random() * dishes.length)
    const selected = dishes[selectedIndex]
    // 每个扇区从十二点方向开始顺时针排；停下时把中线对齐顶端书签。
    const segment = 360 / dishes.length
    const stopWithinTurn = (360 - (selectedIndex + 0.5) * segment) % 360
    const start = Number(gsap.getProperty(wheel, "rotation")) || 0
    const target = Math.floor(start / 360) * 360 + 360 * 5 + stopWithinTurn
    rotation.current = target
    gsap.to(wheel, {
      rotation: target,
      duration: motionDuration(3),
      ease: "power4.out",
      overwrite: true,
      onComplete: () => {
        spinLock.current = false
        setSpinning(false)
        setSelectedId(selected.id)
        onPick(selected)
      },
    })
  }

  function changeBatch() {
    if (!active || spinLock.current || busy) return
    setSelectedId(null)
    rotation.current = 0
    if (wheelRef.current) gsap.set(wheelRef.current, { rotation: 0 })
    void refetch()
  }

  useImperativeHandle(ref, () => ({ spin }))

  const status = isFetching
    ? "正在挑选这一页的菜…"
    : isError
      ? dishes.length ? "换批失败，可以继续转或再试一次。" : "转盘菜品没有加载出来，请点换一批重试。"
      : dishes.length === 0 && !isPending
        ? "暂时没有可推荐的菜，先去菜品页看看。"
        : spinning
          ? "转一转，好菜马上出锅…"
          : selectedDish
            ? `转到了${selectedDish.name}，今天就吃这道。`
            : `从今天的 ${dishes.length} 道里转一个，中意就吃它。`

  return (
    <section className="kitchen-wheel-section" data-wheel-theme={theme} aria-labelledby={headingId}>
      <div className="kitchen-section-heading">
        <h2 id={headingId}>「转一转」</h2>
        <button type="button" className="kitchen-text-button" aria-label="更换转盘菜品" disabled={busy || !active} onClick={changeBatch}>
          <RefreshCw size={14} aria-hidden="true" />{isFetching ? "挑选中" : "换一批"}
        </button>
      </div>
      <div className="kitchen-paper-wheel">
        <Scissors className="kitchen-wheel-scissors" size={14} strokeWidth={1.3} aria-hidden="true" />
        <div className="kitchen-paper-wheel-disc" ref={wheelRef} aria-hidden="true">
          <svg viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`} focusable="false">
            {dishes.length <= 1 && <circle cx={WHEEL_CENTER} cy={WHEEL_CENTER} r={WHEEL_RADIUS} className="kitchen-wheel-paper paper-0" />}
            {dishes.map((dish, index) => {
              const angle = (index + 0.5) * 360 / dishes.length - 90
              const reverse = angle > 90 && angle < 270
              const label = dish.name.length > 7 ? `${dish.name.slice(0, 6)}…` : dish.name
              return (
                <g key={dish.id}>
                  {dishes.length > 1 && <path d={sectorPath(index, dishes.length)} className={`kitchen-wheel-paper paper-${index % 4}`} />}
                  <g transform={`translate(${WHEEL_CENTER} ${WHEEL_CENTER}) rotate(${angle})`}>
                    <text
                      x={76}
                      y={0}
                      transform={reverse ? "rotate(180 76 0)" : undefined}
                      textAnchor="middle"
                      dominantBaseline="central"
                      className="kitchen-wheel-dish-label"
                      textLength={label.length > 5 ? 70 : undefined}
                      lengthAdjust="spacingAndGlyphs"
                    >{label}</text>
                  </g>
                </g>
              )
            })}
          </svg>
        </div>
        {Array.from({ length: 8 }, (_, index) => (
          <span key={index} className="kitchen-wheel-red-dot" style={{ transform: `translate(-50%, -50%) rotate(${index * 45}deg) translateY(-122px)` }} aria-hidden="true" />
        ))}
        <span className="kitchen-wheel-bookmark" aria-hidden="true" />
        <button
          type="button"
          className="kitchen-wheel-seal"
          aria-label="开始转盘"
          aria-describedby={descriptionId}
          aria-busy={spinning}
          disabled={busy || !active || dishes.length === 0}
          onClick={spin}
        ><span>{spinning ? "…" : "转"}</span></button>
      </div>
      <p className="kitchen-paper-wheel-caption" id={descriptionId} role="status" aria-live="polite">{status}</p>
      <ul className="sr-only" aria-label="本轮转盘菜品">{dishes.map((dish) => <li key={dish.id}>{dish.name}</li>)}</ul>
    </section>
  )
}
