import { useState, useMemo, useEffect } from "react"
import { createPortal } from "react-dom"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { dishesApi, favoritesApi, recordsApi, getUploadErrorMessage } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import { asArray } from "@/lib/utils"
import { parsePortionScale, portionLabel, scaleAmount } from "@/lib/portions"
import { getDishImageUrl, getDishEmoji, thumbUrl } from "@/lib/dishImage"
import SafeImage from "@/components/SafeImage"
import PhotoViewer from "@/components/PhotoViewer"
import SectionHeader from "@/components/SectionHeader"
import DishCard from "@/components/DishCard"
import { cardShadow } from "@/components/Card"
import type { Dish, DishRecordsStats } from "@/types"
import toast from "react-hot-toast"
import { ArrowLeft, Check, ChevronDown, Flame, Heart, Pencil, Star, Volume2 } from "lucide-react"
import "@/styles/kitchen-recipe.css"

function diffLabel(d: string) { return d === "easy" ? "简单" : d === "medium" ? "中等" : "困难" }
function mealLabel(m: string) {
  if (m === "lunch") return "午餐"
  if (m === "dinner") return "晚餐"
  return "午餐 / 晚餐"
}

const moodEmojiMap: Record<string, string> = { yum: "😋", ok: "😐", no: "😵", great: "😋", meh: "😕" }
const homeMoodEmojiMap: Record<string, string> = { happy: "😊", tired: "😫", lazy: "😌", spicy: "🤤", healthy: "🌿" }
const homeMoodLabelMap: Record<string, string> = { happy: "开心", tired: "疲惫", lazy: "想偷懒", spicy: "想吃辣", healthy: "想养生" }

interface Ingredient { name: string; amount: string }
interface Step { text: string; time?: number; image?: string }

function normalizeIngredients(raw: unknown[]): Ingredient[] {
  return raw.map((item) => {
    if (typeof item === "string") return { name: item, amount: "" }
    if (typeof item === "object" && item !== null) return { name: (item as Record<string, unknown>).name as string || "", amount: (item as Record<string, unknown>).amount as string || "" }
    return { name: String(item), amount: "" }
  })
}

function normalizeSteps(raw: unknown[]): Step[] {
  return raw.map((item) => {
    if (typeof item === "string") return { text: item }
    if (typeof item === "object" && item !== null) return { text: (item as Record<string, unknown>).text as string || "", time: (item as Record<string, unknown>).time as number | undefined, image: (item as Record<string, unknown>).image as string | undefined }
    return { text: String(item) }
  })
}

