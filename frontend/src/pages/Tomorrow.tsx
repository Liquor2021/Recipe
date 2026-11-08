import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { dishesApi, pickApi, recordsApi } from "@/api"
import type { Dish, MealRecord } from "@/types"
import { launchConfetti } from "@/lib/confetti"
import { readTomorrowDraft, tomorrowPlanBaseline, writeTomorrowDraft } from "@/lib/tomorrowDraft"
import type { TomorrowDraftState, TomorrowProfile } from "@/lib/tomorrowDraft"
import { createTomorrowRequestGate, isMealPlanConflict } from "@/lib/tomorrowRequests"
import { getTomorrow, nextLocalMidnightDelay } from "@/lib/tomorrowDate"
import DishImage from "@/components/DishImage"
import PageHeader from "@/components/PageHeader"
import KitchenSheet from "@/components/KitchenSheet"
import HorizontalFilterStrip from "@/components/HorizontalFilterStrip"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import toast from "react-hot-toast"
import "@/styles/kitchen-tools.css"
import {
  CalendarClock,
  Check,
  ChefHat,
  Dice5,
  Flame,
  Heart,
  Leaf,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  Search,
  ShoppingBasket,
  Sparkles,
  Trash2,
  UtensilsCrossed,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react"

type MealType = "lunch" | "dinner"
type PlanProfile = TomorrowProfile

const mealOrder: MealType[] = ["lunch", "dinner"]
const defaultTargets: Record<MealType, number> = { lunch: 2, dinner: 2 }
const maxPerMeal = 5

const profileOptions: Array<{
  key: PlanProfile
  label: string
  hint: string
  Icon: LucideIcon
}> = [
  { key: "balanced", label: "均衡", hint: "正常搭配", Icon: Sparkles },
  { key: "quick", label: "快手", hint: "省时间", Icon: Zap },
  { key: "light", label: "清淡", hint: "少负担", Icon: Leaf },
  { key: "spicy", label: "想吃辣", hint: "重口味", Icon: Flame },
  { key: "favorite", label: "收藏", hint: "优先常吃", Icon: Heart },
]

const mealMeta: Record<MealType, {
  label: string
  shortLabel: string
  helper: string
  accent: string
  soft: string
  text: string
  Icon: LucideIcon
}> = {
  lunch: {
    label: "明天午餐",
    shortLabel: "午餐",
    helper: "中午吃得稳一点",
    accent: "bg-primary",
    soft: "bg-primary-light",
    text: "text-primary",
    Icon: ChefHat,
  },
  dinner: {
    label: "明天晚餐",
    shortLabel: "晚餐",
    helper: "晚上吃得舒服一点",
    accent: "bg-mint",
    soft: "bg-mint-light",
    text: "text-mint",
    Icon: Moon,
  },
}

function diffLabel(difficulty: string) {
  if (difficulty === "easy") return "简单"
  if (difficulty === "medium") return "中等"
  return "费点劲"
}

function cookTimeText(dish: Dish) {
  return dish.cook_time > 0 ? `${dish.cook_time}分钟` : "时间未填"
}

function uniqueById(items: Dish[]) {
  const seen = new Set<number>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function mealRecords(records: MealRecord[], meal: MealType) {
  return records
    .filter((r) => r.meal_type === meal && r.status !== "cancelled")
    .slice()
    .sort((a, b) => a.id - b.id)
}

function keyFromRecords(records: MealRecord[]) {
  return mealOrder
    .map((meal) => `${meal}:${mealRecords(records, meal).map((r) => r.dish_id).sort((a, b) => a - b).join(",")}`)
    .join("|")
}

function keyFromDishes(lunch: Dish[], dinner: Dish[]) {
  return `lunch:${lunch.map((d) => d.id).sort((a, b) => a - b).join(",")}|dinner:${dinner.map((d) => d.id).sort((a, b) => a - b).join(",")}`
}

function recordToDish(record: MealRecord): Dish {
  return {
    id: record.dish_id,
    name: record.dish_name,
    image_url: record.dish_image_url || "",
    video_url: "",
    images: [],
    category: "",
    meal_type: record.meal_type,
    taste: "",
    ingredients: [],
    seasonings: [],
    steps: [],
    cook_time: 0,
    difficulty: "easy",
    remark: "",
    favorite: false,
    enabled: true,
    tags: [],
    sort_order: 0,
    created_at: record.created_at,
    updated_at: record.created_at,
  }
}

// 用完整菜品替换同 id 的占位菜（找不到的保持原样，如菜已被删除）
function hydrateDishes(dishes: Dish[], full: Dish[] | undefined) {
  if (!full || full.length === 0) return dishes
  const byId = new Map(full.map((d) => [d.id, d]))
  return dishes.map((d) => byId.get(d.id) ?? d)
}

function CountStepper({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="k-plan-stepper">
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className="flex items-center justify-center text-text3 transition-all hover:text-primary disabled:opacity-30"
        aria-label="减少数量"
        title="减少数量"
      >
        <Minus size={14} strokeWidth={2.4} />
      </button>
      <div className="flex items-center justify-center text-sm font-extrabold text-text">{value}</div>
      <button
        onClick={() => onChange(Math.min(maxPerMeal, value + 1))}
        disabled={value >= maxPerMeal}
        className="flex items-center justify-center text-text3 transition-all hover:text-primary disabled:opacity-30"
        aria-label="增加数量"
        title="增加数量"
      >
        <Plus size={14} strokeWidth={2.4} />
      </button>
    </div>
  )
}

function ProfileButton({
  option,
  active,
  onClick,
}: {
  option: (typeof profileOptions)[number]
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={option.hint}
      className={`k-tool-chip ${active ? "is-active" : ""}`}
    >
      {option.label}
    </button>
  )
}

function PlanSummary({
  dateLabel,
  totalCount,
  hasSavedPlan,
  hasChanges,
  pendingReview,
}: {
  dateLabel: string
  totalCount: number
  hasSavedPlan: boolean
  hasChanges: boolean
  pendingReview: boolean
}) {
  const savedText = pendingReview ? "待核对" : hasSavedPlan ? (hasChanges ? "有修改" : "已保存") : "待保存"
  const savedTone = hasSavedPlan && !hasChanges && !pendingReview ? "is-fresh" : "is-urgent"

  return (
    <header className="k-plan-heading">
      <span className={`k-tool-stamp k-plan-save-stamp ${savedTone}`}>{savedText}</span>
      <h2>明日菜单</h2>
      <p>{dateLabel} · 共 {totalCount} 道</p>
    </header>
  )
}

function DishRow({
  dish,
  meal,
  onOpen,
  onSwap,
  onRemove,
}: {
  dish: Dish
  meal: MealType
  onOpen: () => void
  onSwap: () => void
  onRemove: () => void
}) {
  return (
    <div className="k-plan-dish">
      <button onClick={onOpen} className="k-tool-polaroid k-plan-photo" aria-label={`查看${dish.name}`}>
        <DishImage dish={dish} className="h-full w-full" emojiSize="text-[30px]" />
      </button>
      <button onClick={onOpen} className="k-plan-dish-name">
        <strong>{dish.name}</strong>
        <span>{[dish.category, dish.cook_time > 0 ? `${dish.cook_time} 分钟` : "", `火候·${diffLabel(dish.difficulty)}`].filter(Boolean).join(" · ")}</span>
      </button>
      <span className="k-tool-leader" aria-hidden="true" />
      <div className="k-plan-dish-actions">
        <button
          onClick={onSwap}
          className="k-tool-icon-button"
          aria-label={`替换${mealMeta[meal].shortLabel}的${dish.name}`}
          title="换一个"
        >
          <RefreshCw size={16} strokeWidth={2.35} />
        </button>
        <button
          onClick={onRemove}
          className="k-tool-icon-button is-delete"
          aria-label={`移除${dish.name}`}
          title="移除"
        >
          <Trash2 size={16} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  )
}

function MealPlanner({
  meal,
  dishes,
  target,
  disabled,
  onTargetChange,
  onOpenDish,
  onFill,
  onReplaceMeal,
  onSwapDish,
  onRemoveDish,
  onOpenPicker,
}: {
  meal: MealType
  dishes: Dish[]
  target: number
  disabled: boolean
  onTargetChange: (value: number) => void
  onOpenDish: (dish: Dish) => void
  onFill: () => void
  onReplaceMeal: () => void
  onSwapDish: (dishId: number) => void
  onRemoveDish: (dishId: number) => void
  onOpenPicker: () => void
}) {
  const meta = mealMeta[meal]
  const missing = Math.max(0, target - dishes.length)

  return (
    <section className="k-plan-meal">
      <div className="k-plan-meal-heading">
          <h3>{meal === "lunch" ? "午市" : "晚市"}</h3>
          <CountStepper value={target} onChange={onTargetChange} />
      </div>

      <div>
        {dishes.length === 0 ? (
          <div className="py-7 text-center">
            <div className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl ${meta.soft} ${meta.text}`}>
              <UtensilsCrossed size={24} strokeWidth={2.35} />
            </div>
            <div className="text-sm font-bold text-text">还没选{meta.shortLabel}</div>
            <div className="mt-1 text-[12px] text-text3">可以智能补齐，也可以自己挑</div>
          </div>
        ) : (
          <div>
            {dishes.map((dish) => (
              <DishRow
                key={dish.id}
                dish={dish}
                meal={meal}
                onOpen={() => onOpenDish(dish)}
                onSwap={() => onSwapDish(dish.id)}
                onRemove={() => onRemoveDish(dish.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="k-plan-meal-tools">
        <button
          onClick={onFill}
          disabled={disabled || missing === 0}
          className="k-tool-text-button"
        >
          <Plus size={15} strokeWidth={2.5} />
          {missing > 0 ? `补 ${missing} 道` : "已够数"}
        </button>
        <button
          onClick={onReplaceMeal}
          disabled={disabled || target === 0}
          className="k-tool-text-button"
        >
          <Dice5 size={15} strokeWidth={2.5} />
          换一批
        </button>
        <button
          onClick={onOpenPicker}
          disabled={disabled}
          className="k-tool-text-button"
        >
          <Search size={15} strokeWidth={2.5} />
          手动选
        </button>
      </div>
    </section>
  )
}

function DishPickerModal({
  meal,
  selectedMealById,
  onAdd,
  onRemove,
  onClose,
}: {
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
  const meta = mealMeta[meal]
  const theme = useKitchenTheme(s => s.theme)
  const selectedCount = [...selectedMealById.values()].filter(selectedMeal => selectedMeal === meal).length
  const mealFull = selectedCount >= maxPerMeal

  // 输入停顿 250ms 再搜，避免每敲一个字发一次请求
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  // 关键词和分类交给后端过滤：在全部菜品里搜（含食材、别名、拼音、口味、标签），
  // 而不是只在前 100 道里找——菜库有 600+ 道，过去排在后面的菜永远搜不到
  const { data, isLoading, isPlaceholderData } = useQuery({
    queryKey: ["dishes", "tomorrow-picker", meal, keyword, category],
    queryFn: () => {
      const params: Record<string, string> = { enabled: "true", meal_type: meal, pageSize: "100", sort: "sort_order", order: "asc" }
      if (keyword) params.search = keyword
      if (category !== "全部") params.category = category
      return dishesApi.list(params)
    },
    placeholderData: keepPreviousData,
  })
  const filtered = data?.items || []
  const total = data?.total ?? 0

  const { data: categoryCounts } = useQuery({
    queryKey: ["dishes", "category-counts"],
    queryFn: () => dishesApi.categoryCounts(),
  })
  const categories = useMemo(
    () => ["全部", ...(categoryCounts?.categories || []).map((c) => c.category).filter(Boolean)],
    [categoryCounts],
  )

  return (
    <KitchenSheet title={`挑选${meta.shortLabel}`} theme={theme} onClose={onClose} className="k-plan-picker" icon={<Search size={19} />} footer={<button className="is-ink" onClick={onClose}>选好了 · 本餐 {selectedCount} 道</button>}>
        <div className="shrink-0 pt-2">
          <p className="mb-3 text-[12px] text-text3">{total} 道可选</p>
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

        <div className="k-plan-picker-results min-h-0 flex-1 overflow-y-auto pb-4">
          {isLoading ? (
            <div className="space-y-2 py-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 rounded-2xl skeleton" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-14 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-bg text-text3">
                <Search size={23} strokeWidth={2.35} />
              </div>
              <div className="text-sm font-bold text-text2">没有找到合适的菜</div>
              <div className="mt-1 text-[12px] text-text3">换个关键词或分类试试</div>
            </div>
          ) : (
            <div className={`divide-y divide-border/70 transition-opacity ${isPlaceholderData ? "opacity-60" : ""}`}>
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
                        className="k-tool-button shrink-0"
                      >
                        <X size={13} strokeWidth={2.5} />
                        移除
                      </button>
                    ) : (
                      <button
                        onClick={() => onAdd(dish)}
                        disabled={mealFull}
                        title={mealFull ? `每餐最多 ${maxPerMeal} 道，移除一道后可继续添加` : `加入${dish.name}`}
                        className="k-tool-button is-ink shrink-0"
                      >
                        <Plus size={13} strokeWidth={2.7} />
                        {mealFull ? "已满" : "加入"}
                      </button>
                    )}
                  </div>
                )
              })}
              {total > filtered.length && (
                <div className="py-4 text-center text-[12px] text-text3">只显示前 {filtered.length} 道，输入菜名或食材缩小范围</div>
              )}
            </div>
          )}
        </div>
    </KitchenSheet>
  )
}

function LoadingState() {
  return (
    <div className="px-5 py-4">
      <div className="mx-auto max-w-[640px] space-y-4">
        <div className="h-[194px] rounded-[24px] skeleton" />
        <div className="h-[180px] rounded-[24px] skeleton" />
        <div className="h-[180px] rounded-[24px] skeleton" />
      </div>
    </div>
  )
}

interface SavePlanPayload {
  date: string
  draft: TomorrowDraftState
  version: string
  requestID: string
  dishes: { dish_id: number; meal_type: string }[]
  wasSaved: boolean
}
type PlanSnapshot = Awaited<ReturnType<typeof recordsApi.plan>>
type PlanConflict = { latest: PlanSnapshot | null; reason: "changed" | "unconfirmed" }

export default function Tomorrow() {
  const [date, setDate] = useState(getTomorrow)

  useEffect(() => {
    let timer: number
    function refresh() {
      const next = getTomorrow()
      setDate(previous => previous.str === next.str ? previous : next)
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, nextLocalMidnightDelay())
    }
    function onVisibility() {
      if (document.visibilityState === "visible") refresh()
    }
    timer = window.setTimeout(refresh, nextLocalMidnightDelay())
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  // A new calendar date owns a fresh editor, including drafts, pending requests
  // and conflict state. Failed recommendations cannot retain yesterday's dishes.
  return <TomorrowEditor key={date.str} date={date} />
}

function TomorrowEditor({ date }: { date: ReturnType<typeof getTomorrow> }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const confettiRef = useRef<HTMLDivElement>(null)
  const { str: tomorrowStr, label: tomorrowLabel } = date

  const [profile, setProfile] = useState<PlanProfile>("balanced")
  const [targets, setTargets] = useState<Record<MealType, number>>(defaultTargets)
  const [lunch, setLunch] = useState<Dish[]>([])
  const [dinner, setDinner] = useState<Dish[]>([])
  const [originalRecords, setOriginalRecords] = useState<MealRecord[]>([])
  const [originalVersion, setOriginalVersion] = useState("")
  const [conflict, setConflict] = useState<PlanConflict | null>(null)
  const [readingConflict, setReadingConflict] = useState(false)
  const [initializedFor, setInitializedFor] = useState<string | null>(null)
  const [pickerMeal, setPickerMeal] = useState<MealType | null>(null)
  const [picking, setPicking] = useState(false)
  const initStartedForRef = useRef<string | null>(null)
  const requestGate = useRef(createTomorrowRequestGate())
  const retryRequest = useRef<{ key: string; id: string } | null>(null)
  const saveLock = useRef(false)

  useEffect(() => {
    const gate = requestGate.current
    gate.activate()
    return () => {
      gate.dispose()
      initStartedForRef.current = null
    }
  }, [tomorrowStr])

  const { data: tomorrowRecords, isLoading: recordsLoading, isFetchedAfterMount, isSuccess: recordsReady, isError: recordsError, refetch: reloadRecords } = useQuery({
    queryKey: ["records", "tomorrow", tomorrowStr],
    queryFn: () => recordsApi.plan(tomorrowStr),
    refetchOnMount: "always",
  })

  useEffect(() => {
    if (!isFetchedAfterMount || !recordsReady || initializedFor === tomorrowStr) return
    if (initStartedForRef.current === tomorrowStr) return
    initStartedForRef.current = tomorrowStr

    const records = tomorrowRecords?.records || []
    const stored = readTomorrowDraft(tomorrowStr, tomorrowPlanBaseline(records))
    setOriginalRecords(records)
    setOriginalVersion(tomorrowRecords?.version || "")

    if (stored.kind === "restored" || stored.kind === "conflict") {
      // Initialize once from external storage, only after checking the fresh server baseline.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLunch(stored.draft.lunch)
      setDinner(stored.draft.dinner)
      setTargets(stored.draft.targets)
      setProfile(stored.draft.profile)
      if (stored.kind === "conflict") setConflict({ latest: tomorrowRecords || null, reason: "changed" })
      setInitializedFor(tomorrowStr)
      return
    }
    if (records.length > 0) {
      const nextLunch = mealRecords(records, "lunch").map(recordToDish)
      const nextDinner = mealRecords(records, "dinner").map(recordToDish)
      // Each date initializes once; subsequent query refreshes must not overwrite edits.
      setLunch(nextLunch)
      setDinner(nextDinner)
      setTargets({
        lunch: Math.min(maxPerMeal, Math.max(nextLunch.length, defaultTargets.lunch)),
        dinner: Math.min(maxPerMeal, Math.max(nextDinner.length, defaultTargets.dinner)),
      })
      setInitializedFor(tomorrowStr)
      return
    }

    setLunch([])
    setDinner([])
    setTargets(defaultTargets)
    void generateAll(profile, defaultTargets, tomorrowStr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializedFor, isFetchedAfterMount, recordsReady, tomorrowRecords, tomorrowStr])

  // 从已保存记录还原的菜只有 id/名字/图片（recordToDish），用时和难度都是占位值：
  // 按 id 批量取完整菜品用于展示（编辑和保存仍以 lunch/dinner 状态为准，只用到 id 和名字）
  const recordDishIds = useMemo(
    () => [...new Set(originalRecords.map((r) => r.dish_id))].sort((a, b) => a - b),
    [originalRecords],
  )
  const { data: recordDishesData } = useQuery({
    queryKey: ["dishes", "by-ids", recordDishIds.join(",")],
    queryFn: () => dishesApi.list({ ids: recordDishIds.join(","), pageSize: "100" }),
    enabled: recordDishIds.length > 0,
    staleTime: 60000,
  })
  const lunchView = useMemo(() => hydrateDishes(lunch, recordDishesData?.items), [lunch, recordDishesData])
  const dinnerView = useMemo(() => hydrateDishes(dinner, recordDishesData?.items), [dinner, recordDishesData])

  const selectedMealById = useMemo(() => {
    const map = new Map<number, MealType>()
    lunch.forEach((dish) => map.set(dish.id, "lunch"))
    dinner.forEach((dish) => map.set(dish.id, "dinner"))
    return map
  }, [lunch, dinner])

  const recordsToSave = useMemo(() => {
    const records: { dish_id: number; meal_type: string }[] = []
    for (const [meal, dishes] of [["lunch", lunch], ["dinner", dinner]] as const) {
      dishes.forEach((dish) => records.push({
        dish_id: dish.id, meal_type: meal,
      }))
    }
    return records
  }, [dinner, lunch])

  const hasSavedPlan = originalRecords.length > 0
  const totalCount = lunch.length + dinner.length
  const currentKey = keyFromDishes(lunch, dinner)
  const originalKey = keyFromRecords(originalRecords)
  const hasChanges = initializedFor === tomorrowStr && currentKey !== originalKey
  const loading = recordsLoading || initializedFor !== tomorrowStr

  const savePlanMut = useMutation({
    mutationFn: ({ date, version, requestID, dishes }: SavePlanPayload) => recordsApi.savePlan(date, {
      expected_version: version, request_id: requestID, dishes,
    }),
    onSuccess: (res, variables) => {
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      qc.invalidateQueries({ queryKey: ["record"] })
      qc.invalidateQueries({ queryKey: ["dish-records"] })
      qc.invalidateQueries({ queryKey: ["admin", "records"] })
      if (!requestGate.current.active() || variables.date !== getTomorrow().str) return
      setOriginalRecords(res.records)
      setOriginalVersion(res.version)
      setConflict(null)
      retryRequest.current = null
      // Keep even an empty snapshot, so clearing a menu does not regenerate it on return.
      writeTomorrowDraft(variables.date, tomorrowPlanBaseline(res.records), variables.draft)
      launchConfetti(confettiRef.current)
      toast.success(res.replayed ? "已确认上次保存成功" : variables.wasSaved ? "明天菜单已更新" : "明天菜单已保存")
    },
    onError: async (error, variables) => {
      if (!requestGate.current.active() || variables.date !== getTomorrow().str) return
      // A transport failure may follow a committed save. Reconcile before any
      // further editing, otherwise reverting to the old baseline can look saved.
      const reason = isMealPlanConflict(error) ? "changed" : "unconfirmed"
      setConflict({ latest: null, reason })
      await loadConflictingPlan(variables.date)
      if (requestGate.current.active() && variables.date === getTomorrow().str) {
        toast.error(reason === "changed" ? "菜单已有变化，你的草稿已保留，请核对后继续" : "保存结果未确认，请核对服务器菜单后继续", { duration: 5000 })
      }
    },
    onSettled: () => { saveLock.current = false },
  })
  const disabled = loading || picking || savePlanMut.isPending

  useEffect(() => {
    if (initializedFor !== tomorrowStr || savePlanMut.isPending || conflict || tomorrowStr !== getTomorrow().str) return
    writeTomorrowDraft(tomorrowStr, tomorrowPlanBaseline(originalRecords), { lunch, dinner, targets, profile })
  }, [initializedFor, tomorrowStr, savePlanMut.isPending, conflict, originalRecords, lunch, dinner, targets, profile])

  async function loadConflictingPlan(date = tomorrowStr) {
    setReadingConflict(true)
    try {
      const latest = await recordsApi.plan(date)
      if (requestGate.current.active() && date === getTomorrow().str) {
        setConflict(previous => previous ? { ...previous, latest } : null)
      }
    } catch {
      if (requestGate.current.active() && date === getTomorrow().str) toast.error("最新菜单读取失败，草稿仍在，请重试")
    } finally {
      if (requestGate.current.active() && date === getTomorrow().str) setReadingConflict(false)
    }
  }

  function acceptLatestPlan(keepDraft: boolean) {
    const latest = conflict?.latest
    if (!latest) return
    invalidateRecommendations()
    setOriginalRecords(latest.records)
    setOriginalVersion(latest.version)
    setConflict(null)
    retryRequest.current = null
    if (!keepDraft) {
      setLunch(mealRecords(latest.records, "lunch").map(recordToDish))
      setDinner(mealRecords(latest.records, "dinner").map(recordToDish))
    }
    toast(keepDraft ? "已核对最新记录，请检查草稿后再次保存" : "已载入最新菜单")
  }

  function getMeal(meal: MealType) {
    return meal === "lunch" ? lunch : dinner
  }

  function openDish(dish: Dish, meal: MealType) {
    const saved = originalRecords.find(r => r.dish_id === dish.id && r.meal_type === meal)
    navigate(`/dishes/${dish.id}${saved ? `?record_id=${saved.id}` : ""}`)
  }

  function updateMeal(meal: MealType, updater: (prev: Dish[]) => Dish[]) {
    if (meal === "lunch") setLunch(updater)
    else setDinner(updater)
  }

  function invalidateRecommendations() {
    requestGate.current.invalidate()
    setPicking(false)
  }

  function beginRecommendation() {
    const token = requestGate.current.begin()
    const date = tomorrowStr
    setPicking(true)
    return () => requestGate.current.current(token) && date === getTomorrow().str
  }

  function updateTarget(meal: MealType, value: number) {
    invalidateRecommendations()
    const next = Math.max(0, Math.min(maxPerMeal, value))
    setTargets((prev) => ({ ...prev, [meal]: next }))
    updateMeal(meal, (prev) => (prev.length > next ? prev.slice(0, next) : prev))
  }

  async function requestTomorrowDishes(
    meal: MealType,
    count: number,
    nextProfile = profile,
    excludeIds: number[] = [],
  ) {
    if (count <= 0) return []
    const res = await pickApi.tomorrow({
      meal_type: meal,
      profile: nextProfile,
      count,
      exclude_ids: excludeIds,
    })
    return res.dishes || []
  }

  async function fillMeal(meal: MealType) {
    const current = getMeal(meal)
    const needed = Math.max(0, targets[meal] - current.length)
    if (needed === 0) return
    const otherMeal = meal === "lunch" ? dinner : lunch
    const excludeIds = [
      ...otherMeal.map((dish) => dish.id),
      ...current.map((dish) => dish.id),
    ]
    const currentRequest = beginRecommendation()
    try {
      const picks = await requestTomorrowDishes(meal, needed, profile, excludeIds)
      if (!currentRequest()) return
      if (picks.length === 0) {
        toast.error("没有更多合适的菜了")
        return
      }
      updateMeal(meal, (prev) => uniqueById([...prev, ...picks]).slice(0, maxPerMeal))
    } catch {
      if (currentRequest()) toast.error("没有更多合适的菜了")
    } finally {
      if (currentRequest()) setPicking(false)
    }
  }

  async function replaceMeal(meal: MealType) {
    const count = Math.max(1, targets[meal] || getMeal(meal).length || 1)
    const otherMeal = meal === "lunch" ? dinner : lunch
    const currentRequest = beginRecommendation()
    try {
      const picks = await requestTomorrowDishes(meal, count, profile, otherMeal.map((dish) => dish.id))
      if (!currentRequest()) return
      if (picks.length === 0) {
        toast.error("暂无可推荐的菜品")
        return
      }
      updateMeal(meal, () => picks)
    } catch {
      if (currentRequest()) toast.error("暂无可推荐的菜品")
    } finally {
      if (currentRequest()) setPicking(false)
    }
  }

  async function swapDish(meal: MealType, dishId: number) {
    const current = getMeal(meal)
    const otherMeal = meal === "lunch" ? dinner : lunch
    const keepIds = current.filter((dish) => dish.id !== dishId).map((dish) => dish.id)
    const excludeIds = [...keepIds, ...otherMeal.map((dish) => dish.id), dishId]
    const currentRequest = beginRecommendation()
    try {
      const [pick] = await requestTomorrowDishes(meal, 1, profile, excludeIds)
      if (!currentRequest()) return
      if (!pick) {
        toast.error("没有可替换的菜了")
        return
      }
      updateMeal(meal, (prev) => prev.map((dish) => (dish.id === dishId ? pick : dish)))
    } catch {
      if (currentRequest()) toast.error("没有可替换的菜了")
    } finally {
      if (currentRequest()) setPicking(false)
    }
  }

  function addManual(meal: MealType, dish: Dish) {
    const selectedMeal = selectedMealById.get(dish.id)
    if (selectedMeal) {
      toast.error(`这道菜已经在${mealMeta[selectedMeal].shortLabel}里了`)
      return
    }
    if (getMeal(meal).length >= maxPerMeal) {
      toast.error(`每餐最多 ${maxPerMeal} 道菜`)
      return
    }
    invalidateRecommendations()
    updateMeal(meal, (prev) => [...prev, dish])
    setTargets((prev) => ({ ...prev, [meal]: Math.max(prev[meal], getMeal(meal).length + 1) }))
  }

  function removeDish(meal: MealType, dishId: number) {
    invalidateRecommendations()
    updateMeal(meal, (prev) => prev.filter((dish) => dish.id !== dishId))
  }

  async function generateAll(nextProfile = profile, nextTargets = targets, initializeDate?: string) {
    const currentRequest = beginRecommendation()
    try {
      const nextLunch = nextTargets.lunch > 0
        ? await requestTomorrowDishes("lunch", nextTargets.lunch, nextProfile)
        : []
      if (!currentRequest()) return
      const nextDinner = nextTargets.dinner > 0
        ? await requestTomorrowDishes("dinner", nextTargets.dinner, nextProfile, nextLunch.map((dish) => dish.id))
        : []
      if (!currentRequest()) return
      if (nextLunch.length === 0 && nextDinner.length === 0) {
        toast.error("暂无可推荐的菜品")
        return
      }
      setLunch(nextLunch)
      setDinner(nextDinner)
    } catch {
      if (currentRequest()) toast.error("暂无可推荐的菜品")
    } finally {
      if (currentRequest()) {
        setPicking(false)
        if (initializeDate) setInitializedFor(initializeDate)
      }
    }
  }

  function applyProfile(nextProfile: PlanProfile) {
    setProfile(nextProfile)
    void generateAll(nextProfile)
  }

  function savePlan() {
    if (saveLock.current || conflict) return
    if (tomorrowStr !== getTomorrow().str) {
      setInitializedFor(null)
      toast("日期已变化，正在重新读取明日菜单")
      return
    }
    if (recordsToSave.length === 0 && !hasSavedPlan) {
      toast.error("至少选一道菜")
      return
    }
    if (hasSavedPlan && !hasChanges) {
      toast("菜单没有变化")
      return
    }
    invalidateRecommendations()
    const requestKey = JSON.stringify([tomorrowStr, originalVersion, recordsToSave])
    if (retryRequest.current?.key !== requestKey) {
      retryRequest.current = { key: requestKey, id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` }
    }
    saveLock.current = true
    const draft = { lunch, dinner, targets, profile }
    writeTomorrowDraft(tomorrowStr, tomorrowPlanBaseline(originalRecords), draft)
    savePlanMut.mutate({
      date: tomorrowStr, draft,
      version: originalVersion, requestID: retryRequest.current.id, dishes: recordsToSave, wasSaved: hasSavedPlan,
    })
  }

  return (
    <div className="animate-fadeUp pb-[116px] k-tools-page k-tomorrow-page">
      {createPortal(<div ref={confettiRef} className="fixed inset-0 z-50 pointer-events-none overflow-hidden" />, document.body)}

      <PageHeader
        title="明天吃什么"
        icon={CalendarClock}
        onBack={() => navigate(-1)}
      />

      {recordsError && initializedFor !== tomorrowStr ? (
        <div className="px-5 py-12 text-center text-text2">
          <p>明日计划读取失败，请重试。</p>
          <button onClick={() => reloadRecords()} className="mt-4 rounded-full bg-primary px-5 py-2 text-sm text-white">重新读取</button>
        </div>
      ) : loading ? (
        <LoadingState />
      ) : (
        <main className="px-5 py-4">
          {conflict && (
            <section className="mx-auto mb-4 max-w-[640px] rounded-2xl border border-yellow/40 bg-yellow-light p-4" role="alert">
              <div className="font-bold text-text">{conflict.reason === "unconfirmed" ? "保存结果未确认，草稿已保留" : "菜单已有变化，草稿已保留"}</div>
              <p className="mt-1 text-sm text-text2">请核对最新安排，再决定继续编辑这份草稿，或载入最新菜单。</p>
              {conflict.latest ? (
                <>
                  {mealOrder.map(meal => <p key={meal} className="mt-2 text-sm text-text2">最新{mealMeta[meal].shortLabel}：{mealRecords(conflict.latest!.records, meal).map(record => `${record.dish_name}${record.portion_scale !== 1 ? ` ×${record.portion_scale}` : ""}`).join("、") || "未安排"}</p>)}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => acceptLatestPlan(true)} className="min-h-11 rounded-full bg-primary px-4 text-sm font-semibold text-white">保留草稿继续编辑</button>
                    <button onClick={() => acceptLatestPlan(false)} className="min-h-11 rounded-full border border-border bg-card px-4 text-sm font-semibold text-text2">载入最新菜单</button>
                  </div>
                </>
              ) : <button disabled={readingConflict} onClick={() => void loadConflictingPlan()} className="mt-3 min-h-11 rounded-full bg-card px-4 text-sm font-semibold text-primary">{readingConflict ? "读取最新菜单…" : "重新读取最新菜单"}</button>}
            </section>
          )}
          <fieldset disabled={savePlanMut.isPending || !!conflict} className="k-plan-layout mx-auto min-w-0 max-w-[640px]">
            <div className="k-plan-paper">
            <PlanSummary
              dateLabel={tomorrowLabel}
              totalCount={totalCount}
              hasSavedPlan={hasSavedPlan}
              hasChanges={hasChanges}
              pendingReview={!!conflict}
            />

            <div className="k-plan-meals">
            <MealPlanner
              meal="lunch"
              dishes={lunchView}
              target={targets.lunch}
              disabled={disabled}
              onTargetChange={(value) => updateTarget("lunch", value)}
              onOpenDish={(dish) => openDish(dish, "lunch")}
              onFill={() => fillMeal("lunch")}
              onReplaceMeal={() => replaceMeal("lunch")}
              onSwapDish={(dishId) => swapDish("lunch", dishId)}
              onRemoveDish={(dishId) => removeDish("lunch", dishId)}
              onOpenPicker={() => setPickerMeal("lunch")}
            />

            <MealPlanner
              meal="dinner"
              dishes={dinnerView}
              target={targets.dinner}
              disabled={disabled}
              onTargetChange={(value) => updateTarget("dinner", value)}
              onOpenDish={(dish) => openDish(dish, "dinner")}
              onFill={() => fillMeal("dinner")}
              onReplaceMeal={() => replaceMeal("dinner")}
              onSwapDish={(dishId) => swapDish("dinner", dishId)}
              onRemoveDish={(dishId) => removeDish("dinner", dishId)}
              onOpenPicker={() => setPickerMeal("dinner")}
            />
            </div>
            </div>
            <section className="k-plan-preferences">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="k-tool-section-title">「口味偏好」</h2>
                  <div className="text-[11px] font-medium text-text3">生成和替换都会按这里来</div>
                </div>
                <button
                  onClick={() => generateAll()}
                  disabled={disabled}
                  className="k-tool-text-button"
                >
                  <Dice5 size={14} strokeWidth={2.5} />
                  重新生成
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                {profileOptions.map((option) => (
                  <ProfileButton
                    key={option.key}
                    option={option}
                    active={profile === option.key}
                    onClick={() => applyProfile(option.key)}
                  />
                ))}
              </div>
            </section>

            <button type="button" onClick={() => navigate("/more#shopping")} className="k-plan-shopping-note">
              <ShoppingBasket size={17} aria-hidden="true" />
              <span>保存后自动生成明天的买菜清单</span>
              <span className="k-plan-shopping-link">查看清单</span>
            </button>
          </fieldset>
        </main>
      )}

      {!loading && (
        <div
          className="k-plan-save-bar"
          style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto flex max-w-[640px] items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-bold text-text2">
                {totalCount > 0 ? `${tomorrowLabel} · ${totalCount} 道菜` : "还没有选择菜品"}
              </div>
              <div className="truncate text-[11px] font-medium text-text3">
                {conflict ? "核对最新菜单后继续" : hasSavedPlan ? (hasChanges ? "保存后会覆盖原明日菜单" : "当前菜单已同步到买菜清单") : "保存后自动生成买菜清单"}
              </div>
            </div>
            <button
              onClick={savePlan}
              disabled={disabled || !!conflict || (totalCount === 0 && !hasSavedPlan) || (hasSavedPlan && !hasChanges)}
              className="k-tool-button is-ink k-plan-save-button"
            >
              <Check size={17} strokeWidth={2.6} />
              {conflict ? "待核对" : savePlanMut.isPending ? "保存中" : hasSavedPlan ? (hasChanges ? "更新菜单" : "已保存") : "保存菜单"}
            </button>
          </div>
        </div>
      )}

      {pickerMeal && (
        <DishPickerModal
          meal={pickerMeal}
          selectedMealById={selectedMealById}
          onAdd={(dish) => addManual(pickerMeal, dish)}
          onRemove={(meal, dishId) => removeDish(meal, dishId)}
          onClose={() => setPickerMeal(null)}
        />
      )}
    </div>
  )
}