function IngredientCard({ ing, scale, checked, onToggle }: { ing: Ingredient; scale: number; checked: boolean; onToggle: () => void }) {
  return (
    <label className={`recipe-ingredient ${checked ? "is-ready" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`备好${ing.name}`} />
      <span className="recipe-ingredient-box" aria-hidden="true">{checked && <Check size={13} strokeWidth={2} />}</span>
      <span className="recipe-ingredient-name">{ing.name}</span>
      {ing.amount && <span className="recipe-ingredient-amount">{scaleAmount(ing.amount, scale)}</span>}
    </label>
  )
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.floor((today.getTime() - target.getTime()) / 86400000)
  if (diff === 0) return "今天"
  if (diff === 1) return "昨天"
  if (diff === 2) return "前天"
  if (diff < 7) return `${diff}天前`
  if (diff < 30) return `${Math.floor(diff / 7)}周前`
  const m = d.getMonth() + 1
  const day = d.getDate()
  if (d.getFullYear() === now.getFullYear()) return `${m}月${day}日`
  return `${d.getFullYear()}年${m}月${day}日`
}

function formatWeekday(dateStr: string): string {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
  return weekdays[new Date(dateStr).getDay()]
}

function getMasteryLevel(count: number): { label: string; icon: string; color: string } {
  if (count >= 10) return { label: "大师", icon: "👨‍🍳", color: "text-yellow bg-yellow-light border-yellow/20" }
  if (count >= 6) return { label: "熟练", icon: "🔥", color: "text-primary bg-primary-light border-primary/20" }
  if (count >= 3) return { label: "入门", icon: "✨", color: "text-mint bg-mint-light border-mint/20" }
  return { label: "初学", icon: "🌱", color: "text-purple bg-purple-light border-purple/20" }
}

export default function DishDetail() {
  const { id } = useParams()
  const [params] = useSearchParams()
  return <DishDetailContent key={`${id}:${params.get("record_id") || ""}`} />
}

function DishDetailContent() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const qc = useQueryClient()
  const dishId = Number(id)
  const requestedRecordId = Number(searchParams.get("record_id")) || 0
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)

  const [preparation, setPreparation] = useState<{ scope: string; checked: Set<string> }>(() => ({ scope: "", checked: new Set() }))
  useEffect(() => () => { if ("speechSynthesis" in window) speechSynthesis.cancel() }, [])

  const [portionChoice, setPortionChoice] = useState<number | null>(null)
  const [viewerPhotos, setViewerPhotos] = useState<string[]>([])
  const [viewerIdx, setViewerIdx] = useState(0)
  const [showViewer, setShowViewer] = useState(false)

  const { data: dish, isLoading } = useQuery({
    queryKey: ["dish", dishId],
    queryFn: () => dishesApi.get(dishId),
    enabled: !!dishId,
    staleTime: 0,
    gcTime: 0,
  })

  const { data: dishRecordsData, isFetchedAfterMount: dishHistoryFetched, isSuccess: dishHistoryReady, isError: dishHistoryError } = useQuery({
    queryKey: ["dish-records", dishId],
    queryFn: () => dishesApi.records(dishId),
    enabled: !!dishId,
    staleTime: 0,
    refetchOnMount: "always",
  })
  const todayPlans = (dishRecordsData?.records || []).filter((r) => r.status === "planned" && r.meal_date === todayKey())
  const suggestedMeal = new Date().getHours() < 15 ? "lunch" : "dinner"
  const inferredPlan = todayPlans.find((r) => r.meal_type === suggestedMeal) || todayPlans[0]
  // 先读取最新状态，再固定到具体一餐；跨时段或刷新列表不能改绑编辑中的份量。
  useEffect(() => {
    if (!requestedRecordId && dishHistoryFetched && dishHistoryReady && inferredPlan?.id) {
      navigate(`/dishes/${dishId}?record_id=${inferredPlan.id}`, { replace: true })
    }
  }, [dishId, requestedRecordId, dishHistoryFetched, dishHistoryReady, inferredPlan?.id, navigate])
  const recordId = requestedRecordId || inferredPlan?.id || 0
  const { data: linkedRecord, isFetchedAfterMount: recordFetched, isError: recordError } = useQuery({
    queryKey: ["record", recordId],
    queryFn: () => recordsApi.get(recordId),
    enabled: recordId > 0,
    staleTime: 0,
  })
  const portionScale = portionChoice ?? parsePortionScale(linkedRecord?.portion_scale ?? searchParams.get("portion_scale"))
  const portionChanged = !!linkedRecord && portionScale !== linkedRecord.portion_scale
  const canCook = !linkedRecord || (linkedRecord.status === "planned" && linkedRecord.meal_date <= todayKey())

  const { data: favDishes } = useQuery({ queryKey: ["favorites"], queryFn: () => favoritesApi.list(), staleTime: 0 })
  const isFav = favDishes?.some((d: Dish) => d.id === dishId) || false

  const dishRecords = useMemo(() => (dishRecordsData?.records || []).filter((r) => r.status === "completed"), [dishRecordsData])
  const dishStats: DishRecordsStats = dishRecordsData?.stats || { total_count: 0, lunch_count: 0, dinner_count: 0, yum_percent: 0, ok_percent: 0, no_percent: 0, avg_rating: 0, last_date: "", avg_interval: 0 }

  // 同类推荐按分类向后端取已启用的菜（过去在"最新 100 道"里筛，老分类常常一道都凑不出，还会混进已停用的菜）
  const { data: sameCategoryData } = useQuery({
    queryKey: ["dishes", "same-category", dish?.category],
    queryFn: () => dishesApi.list({ enabled: "true", category: dish!.category, pageSize: "7" }),
    enabled: !!dish?.category,
  })
  const sameCategoryDishes = useMemo(
    () => (sameCategoryData?.items || []).filter((d: Dish) => d.id !== dishId).slice(0, 6),
    [sameCategoryData, dishId],
  )

  const favMut = useMutation({
    mutationFn: () => isFav ? favoritesApi.remove(dishId) : favoritesApi.add(dishId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["favorites"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      toast.success(isFav ? "已取消收藏" : "❤ 已收藏")
    },
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "收藏更新失败")),
  })

  const recordMut = useMutation({
    mutationFn: (mealType: string) => recordsApi.create({
      dish_id: dishId,
      dish_name: dish?.name || "",
      meal_type: mealType,
      meal_date: todayKey(),
      status: "planned",
      portion_scale: portionScale,
    }),
    onSuccess: (record) => {
      toast.success(`已加入今天${record.meal_type === "lunch" ? "午餐" : "晚餐"}计划`)
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["dish-records", dishId] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      navigate(`/dishes/${dishId}?record_id=${record.id}`, { replace: true })
    },
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "加入计划失败")),
  })

  const portionMut = useMutation({
    mutationFn: () => recordsApi.update(recordId, { portion_scale: portionScale }),
    onSuccess: (record) => {
      qc.setQueryData(["record", recordId], record)
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["dish-records", dishId] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      toast.success("份量已保存，买菜清单已更新")
    },
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "保存份量失败")),
  })

  async function startCooking() {
    if (!canCook || portionMut.isPending) return
    if (portionChanged) {
      try { await portionMut.mutateAsync() } catch { return }
    }
    const query = new URLSearchParams({ portion_scale: String(portionScale) })
    if (recordId) query.set("record_id", String(recordId))
    navigate(`/dishes/${dishId}/cook?${query}`)
  }

  const allPhotos = useMemo(() => {
    const photos: { url: string; date: string }[] = []
    for (const r of dishRecords) {
      if (r.photo) {
        photos.push({ url: r.photo, date: r.meal_date })
      }
      for (const p of r.photos) {
        photos.push({ url: p, date: r.meal_date })
      }
    }
    return photos
  }, [dishRecords])

  if (isLoading || (!requestedRecordId && !dishHistoryError && (!dishHistoryFetched || !dishHistoryReady)) || (recordId > 0 && !recordError && !recordFetched)) return <div className="p-8 text-center text-text2">加载中...</div>
  if (!dish) return <div className="p-8 text-center text-text2">菜品不存在</div>
  if ((!requestedRecordId && dishHistoryError) || (recordId > 0 && (recordError || !linkedRecord || linkedRecord.dish_id !== dishId))) return (
    <div className="p-8 text-center text-text2">
      <p>这份计划暂时无法读取，请返回重试。</p>
      <button onClick={() => navigate(-1)} className="mt-4 px-5 py-2 rounded-full bg-primary text-white">返回</button>
    </div>
  )

  const ingredients: Ingredient[] = normalizeIngredients(asArray(dish.ingredients))
  const seasonings: Ingredient[] = normalizeIngredients(asArray(dish.seasonings))
  // 勾选只对应这份配料和用量。后台刷新改变顺序、配料或计划份量时立即清空，不能把旧勾选套给新内容。
  const preparationScope = JSON.stringify([dishId, recordId, portionScale, ingredients, seasonings])
  const readyIngredients = preparation.scope === preparationScope ? preparation.checked : new Set<string>()
  if (preparation.scope !== preparationScope) {
    setPreparation({ scope: preparationScope, checked: new Set() })
  }
  function toggleIngredient(key: string) {
    setPreparation((previous) => {
      const checked = new Set(previous.scope === preparationScope ? previous.checked : [])
      if (checked.has(key)) checked.delete(key)
      else checked.add(key)
      return { scope: preparationScope, checked }
    })
  }
  const steps: Step[] = normalizeSteps(asArray(dish.steps))
  const tasteTags = (dish.taste || "").split(",").map((t) => t.trim()).filter(Boolean)
  const dishTags = asArray<string>(dish.tags).filter(Boolean)
  const mastery = getMasteryLevel(dishStats.total_count)
  const hasMoodData = dishStats.yum_percent + dishStats.ok_percent + dishStats.no_percent > 0

  return (
    <div className="recipe-page">
      <header className="recipe-heading">
        <button type="button" className="recipe-icon-button" onClick={() => navigate(-1)} aria-label="返回"><ArrowLeft size={19} /></button>
        <span className="recipe-number-stamp">私房菜 · 第 {dish.id} 道</span>
        {isLoggedIn && <button type="button" className="recipe-icon-button recipe-edit" onClick={() => navigate(`/admin/dishes/${dishId}`)} aria-label="编辑菜品"><Pencil size={18} /></button>}
      </header>

      <div className="recipe-body">
        <article className="recipe-polaroid">
          <span className="recipe-tape" aria-hidden="true" />
          <div className="recipe-photo">
            <SafeImage src={getDishImageUrl(dish)} alt={dish.name} className="w-full h-full object-cover" eager fallback={<div className="recipe-photo-fallback">{getDishEmoji(dish)}</div>} />
          </div>
          <div className="recipe-photo-caption">
            <button type="button" onClick={() => favMut.mutate()} disabled={favMut.isPending} className={`recipe-favorite ${isFav ? "is-favorite" : ""}`} aria-label={isFav ? "取消收藏" : "收藏这道菜"} aria-pressed={isFav}><Heart size={20} fill={isFav ? "currentColor" : "none"} /><span>{isFav ? "已收藏" : "收藏这道菜"}</span></button>
          </div>
          <h1 className="recipe-title">{dish.name}</h1>
          <div className="recipe-meta">
            <span>{dish.category}</span>
            {dish.cook_time > 0 && <span>约 {dish.cook_time} 分钟</span>}
            <span className={`recipe-difficulty recipe-difficulty-${dish.difficulty}`}>火候·{diffLabel(dish.difficulty)}</span>
            {tasteTags.map((t) => <span key={t}>{t}</span>)}
            <span>{mealLabel(dish.meal_type)}</span>
          </div>
          {dishTags.length > 0 && <div className="recipe-tags">{dishTags.map((t) => <span key={t}>#{t}</span>)}</div>}
        </article>
        {linkedRecord && (
          <div className="mb-4 rounded-xl border border-primary/20 bg-primary-light p-3 text-[13px] text-text2">
            <div className="font-semibold text-primary">{linkedRecord.meal_date} · {linkedRecord.meal_type === "lunch" ? "午餐" : "晚餐"} · {linkedRecord.status === "completed" ? "已吃" : linkedRecord.status === "cancelled" ? "已取消" : "计划吃"}</div>
            <div className="mt-1">已保存 {portionLabel(linkedRecord.portion_scale)}{portionChanged ? "，下方份量尚未保存" : ""}</div>
            {linkedRecord.status === "planned" && linkedRecord.meal_date > todayKey() && <div className="mt-1">到了用餐当天，再开始做菜或标记已吃。</div>}
            {todayPlans.some((r) => r.id !== linkedRecord.id) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {todayPlans.filter((r) => r.id !== linkedRecord.id).map((r) => <button key={r.id} onClick={() => navigate(`/dishes/${dishId}?record_id=${r.id}`, { replace: true })} className="min-h-10 px-3 rounded-full bg-card text-primary font-semibold">查看今天{r.meal_type === "lunch" ? "午餐" : "晚餐"}计划 · {portionLabel(r.portion_scale)}</button>)}
              </div>
            )}
            {linkedRecord.status === "planned" && linkedRecord.meal_date === todayKey() && !(dishRecordsData?.records || []).some((r) => r.meal_date === todayKey() && r.meal_type !== linkedRecord.meal_type && r.status !== "cancelled") && (
              <button disabled={recordMut.isPending} onClick={() => recordMut.mutate(linkedRecord.meal_type === "lunch" ? "dinner" : "lunch")} className="mt-2 min-h-10 px-3 rounded-full bg-card text-primary font-semibold disabled:opacity-50">也加入今天{linkedRecord.meal_type === "lunch" ? "晚餐" : "午餐"}计划</button>
            )}
          </div>
        )}
        {dishStats.total_count > 0 && (
          <details className="recipe-records-summary">
            <summary><span className="recipe-mastery-stamp">做了 {dishStats.total_count} 次 · {mastery.label}</span><span className="recipe-dotline" /><span className="recipe-records-score">{hasMoodData ? `好吃率 ${dishStats.yum_percent}%` : "待评价"}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div className="recipe-records-expanded">

            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center bg-bg rounded-lg py-2">
                <div className="text-base font-bold text-primary">{dishStats.lunch_count}</div>
                <div className="text-[11px] text-text3">午餐</div>
              </div>
              <div className="text-center bg-bg rounded-lg py-2">
                <div className="text-base font-bold text-mint">{dishStats.dinner_count}</div>
                <div className="text-[11px] text-text3">晚餐</div>
              </div>
              <div className="text-center bg-bg rounded-lg py-2">
                <div className="text-base font-bold text-text">{dishStats.avg_interval > 0 ? `${dishStats.avg_interval}天` : "-"}</div>
                <div className="text-[11px] text-text3">平均间隔</div>
              </div>
            </div>

            {dishStats.last_date && (
              <div className="text-[11px] text-text3 mb-3">上次做：{formatRelativeDate(dishStats.last_date)}</div>
            )}

            {hasMoodData && (
              <div className="mb-2">
                <div className="text-[11px] text-text3 mb-1.5">满意度</div>
                <div className="flex h-3 rounded-full overflow-hidden bg-bg">
                  {dishStats.yum_percent > 0 && <div className="bg-mint transition-all" style={{ width: `${dishStats.yum_percent}%` }} />}
                  {dishStats.ok_percent > 0 && <div className="bg-yellow transition-all" style={{ width: `${dishStats.ok_percent}%` }} />}
                  {dishStats.no_percent > 0 && <div className="bg-pink transition-all" style={{ width: `${dishStats.no_percent}%` }} />}
                </div>
                <div className="flex gap-3 mt-1.5">
                  {dishStats.yum_percent > 0 && <span className="text-[11px] text-text3 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-mint" />😋 好吃 {dishStats.yum_percent}%</span>}
                  {dishStats.ok_percent > 0 && <span className="text-[11px] text-text3 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow" />😐 一般 {dishStats.ok_percent}%</span>}
                  {dishStats.no_percent > 0 && <span className="text-[11px] text-text3 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-pink" />😵 不行 {dishStats.no_percent}%</span>}
                </div>
              </div>
            )}

            {dishStats.avg_rating > 0 && (
              <div className="flex items-center gap-1 mt-2">
                <span className="text-[11px] text-text3">平均评分</span>
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star key={s} size={12} className={s <= Math.round(dishStats.avg_rating) ? "text-yellow fill-yellow" : "text-text4"} />
                  ))}
                </div>
                <span className="text-[11px] font-semibold text-text">{dishStats.avg_rating.toFixed(1)}</span>
              </div>
            )}
            </div>
          </details>
        )}


        {dish.video_url && (
          <button onClick={() => window.open(dish.video_url, "_blank", "noopener,noreferrer")}
            className="w-full mb-5 py-2.5 px-5 rounded-full text-sm font-semibold bg-pink-light text-pink border border-pink/30 transition-all active:scale-97 flex items-center justify-center gap-2">
            ▶ 观看教程视频
          </button>
        )}

        {(ingredients.length > 0 || seasonings.length > 0) && (
          <div className="mb-6">
            <div className="recipe-ingredients-heading">
              <h2 className="recipe-section-title">「食材」</h2>
              <div className="recipe-portions" aria-label="菜谱份量">
                {[0.5, 1, 2, 3, 4].map((s) => (
                  <button key={s} onClick={() => setPortionChoice(s)} disabled={portionMut.isPending || (!!linkedRecord && linkedRecord.status !== "planned")}
                    aria-label={portionLabel(s)} aria-pressed={portionScale === s}
                    className={`recipe-portion ${portionScale === s ? "is-selected" : ""}`}>
                    {s === 1 ? "原量" : `×${s}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="recipe-prep-meta"><span>备好 {readyIngredients.size} / {ingredients.length + seasonings.length} 项</span><button type="button" disabled={readyIngredients.size === 0} onClick={() => setPreparation({ scope: preparationScope, checked: new Set() })}>重置勾选</button></div><p className="recipe-prep-note">勾选仅用于本次备菜；份量保存后同步买菜清单。</p>
            {ingredients.length > 0 && (
              <div className="mb-3">
                <div className="text-[12px] text-text3 font-semibold mb-1.5">配料</div>
                <div className="recipe-ingredients-grid">
                  {ingredients.map((ing, i) => (
                    <IngredientCard key={`ing-${i}`} ing={ing} scale={portionScale} checked={readyIngredients.has(`ing-${i}`)} onToggle={() => toggleIngredient(`ing-${i}`)} />
                  ))}
                </div>
              </div>
            )}
            {seasonings.length > 0 && (
              <div>
                <div className="text-[12px] text-text3 font-semibold mb-1.5">调料</div>
                <div className="recipe-ingredients-grid">
                  {seasonings.map((s, i) => (
                    <IngredientCard key={`sea-${i}`} ing={s} scale={portionScale} checked={readyIngredients.has(`sea-${i}`)} onToggle={() => toggleIngredient(`sea-${i}`)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {steps.length > 0 && (
          <div className="mb-6">
            <h2 className="recipe-section-title">「做法」</h2>
            <div>
              {steps.map((s, i) => (
                <div key={i} className="recipe-step">
                  <span className="recipe-step-stamp">{i + 1}</span>
                  <div className="flex-1">
                    <div className="recipe-step-text">{s.text}</div>
                    {s.time != null && s.time > 0 && <span className="recipe-time-slip">{s.time} 分钟</span>}
                    {s.image && (
                      <div className="mt-2 rounded-lg overflow-hidden border border-border">
                        <img src={s.image!} alt="" className="w-full max-h-40 object-cover" loading="lazy" />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      if ("speechSynthesis" in window) {
                        speechSynthesis.cancel()
                        const u = new SpeechSynthesisUtterance(s.text)
                        u.lang = "zh-CN"; u.rate = 0.9
                        speechSynthesis.speak(u)
                        toast("🔊 正在播报...")
                      }
                    }}
                    className="recipe-step-speak" aria-label={`朗读第 ${i + 1} 步`} disabled={!("speechSynthesis" in window)}
                  ><Volume2 size={17} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {dish.remark && <aside className="recipe-tip"><h2>小贴士</h2><p>{dish.remark}</p></aside>}
        <section className="recipe-plan-actions" aria-label="用餐计划">
          {linkedRecord ? (
          <>
            <button onClick={() => navigate("/history")} className="flex-1 py-2.5 rounded-full text-sm font-semibold border border-border2 text-text2 transition-all active:scale-96">查看用餐记录</button>
            {linkedRecord.status === "planned" ? (
              <button onClick={() => portionMut.mutate()} disabled={!portionChanged || portionMut.isPending} className="flex-1 py-2.5 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-50">{portionMut.isPending ? "保存中…" : portionChanged ? "保存份量" : "份量已保存"}</button>
            ) : (
              <button onClick={() => navigate(`/dishes/${dishId}?portion_scale=${portionScale}`, { replace: true })} className="flex-1 py-2.5 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96">重新选这道菜</button>
            )}
          </>
        ) : (
          <>
            <button onClick={() => recordMut.mutate("lunch")} disabled={recordMut.isPending} className="flex-1 py-2.5 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-50">🍳 午餐计划吃这个</button>
            <button onClick={() => recordMut.mutate("dinner")} disabled={recordMut.isPending} className="flex-1 py-2.5 rounded-full text-sm font-semibold bg-mint text-white transition-all active:scale-96 disabled:opacity-50">🍲 晚餐计划吃这个</button>
          </>
        )}
        </section>

        {dishRecords.length > 0 && (
          <div className="mb-6">
            <SectionHeader title={<span className="flex items-center gap-2">📜 做菜回忆</span>} />

            {/* 评分趋势：随次数变化的评分折线（固定点距横向滚动，避免 preserveAspectRatio 拉伸变形） */}
            {(() => {
              const rated = dishRecords.filter((r) => r.rating > 0).slice().reverse()
              if (rated.length < 2) return null
              const H = 56, PAD = 10, STEP = 44
              const W = PAD * 2 + STEP * (rated.length - 1)
              const yFor = (rating: number) => H - PAD - ((rating - 1) / 4) * (H - PAD * 2)
              const pts = rated.map((r, i) => `${PAD + i * STEP},${yFor(r.rating)}`).join(" ")
              const last = rated[rated.length - 1]
              const trendUp = last.rating >= rated[0].rating
              return (
                <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-4 mb-4`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[13px] font-bold">📈 评分趋势</div>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${trendUp ? "bg-mint-light text-mint" : "bg-bg text-text3"}`}>
                      最近一次 {last.rating} 分
                    </span>
                  </div>
                  <div className="overflow-x-auto scrollbar-none scroll-fade-x">
                    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="max-w-none">
                      <polyline points={pts} fill="none" stroke="var(--k-red)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                      {rated.map((r, i) => (
                        <g key={i}>
                          <circle cx={PAD + i * STEP} cy={yFor(r.rating)} r="3.5" fill="var(--k-card)" stroke="var(--k-red)" strokeWidth="1.5" />
                          <text x={PAD + i * STEP} y={yFor(r.rating) - 9} textAnchor="middle" fontSize="9" fill="var(--k-muted)">{r.rating}分</text>
                        </g>
                      ))}
                    </svg>
                  </div>
                  <div className="flex justify-between text-[11px] text-text3 mt-1">
                    <span>{rated[0].meal_date.slice(5)}</span>
                    <span>{last.meal_date.slice(5)}</span>
                  </div>
                </div>
              )
            })()}

            {allPhotos.length > 0 && (
              <div className="mb-4">
                <div className="text-[11px] text-text3 mb-2">📷 回忆照片 ({allPhotos.length})</div>
                <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
                  {allPhotos.map((p, i) => (
                    <div
                      key={i}
                      onClick={() => { setViewerPhotos(allPhotos.map(x => x.url)); setViewerIdx(i); setShowViewer(true) }}
                      className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-card border border-border cursor-pointer active:scale-95 transition-transform shadow-sm"
                    >
                      <img src={thumbUrl(p.url)} alt="" className="w-full h-full object-cover" loading="lazy" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="relative">
              <div className="absolute left-[15px] top-1 bottom-1 w-[2px] bg-border" />
              <div className="flex flex-col">
                {dishRecords.slice(0, 10).map((r) => (
                  <div key={r.id} className="relative pl-10 pb-4">
                    <div className="absolute left-[9px] top-1.5 w-[14px] h-[14px] rounded-full border-2 border-primary bg-card z-10 flex items-center justify-center">
                      <div className={`w-[6px] h-[6px] rounded-full ${r.meal_type === "lunch" ? "bg-primary" : "bg-mint"}`} />
                    </div>
                    <div className={`bg-card rounded-xl p-3 border border-border ${cardShadow}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold">{formatRelativeDate(r.meal_date)}</span>
                          <span className="text-[11px] text-text3">{formatWeekday(r.meal_date)}</span>
                          <span className={`px-1.5 py-px rounded-full text-[11px] font-medium ${r.meal_type === "lunch" ? "bg-primary-light text-primary" : "bg-mint-light text-mint"}`}>
                            {r.meal_type === "lunch" ? "午餐" : "晚餐"}
                          </span>
                        </div>
                        {r.mood && (
                          <span className="text-lg">{moodEmojiMap[r.mood]}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.rating > 0 && (
                          <div className="flex items-center gap-0.5">
                            {[1, 2, 3, 4, 5].map((s) => (
                              <Star key={s} size={10} className={s <= r.rating ? "text-yellow fill-yellow" : "text-text4"} />
                            ))}
                          </div>
                        )}
                        {r.home_mood && (
                          <span className="text-[11px] text-text3 flex items-center gap-0.5 bg-bg px-1.5 py-px rounded-full">
                            {homeMoodEmojiMap[r.home_mood]} {homeMoodLabelMap[r.home_mood]}
                          </span>
                        )}
                        {r.remark && (
                          <span className="text-[11px] text-text2">"{r.remark}"</span>
                        )}
                      </div>
                      {(r.photo || r.photos.length > 0) && (
                        <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-none">
                          {r.photo && (
                            <div
                              onClick={() => { const all = [r.photo, ...r.photos]; setViewerPhotos(all); setViewerIdx(0); setShowViewer(true) }}
                              className="w-14 h-14 rounded-md overflow-hidden flex-shrink-0 cursor-pointer active:scale-95 transition-transform border border-primary/20 ring-1 ring-primary/10"
                            >
                              <img src={thumbUrl(r.photo)} alt="" className="w-full h-full object-cover" loading="lazy" />
                            </div>
                          )}
                          {r.photos.slice(0, r.photo ? 3 : 4).map((p, pi) => (
                            <div
                              key={pi}
                              onClick={() => { const all = r.photo ? [r.photo, ...r.photos] : r.photos; setViewerPhotos(all); setViewerIdx(r.photo ? pi + 1 : pi); setShowViewer(true) }}
                              className="w-11 h-11 rounded-md overflow-hidden flex-shrink-0 cursor-pointer active:scale-95 transition-transform border border-border"
                            >
                              <img src={thumbUrl(p)} alt="" className="w-full h-full object-cover" loading="lazy" />
                            </div>
                          ))}
                          {(r.photo ? r.photos.length - 3 : r.photos.length - 4) > 0 && (
                            <div className="w-11 h-11 rounded-md flex-shrink-0 bg-bg border border-border2 flex items-center justify-center text-[11px] text-text3 font-medium">+{r.photo ? r.photos.length - 3 : r.photos.length - 4}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {sameCategoryDishes.length > 0 && (
          <div className="mb-6">
            <SectionHeader title={<span className="flex items-center gap-2">🍽 同类菜品</span>} />
            <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1">
              {sameCategoryDishes.map((d: Dish) => (
                <div key={d.id} className="w-[130px] flex-shrink-0" onClick={() => navigate(`/dishes/${d.id}`)}>
                  <DishCard dish={d} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="recipe-cook-dock">
        <div className="recipe-cook-summary"><strong>{portionLabel(portionScale)}{dish.cook_time > 0 ? ` · 约 ${dish.cook_time} 分钟` : ""}</strong><span>{canCook ? (portionChanged ? "开始前会保存当前份量" : "食材齐了，就开火吧") : linkedRecord?.status === "completed" ? "这道菜，已经吃过了" : "查看这份用餐计划"}</span></div>
        {canCook ? <button type="button" onClick={startCooking} disabled={portionMut.isPending} className="recipe-cook-primary"><Flame size={18} />{portionMut.isPending ? "保存中…" : "开始做菜"}</button> : <button type="button" onClick={() => navigate("/history")} className="recipe-cook-primary">查看记录</button>}
      </div>

      {showViewer && viewerPhotos.length > 0 && createPortal(
        <PhotoViewer photos={viewerPhotos} idx={viewerIdx} setIdx={setViewerIdx} onClose={() => setShowViewer(false)} />,
        document.body
      )}
    </div>
  )
}
