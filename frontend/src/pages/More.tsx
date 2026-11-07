import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient, useMutationState } from "@tanstack/react-query"
import { achievementsApi, weekPlanApi, shoppingListApi, settingsApi, recordsApi, getUploadErrorMessage } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import { asString } from "@/lib/utils"
import { Flip, gsap, motionDuration, useGSAP } from "@/lib/gsap"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import StockInSheet, { type StockInCandidate } from "@/components/StockInSheet"
import PageHeader from "@/components/PageHeader"
import { cardShadow } from "@/components/Card"
import type { Achievement, WeekDayPlan, ShoppingCategory, ShoppingItem, MealRecord } from "@/types"
import toast from "react-hot-toast"
import { Menu } from "lucide-react"
import { isAxiosError } from "axios"

function getTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function getTomorrowStr() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const dayOrder: Record<string, number> = { "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6, "周日": 7 }

// 买菜清单里的"配料"大多是家里常备的调料：默认收起，不计入待买
const STAPLES_CATEGORY = "配料"

function needsShopping(item: ShoppingItem) {
  return item.needs_buy ?? (!item.checked && !item.in_stock)
}

function pendingShoppingAmount(item: ShoppingItem) {
  return item.pending_amount || item.amount
}
const STAPLES_OPEN_KEY = "shopping_staples_open"

function shoppingMutationName(variables: unknown): string | undefined {
  if (typeof variables === "string") return variables
  if (variables && typeof variables === "object" && "item_name" in variables && typeof variables.item_name === "string") return variables.item_name
}

// 复制到剪贴板：局域网 http 访问时没有 navigator.clipboard，退回 execCommand
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    ta.remove()
    return ok
  } catch {
    return false
  }
}

type MealKey = "lunch" | "dinner"

const MEAL_SECTIONS: { key: MealKey; label: string; titleClass: string; rowClass: string }[] = [
  { key: "lunch", label: "🍳 午餐", titleClass: "text-primary", rowClass: "bg-primary-light text-primary" },
  { key: "dinner", label: "🍲 晚餐", titleClass: "text-mint", rowClass: "bg-mint-light text-[#2E8577]" },
]

// 某一天的菜单：每道菜都能单独换；今天、明天还能一键加入计划和买菜清单
function WeekDaySheet({ day, dateLabel, canRecord, swappingKey, editing, recording, onSwap, onConfirm, onClose }: {
  day: WeekDayPlan
  dateLabel: string
  canRecord: boolean
  swappingKey: string | null // 正在换的那道菜 `${meal}-${dishId}`，换菜进行中时其余按钮也禁用
  editing: boolean
  recording: boolean
  onSwap: (meal: MealKey, dishId: number) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const busy = editing || swappingKey !== null
  return (
    <AnimatedBottomSheet onClose={onClose} className="flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-t-3xl p-5 pb-[max(2rem,env(safe-area-inset-bottom))] shadow-[0_-4px_24px_rgba(0,0,0,.12)]">
      {({ close }) => (
      <>
        <div className="shrink-0">
          <div className="w-10 h-1 rounded-full bg-border2 mx-auto mb-4" />
          <div className="text-lg font-bold mb-1">{canRecord ? `快速点菜 · ${dateLabel}` : `${dateLabel}的菜单`}</div>
          <div className="text-xs text-text2 mb-4">{day.date.slice(5)} {day.day_name} · 不想吃哪道，点「换一道」</div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {MEAL_SECTIONS.map(({ key, label, titleClass, rowClass }) => day[key].length > 0 && (
            <div key={key} className="mb-4">
              <div className={`text-xs font-semibold mb-1.5 ${titleClass}`}>{label}</div>
              <div className="flex flex-col gap-1.5">
                {day[key].map((d) => (
                  <div key={d.id} className={`flex items-center gap-2 pl-3 pr-1 py-1 rounded-xl ${rowClass}`}>
                    <span className="flex-1 min-w-0 truncate text-sm font-medium">{d.name}</span>
                    <button
                      onClick={() => onSwap(key, d.id)}
                      disabled={busy || recording}
                      className="shrink-0 px-3.5 py-2.5 rounded-full text-xs font-semibold bg-card text-text2 border border-border transition-all active:scale-95 disabled:opacity-50"
                    >
                      {swappingKey === `${key}-${d.id}` ? "换菜中…" : "换一道"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="shrink-0 pt-1">
          {canRecord ? (
            <div className="flex gap-3">
              <button onClick={close} className="flex-1 py-2.5 rounded-full text-sm font-semibold border-[1.5px] border-border transition-all active:scale-96">取消</button>
              <button
                onClick={onConfirm}
                disabled={busy || recording}
                className="flex-1 py-2.5 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-60"
              >
                {recording ? "记录中…" : "确认点菜"}
              </button>
            </div>
          ) : (
            <>
              <div className="text-xs text-text3 text-center mb-3">到了前一天就能一键点菜，食材会进买菜清单</div>
              <button onClick={close} className="w-full py-2.5 rounded-full text-sm font-semibold border-[1.5px] border-border transition-all active:scale-96">好了</button>
            </>
          )}
        </div>
      </>
      )}
    </AnimatedBottomSheet>
  )
}

function WeekDayCard({ day, todayStr, tomorrowStr, navigate, onCardClick }: {
  day: WeekDayPlan
  todayStr: string
  tomorrowStr: string
  navigate: (path: string) => void
  onCardClick: () => void
}) {
  // 今天及以后的菜单可以点开换菜（日期是 YYYY-MM-DD，可以直接按字符串比较）
  const canOpen = day.date >= todayStr && (day.lunch.length > 0 || day.dinner.length > 0)
  return (
    <div
      onClick={() => { if (canOpen) onCardClick() }}
      className={`bg-card rounded-2xl p-3.5 px-4 shadow-[0_1px_3px_rgba(0,0,0,.04),0_4px_12px_rgba(0,0,0,.04)] border border-border ${canOpen ? "cursor-pointer active:scale-98" : ""}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-bold">
          {day.day_name}{" "}
          {day.date === todayStr ? <span className="text-primary text-xs">今天</span> : day.date === tomorrowStr ? <span className="text-mint text-xs">明天</span> : null}
        </div>
        <div className="text-[11px] text-text2">{day.date.slice(5)}{canOpen && <span className="ml-1 text-text3">›</span>}</div>
      </div>
      <div className="flex flex-col gap-1.5">
        {day.lunch.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-primary font-semibold w-8 shrink-0">午餐</span>
            <div className="flex flex-wrap gap-1.5">
              {day.lunch.map((dish) => (
                <div
                  key={dish.id}
                  onClick={(e) => { e.stopPropagation(); navigate(`/dishes/${dish.id}`) }}
                  className="px-2.5 py-1 rounded-[8px] text-xs bg-primary-light text-primary font-medium cursor-pointer active:scale-95 transition-all"
                >
                  {dish.name}
                </div>
              ))}
            </div>
          </div>
        )}
        {day.dinner.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-mint font-semibold w-8 shrink-0">晚餐</span>
            <div className="flex flex-wrap gap-1.5">
              {day.dinner.map((dish) => (
                <div
                  key={dish.id}
                  onClick={(e) => { e.stopPropagation(); navigate(`/dishes/${dish.id}`) }}
                  className="px-2.5 py-1 rounded-[8px] text-xs bg-mint-light text-mint font-medium cursor-pointer active:scale-95 transition-all"
                >
                  {dish.name}
                </div>
              ))}
            </div>
          </div>
        )}
        {day.lunch.length === 0 && day.dinner.length === 0 && (
          <div className="text-xs text-text3 py-1">暂无菜品</div>
        )}
      </div>
    </div>
  )
}

export default function More() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  // 请求状态由 QueryClient 保留：去冰箱再返回时，同一食材仍不能重复提交。
  const pendingNames = useMutationState({
    filters: { mutationKey: ["shopping-edit"], status: "pending" },
    select: (mutation) => shoppingMutationName(mutation.state.variables),
  })
  const pendingShopping = new Set(pendingNames)
  const shoppingEdits = pendingNames.length

  const { data: rawAchievements } = useQuery({ queryKey: ["achievements"], queryFn: () => achievementsApi.list() })
  const achievements = Array.isArray(rawAchievements) ? rawAchievements : []
  const weekPlanEdits = useMutationState({ filters: { mutationKey: ["week-plan-edit"], status: "pending" } }).length
  const { data: weekPlan, isPending: weekPlanLoading, isError: weekPlanError, isFetching: weekPlanFetching, refetch: reloadWeekPlan } = useQuery({
    queryKey: ["week-plan"], queryFn: () => weekPlanApi.get(), enabled: weekPlanEdits === 0,
  })
  const { data: rawShoppingList, isPending: shoppingLoading, isError: shoppingError, isFetching: shoppingFetching, refetch: reloadShopping } = useQuery({
    queryKey: ["shopping-list"], queryFn: () => shoppingListApi.get(), staleTime: 0,
    // 写入时保留已确认的采购数量；最后一个请求结束后读取新的待买/待入库差额。
    enabled: shoppingEdits === 0,
  })
  const shoppingList = rawShoppingList ?? []
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => settingsApi.get() })

  const [showAllWeekDays, setShowAllWeekDays] = useState(false)
  // 记日期而不是那天的快照：换菜后弹层直接显示最新菜单
  const [sheetDate, setSheetDate] = useState<string | null>(null)
  const [showStockIn, setShowStockIn] = useState(false)
  const [onlyNeedBuy, setOnlyNeedBuy] = useState(false)
  const shoppingRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (location.pathname !== "/more" || location.hash !== "#shopping") return
    // MainLayout 保留各 tab；只滚动当前页，避免 scrollIntoView 推动横向 tab 容器。
    const frame = requestAnimationFrame(() => {
      const section = shoppingRef.current
      const scroller = section?.closest<HTMLElement>("[data-tab-scroll]")
      if (section && scroller) {
        scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.hash, location.key])

  function startShoppingEdit(name: string, action: () => void) {
    // 直接读取同步状态，也挡住 React 尚未重绘时的连续点击。
    if (qc.getMutationCache().findAll({ mutationKey: ["shopping-edit"], status: "pending" })
      .some((mutation) => shoppingMutationName(mutation.state.variables) === name)) return
    action()
  }

  // 常备调料（生抽、白糖……）默认收起；展开状态记在本机
  const [showStaples, setShowStaples] = useState(() => {
    try { return localStorage.getItem(STAPLES_OPEN_KEY) === "1" } catch { return false }
  })
  const toggleStaples = () => {
    setShowStaples((open) => {
      try { localStorage.setItem(STAPLES_OPEN_KEY, open ? "0" : "1") } catch { /* 隐私模式忽略 */ }
      return !open
    })
  }
  const weekListRef = useRef<HTMLDivElement>(null)
  const flipStateRef = useRef<ReturnType<typeof Flip.getState> | null>(null)

  const { contextSafe } = useGSAP(() => undefined, { scope: weekListRef })

  const regenerateMut = useMutation({
    mutationKey: ["week-plan-edit", "regenerate"],
    mutationFn: () => weekPlanApi.regenerate(),
    onMutate: () => qc.cancelQueries({ queryKey: ["week-plan"] }),
    onSuccess: async (plan) => {
      await qc.cancelQueries({ queryKey: ["week-plan"] })
      qc.setQueryData(["week-plan"], plan)
      qc.invalidateQueries({ queryKey: ["achievements"] })
      if (plan.days?.length) toast.success("已重新生成并保存")
      else toast("暂时没有可用的菜品", { icon: "ℹ️" })
    },
    onError: (err: unknown) => toast.error(getUploadErrorMessage(err, "重新生成未保存，请重试")),
  })

  const swapMut = useMutation({
    mutationKey: ["week-plan-edit", "swap"],
    mutationFn: (v: { date: string; meal_type: MealKey; dish_id: number }) => weekPlanApi.swap(v),
    onMutate: () => qc.cancelQueries({ queryKey: ["week-plan"] }),
    onSuccess: async ({ plan, dish }) => {
      await qc.cancelQueries({ queryKey: ["week-plan"] })
      qc.setQueryData(["week-plan"], plan)
      toast.success(`换成了「${dish.name}」`)
    },
    onError: (err: unknown) => {
      // 菜单在别处变过（重新生成、停用了菜……）：刷新成最新的再换
      if (isAxiosError(err) && err.response?.status === 409) {
        qc.invalidateQueries({ queryKey: ["week-plan"] })
      }
      toast.error(getUploadErrorMessage(err, "换菜失败，稍后再试"))
    },
  })
  function startWeekPlanEdit(action: () => void) {
    if (qc.isMutating({ mutationKey: ["week-plan-edit"] }) > 0) return
    action()
  }
  const swappingKey = swapMut.isPending && swapMut.variables ? `${swapMut.variables.meal_type}-${swapMut.variables.dish_id}` : null

  const recordMut = useMutation({
    mutationFn: (data: Partial<MealRecord>[]) => recordsApi.batchCreate(data),
    onSuccess: ({ created, skipped, failed }) => {
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      qc.invalidateQueries({ queryKey: ["record"] })
      qc.invalidateQueries({ queryKey: ["dish-records"] })
      qc.invalidateQueries({ queryKey: ["admin", "records"] })
      // 按实际结果提示：全部已记录过/部分失败都不能笼统地说"已记录"
      const n = created?.length ?? 0
      if (n === 0) {
        if (failed > 0) toast.error(`保存失败 ${failed} 道，请重试`)
        else toast("这些菜已在菜单中", { icon: "ℹ️" })
      } else {
        const extra = [skipped > 0 ? `${skipped} 道已在菜单中` : "", failed > 0 ? `${failed} 道失败` : ""].filter(Boolean).join("，")
        if (failed > 0) toast.error(`已加入计划 ${n} 道，${extra}`)
        else toast.success(extra ? `已加入计划 ${n} 道（${extra}）` : "已加入计划，吃过后到记录页确认")
      }
      setSheetDate(null)
    },
    onError: () => toast.error("记录失败"),
  })

  const checkMut = useMutation({
    mutationKey: ["shopping-edit", "check"],
    mutationFn: (data: { item_name: string; meal_date: string; checked: boolean; demand_version: string }) =>
      shoppingListApi.toggle(data),
    retry: false,
    onMutate: () => qc.cancelQueries({ queryKey: ["shopping-list"] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["achievements"] })
    },
    onError: (err: unknown) => {
      toast.error(getUploadErrorMessage(err, "勾选未保存，请重试"))
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["shopping-list"] }),
  })

  const inventoryMut = useMutation({
    mutationKey: ["shopping-edit", "inventory"],
    mutationFn: (data: { item_name: string; in_stock: boolean; inventory_version?: string }) =>
      shoppingListApi.setInventory(data),
    retry: false,
    onMutate: () => qc.cancelQueries({ queryKey: ["shopping-list"] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["achievements"] })
      // "家中有"会增删冰箱批次
      qc.invalidateQueries({ queryKey: ["fridge"] })
      qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
      qc.invalidateQueries({ queryKey: ["fridge-urgent"] })
    },
    onError: (err: unknown) => {
      toast.error(getUploadErrorMessage(err, "库存状态更新失败"))
      if (isAxiosError(err) && err.response?.status === 409) {
        for (const key of ["fridge", "fridge-recipes", "fridge-urgent"]) {
          void qc.invalidateQueries({ queryKey: [key] })
        }
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["shopping-list"] }),
  })

  // 误点补料的撤销入口：只删补料条目
  const removeItemMut = useMutation({
    mutationKey: ["shopping-edit", "remove"],
    mutationFn: (itemName: string) => shoppingListApi.removeItem(itemName),
    onMutate: () => qc.cancelQueries({ queryKey: ["shopping-list"] }),
    onSuccess: () => {
      toast.success("已从清单移除")
    },
    onError: () => toast.error("移除失败，稍后再试"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["shopping-list"] }),
  })

  const settingsMut = useMutation({
    mutationFn: (s: Record<string, string>) => settingsApi.update(s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      toast.success("已更新")
    },
  })

  function toggleSetting(key: string, currentVal: string) {
    const newVal = currentVal === "1" ? "0" : "1"
    settingsMut.mutate({ [key]: newVal })
  }

  function handleConfirmRecord(day: WeekDayPlan) {
    if (qc.isMutating({ mutationKey: ["week-plan-edit"] }) > 0) return
    const data: Partial<MealRecord>[] = []
    day.lunch.forEach((d) => data.push({ dish_id: d.id, dish_name: d.name, meal_type: "lunch", meal_date: day.date, status: "planned" }))
    day.dinner.forEach((d) => data.push({ dish_id: d.id, dish_name: d.name, meal_type: "dinner", meal_date: day.date, status: "planned" }))
    if (data.length > 0) recordMut.mutate(data)
  }

  const unlockedCount = achievements.filter((a: Achievement) => a.is_unlocked).length
  // 计数只算真正要去买的（蔬菜/肉类/其他）；常备调料单独收起
  const mainCategories = shoppingList.filter((cat: ShoppingCategory) => cat.category !== STAPLES_CATEGORY)
  const stapleItems = shoppingList.find((cat: ShoppingCategory) => cat.category === STAPLES_CATEGORY)?.items || []
  const mainItems = mainCategories.flatMap((cat: ShoppingCategory) => cat.items)
  const totalChecked = mainItems.filter((item) => item.checked).length
  const totalInStock = mainItems.filter((item) => item.in_stock && !needsShopping(item)).length
  const totalItems = shoppingList.reduce((acc: number, cat: ShoppingCategory) => acc + cat.items.length, 0)
  const needBuyItems = mainItems.filter(needsShopping).length
  const stapleNeedCount = stapleItems.filter(needsShopping).length
  const visibleCategories = onlyNeedBuy
    ? mainCategories.map((cat) => ({ ...cat, items: cat.items.filter(needsShopping) })).filter((cat) => cat.items.length > 0)
    : mainCategories
  const visibleStaples = onlyNeedBuy ? stapleItems.filter(needsShopping) : stapleItems

  // 买菜清单的一行（普通函数而不是组件：避免每次渲染都重新挂载行）。
  // 行里的小按钮用透明的 ::after 把点击区撑大、外观不变；删除 × 向左不扩，免得点"库存"误删
  const renderShoppingRow = (item: ShoppingItem) => (
    <div key={item.name} className={`flex items-center gap-2.5 py-1.5 text-sm ${item.in_stock && !needsShopping(item) ? "opacity-70" : ""}`}>
      <button
        onClick={() => startShoppingEdit(item.name, () => checkMut.mutate({ item_name: item.name, meal_date: getTodayStr(), checked: !item.checked, demand_version: item.demand_version }))}
        disabled={(item.in_stock && !needsShopping(item)) || pendingShopping.has(item.name)}
        aria-label={`${item.checked ? "取消已买" : "标记已买"}${item.name}`}
        aria-pressed={item.checked}
        className={`relative after:absolute after:-inset-x-2.5 after:-inset-y-1.5 w-[22px] h-[22px] rounded-md border-2 flex items-center justify-center text-xs flex-shrink-0 transition-all ${item.checked ? "bg-mint border-mint text-white" : item.in_stock && !needsShopping(item) ? "bg-yellow-light border-yellow text-yellow" : "border-border2 text-transparent"}`}
      >{item.in_stock && !needsShopping(item) ? "家" : "✓"}</button>
      <span className={`min-w-0 break-words transition-all ${!needsShopping(item) && (item.checked || item.in_stock) ? "line-through text-text3" : ""}`}>{item.name}</span>
      <div className="ml-auto flex items-center gap-2.5 flex-shrink-0">
        <span className="text-xs text-text3 text-right">
          {needsShopping(item) && item.pending_review ? <>
            <span className="block text-text2">用量待核对</span>
            <span className="block text-[11px]">需 {item.amount}</span>
          </> : needsShopping(item) && pendingShoppingAmount(item) !== item.amount ? <>
            <span className="block text-text2">待买 {pendingShoppingAmount(item)}</span>
            <span className="block text-[11px]">共 {item.amount}</span>
          </> : item.amount}
        </span>
        <button
          onClick={() => {
            // 取消"家中有"会把冰箱里这个食材的批次一起移出，先确认
            if (item.in_stock && item.stock_batches > 0 &&
              !confirm(`取消后会从冰箱移出 ${item.stock_batches} 批「${item.name}」，确定吗？`)) return
            startShoppingEdit(item.name, () => inventoryMut.mutate({ item_name: item.name, in_stock: !item.in_stock, inventory_version: item.inventory_version }))
          }}
          disabled={pendingShopping.has(item.name)}
          aria-label={`${item.in_stock ? "取消家中有" : "标记家中有"}${item.name}`}
          className={`relative after:absolute after:-inset-x-1 after:-inset-y-2 px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-all active:scale-95 disabled:opacity-60 ${item.in_stock ? "bg-yellow-light text-yellow border-yellow/30" : "bg-bg text-text3 border-border"}`}
        >
          {item.in_stock ? needsShopping(item) ? "有库存" : "家中有" : "库存"}
        </button>
        {item.removable && (
          <button
            onClick={() => startShoppingEdit(item.name, () => removeItemMut.mutate(item.name))}
            disabled={pendingShopping.has(item.name)}
            aria-label={`从清单移除${item.name}`}
            className="relative after:absolute after:-inset-y-2 after:-right-2.5 after:left-0 w-5 h-5 rounded-full flex items-center justify-center text-text3 text-base leading-none transition-all hover:bg-black/5 active:scale-90 disabled:opacity-50"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )

  // 复制还要买的（文字版，方便发给去买菜的家人）；展开了常备调料时一并带上
  const copyShoppingList = async () => {
    const amountText = (amount: string) => (amount && amount !== "适量" ? ` ${amount}` : "")
    const sections = mainCategories
      .map((cat: ShoppingCategory) => {
        const need = cat.items.filter(needsShopping)
        return need.length > 0 ? `${cat.category}：${need.map((i) => i.name + amountText(pendingShoppingAmount(i)) + (i.pending_review ? "（用量待核对）" : "")).join("、")}` : ""
      })
      .filter(Boolean)
    if (showStaples) {
      const staples = stapleItems.filter(needsShopping)
      if (staples.length > 0) sections.push(`调料：${staples.map((i) => i.name).join("、")}`)
    }
    if (sections.length === 0) {
      toast("清单上的都买齐了", { icon: "✅" })
      return
    }
    const d = new Date()
    const ok = await copyText([`🛒 买菜清单（${d.getMonth() + 1}月${d.getDate()}日）`, ...sections].join("\n"))
    if (ok) toast.success("已复制，可以粘贴发给家人")
    else toast.error("复制失败，可以长按清单手动选择")
  }
  // 已买、还没放进冰箱的食材（调料不放冰箱）：买菜回来一键入库
  const stockInCandidates: StockInCandidate[] = shoppingList.flatMap((cat: ShoppingCategory) =>
    cat.category === "配料"
      ? []
      : cat.items
        .filter((item) => item.stock_in_amount !== undefined ? !!item.stock_in_amount : item.checked && !item.stocked && !item.in_stock)
        .map((item) => ({ name: item.name, amount: item.stock_in_amount || item.amount, category: cat.category })),
  )

  const days = (weekPlan?.days || []).slice().sort((a: WeekDayPlan, b: WeekDayPlan) => (dayOrder[a.day_name] || 0) - (dayOrder[b.day_name] || 0))
  const todayStr = getTodayStr()
  const tomorrowStr = getTomorrowStr()
  const defaultDays = days.filter((d: WeekDayPlan) => d.date === todayStr || d.date === tomorrowStr)
  const collapsedDays = defaultDays.length > 0 ? defaultDays : days.slice(0, 2)
  const displayDays = showAllWeekDays ? days : collapsedDays
  const sheetDay = sheetDate ? days.find((d: WeekDayPlan) => d.date === sheetDate) : undefined

  useGSAP(() => {
    const state = flipStateRef.current
    flipStateRef.current = null
    if (!state) return
    Flip.from(state, {
      duration: motionDuration(0.3),
      ease: "power2.out",
      absolute: false,
      nested: true,
      onEnter: (elements) => gsap.fromTo(elements, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: motionDuration(0.24), stagger: 0.03 }),
      onLeave: (elements) => gsap.to(elements, { autoAlpha: 0, y: -8, duration: motionDuration(0.18) }),
    })
  }, { dependencies: [displayDays], scope: weekListRef })

  // contextSafe 只是把回调包一层（登记到 GSAP 上下文便于卸载时清理），ref 在点击时才读；
  // react-hooks/refs 把"把读 ref 的函数传给 contextSafe"当成渲染时读 ref，属误报
  // eslint-disable-next-line react-hooks/refs
  const toggleWeekDays = contextSafe(() => {
    if (weekListRef.current) {
      flipStateRef.current = Flip.getState(".week-day-card", { props: "opacity,transform" })
    }
    setShowAllWeekDays((value) => !value)
  })

  const previewAchievements = achievements
    .slice()
    .sort((a: Achievement, b: Achievement) => {
      if (a.is_unlocked !== b.is_unlocked) return a.is_unlocked ? -1 : 1
      return a.id - b.id
    })
    .slice(0, 3)

  return (
    <div className="animate-fadeUp">
      <PageHeader title="更多" subtitle="买菜清单、一周菜单和设置" icon={Menu} />

      <div className="px-5 py-4 max-w-[640px] mx-auto">
        <section ref={shoppingRef} id="shopping" aria-label="买菜清单">
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <div>
            <h2 className="text-lg font-bold">🛒 买菜清单</h2>
            <div className="text-xs text-text2 mt-0.5">今天 + 明天要用的食材</div>
          </div>
          {totalItems > 0 && (
              <button
                onClick={copyShoppingList}
                className="shrink-0 px-3 py-2.5 rounded-full text-xs font-semibold bg-card border border-border text-text2 transition-all active:scale-95"
              >
                复制待买
              </button>
          )}
        </div>
        {totalItems > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-xs text-text2">
              <span className="font-semibold text-text">待买 {needBuyItems}</span> · 已买 {totalChecked} · 家中 {totalInStock}
            </div>
            <button
              onClick={() => setOnlyNeedBuy((value) => !value)}
              aria-pressed={onlyNeedBuy}
              className={`min-h-9 px-3 rounded-full text-xs font-semibold border transition-all active:scale-95 ${onlyNeedBuy ? "bg-primary-light text-primary border-primary/20" : "bg-card text-text2 border-border"}`}
            >
              {onlyNeedBuy ? "✓ 只看待买" : "只看待买"}
            </button>
          </div>
        )}
        {shoppingError && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-text2">
            <span>{rawShoppingList ? "清单未能更新，正在显示上次内容" : "买菜清单加载失败"}</span>
            <button onClick={() => void reloadShopping()} disabled={shoppingFetching || shoppingEdits > 0} className="shrink-0 min-h-10 px-2 font-semibold text-primary disabled:opacity-50">{shoppingFetching ? "重试中…" : "重试"}</button>
          </div>
        )}
        <div className="bg-card rounded-2xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,.04),0_4px_12px_rgba(0,0,0,.04)] border border-border mb-7">
          {shoppingLoading ? (
            <div role="status" className="py-5 px-4 text-center text-sm text-text3">正在整理买菜清单…</div>
          ) : !rawShoppingList ? null : shoppingList.length === 0 ? (
            <div className="py-5 px-4 text-center text-sm text-text3">暂无买菜清单，点菜后自动生成今日+明日食材</div>
          ) : (
            <>
              {onlyNeedBuy && needBuyItems === 0 ? (
                <div className="py-5 px-4 text-center text-sm text-text2">主料已买齐，可以准备做饭了{stapleNeedCount > 0 ? "；常备调料也记得检查一下" : ""}</div>
              ) : mainCategories.length === 0 && (
                <div className="py-4 px-4 text-center text-[13px] text-text3">要买的只有家里常备的调料</div>
              )}
              {visibleCategories.map((cat: ShoppingCategory, ci: number) => (
                <div key={cat.category} className={`px-4 py-3 ${ci > 0 ? "border-t border-border" : ""}`}>
                  <div className="text-[13px] font-bold text-text2 mb-2 tracking-wide">{cat.category}</div>
                  {cat.items.map((item) => renderShoppingRow(item))}
                </div>
              ))}
              {visibleStaples.length > 0 && (
                <div className={`px-4 py-3 ${visibleCategories.length > 0 || onlyNeedBuy ? "border-t border-border" : ""}`}>
                  <button onClick={toggleStaples} aria-expanded={showStaples} className="w-full min-h-9 flex items-center justify-between text-left">
                    <span className="text-[13px] font-bold text-text2 tracking-wide">
                      常备调料 <span className="font-medium text-text3">· {visibleStaples.length} 样</span>
                    </span>
                    <span className="text-xs text-text3">
                      {showStaples ? "收起 ▴" : `家里一般都有${stapleNeedCount > 0 ? "，缺了再看" : ""} ▾`}
                    </span>
                  </button>
                  {showStaples && <div className="mt-2">{visibleStaples.map((item) => renderShoppingRow(item))}</div>}
                </div>
              )}
            </>
          )}
        </div>
        {stockInCandidates.length > 0 && (
          <button
            onClick={() => setShowStockIn(true)}
            disabled={shoppingEdits > 0 || shoppingFetching}
            className="w-full -mt-4 mb-7 py-2.5 rounded-xl text-sm font-bold text-[#2E8577] bg-mint-light transition-all active:scale-98 disabled:opacity-50"
          >
            🧊 把已买的 {stockInCandidates.length} 样放进冰箱
          </button>
        )}
        {showStockIn && <StockInSheet candidates={stockInCandidates} onClose={() => setShowStockIn(false)} />}
        </section>

        <button
          onClick={() => navigate("/fridge")}
          className={`w-full bg-card rounded-2xl p-4 ${cardShadow} border border-border flex items-center gap-3.5 transition-all active:scale-98 mb-7`}
        >
          <div className="w-12 h-12 rounded-[10px] bg-gradient-to-br from-mint-light to-yellow-light flex items-center justify-center text-2xl flex-shrink-0">🧊</div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[15px] font-bold mb-0.5">🧊 冰箱库存</div>
            <div className="text-xs text-text2">记下家里有什么，按食材找能做的菜</div>
          </div>
          <span className="text-text3 text-sm">›</span>
        </button>

        <div className="flex items-center justify-between mb-3.5">
          <div>
            <div className="text-lg font-bold">📅 一周菜单</div>
            {days.length > 0 && <div className="text-xs text-text3 mt-0.5">点开某一天，可以只换其中一道</div>}
          </div>
          <button
            onClick={() => startWeekPlanEdit(() => regenerateMut.mutate())}
            disabled={weekPlanEdits > 0}
            className={`text-sm font-semibold text-text2 hover:text-primary hover:bg-primary-light px-3 py-1.5 rounded-full transition-all ${weekPlanEdits > 0 ? "opacity-50 pointer-events-none" : ""}`}
          >
            {regenerateMut.isPending ? "生成中..." : "🔄 重新生成"}
          </button>
        </div>
        {weekPlanLoading && (
          <div role="status" className={`bg-card rounded-2xl border border-border ${cardShadow} p-5 text-center text-sm text-text3 mb-2`}>
            正在读取一周菜单…
          </div>
        )}
        {weekPlanError && (
          <div role="alert" className={`bg-card rounded-2xl border border-border ${cardShadow} p-5 text-center mb-2`}>
            <div className="text-sm font-semibold">{weekPlan ? "周菜单暂时无法更新" : "周菜单加载失败"}</div>
            <div className="text-xs text-text2 mt-1">{weekPlan ? "下方保留上次读取的菜单，可以重试更新。" : "请检查网络后重试。"}</div>
            <button type="button" onClick={() => { void reloadWeekPlan() }} disabled={weekPlanFetching || weekPlanEdits > 0} className="text-sm font-bold text-primary mt-3 disabled:opacity-50">
              {weekPlanFetching ? "正在重试…" : "重新加载菜单"}
            </button>
          </div>
        )}
        {weekPlan && days.length === 0 && (
          <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-5 text-center text-sm text-text3 mb-2`}>
            暂时排不出一周菜单：没有可用的菜品，或全部被「严格过滤」忌口排除了
          </div>
        )}
        <div ref={weekListRef} className="flex flex-col gap-2.5 mb-1">
          {displayDays.map((day: WeekDayPlan) => (
            <div
              key={day.date}
              className="week-day-card"
            >
              <WeekDayCard day={day} todayStr={todayStr} tomorrowStr={tomorrowStr} navigate={navigate} onCardClick={() => setSheetDate(day.date)} />
            </div>
          ))}
        </div>

        {days.length > 2 && (
          <button
            onClick={toggleWeekDays}
            className="w-full py-2 text-sm font-medium text-mint bg-mint-light/50 rounded-xl mt-2 mb-7 transition-all active:scale-98"
          >
            {showAllWeekDays ? "收起菜单" : "查看完整一周菜单 ▾"}
          </button>
        )}
        {days.length <= 2 && <div className="mb-7" />}

        <div className="flex items-center justify-between mb-3.5">
          <div className="text-lg font-bold">🏆 成就墙</div>
          <span className="text-xs text-text3 font-medium">{unlockedCount}/{achievements.length} 已解锁</span>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-2">
          {previewAchievements.map((a: Achievement) => (
            <div
              key={a.id}
              onClick={() => navigate("/achievements")}
              className={`bg-card rounded-2xl p-4 pt-5 text-center shadow-[0_1px_3px_rgba(0,0,0,.04),0_4px_12px_rgba(0,0,0,.04)] border transition-all relative overflow-hidden cursor-pointer active:scale-95 ${a.is_unlocked ? "border-primary/20" : "border-border opacity-35 grayscale-[.9]"}`}
            >
              {a.is_unlocked && <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary" />}
              <span className="text-[32px] block mb-1.5">{a.icon}</span>
              <div className="text-xs font-semibold mb-0.5 line-clamp-2 leading-4 min-h-[32px]">{a.name}</div>
              <div className="text-[11px] text-text2 line-clamp-2">{a.description}</div>
            </div>
          ))}
        </div>
        <button
          onClick={() => navigate("/achievements")}
          className="w-full py-2 text-sm font-medium text-primary bg-primary-light/50 rounded-xl mb-7 transition-all active:scale-98"
        >
          查看更多成就 ›
        </button>

        {isLoggedIn && (
          <>
            <div className="flex items-center justify-between mb-3.5 mt-7">
              <div className="text-lg font-bold">⚙ 设置</div>
            </div>
            <div className="bg-card rounded-2xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,.04),0_4px_12px_rgba(0,0,0,.04)] border border-border">
              <button onClick={() => toast(`推荐去重天数：${asString(settings?.repeat_days, "3")}天`)} className="w-full flex items-center justify-between px-4 py-3.5 border-b border-border transition-all active:bg-bg text-left">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-[10px] bg-primary-light flex items-center justify-center text-base">📅</div>
                  <div><div className="text-sm font-medium">推荐去重</div><div className="text-[11px] text-text2">近{asString(settings?.repeat_days, "3")}天吃过的菜不优先推荐</div></div>
                </div>
                <span className="text-text3 text-sm flex items-center gap-1">{asString(settings?.repeat_days, "3")}天 ›</span>
              </button>
              <button onClick={() => toggleSetting("voice_enabled", asString(settings?.voice_enabled, "1"))} className="w-full flex items-center justify-between px-4 py-3.5 border-b border-border transition-all active:bg-bg text-left">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-[10px] bg-mint-light flex items-center justify-center text-base">🔊</div>
                  <div><div className="text-sm font-medium">语音播报</div><div className="text-[11px] text-text2">做菜时语音朗读步骤</div></div>
                </div>
                <div className={`w-11 h-6 rounded-xl relative cursor-pointer transition-all ${settings?.voice_enabled !== "0" ? "bg-primary" : "bg-border2"}`}>
                  <div className={`absolute top-[2px] w-5 h-5 rounded-full bg-white shadow-sm transition-all ${settings?.voice_enabled !== "0" ? "left-[22px]" : "left-[2px]"}`} />
                </div>
              </button>
              <button onClick={() => toggleSetting("blind_box_enabled", asString(settings?.blind_box_enabled, "1"))} className="w-full flex items-center justify-between px-4 py-3.5 border-b border-border transition-all active:bg-bg text-left">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-[10px] bg-purple-light flex items-center justify-center text-base">🎁</div>
                  <div><div className="text-sm font-medium">惊喜盲盒</div><div className="text-[11px] text-text2">首页显示盲盒推荐</div></div>
                </div>
                <div className={`w-11 h-6 rounded-xl relative cursor-pointer transition-all ${settings?.blind_box_enabled !== "0" ? "bg-primary" : "bg-border2"}`}>
                  <div className={`absolute top-[2px] w-5 h-5 rounded-full bg-white shadow-sm transition-all ${settings?.blind_box_enabled !== "0" ? "left-[22px]" : "left-[2px]"}`} />
                </div>
              </button>
               <button onClick={() => navigate(isLoggedIn ? "/admin/dashboard" : "/admin/login")} className="w-full flex items-center justify-between px-4 py-3.5 transition-all active:bg-bg text-left">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-[10px] bg-pink-light flex items-center justify-center text-base">🔒</div>
                  <div><div className="text-sm font-medium">管理模式</div><div className="text-[11px] text-text2">管理菜品、推荐语、成就</div></div>
                </div>
                <span className="text-text3 text-sm">›</span>
              </button>
            </div>
          </>
        )}
      </div>

      {sheetDay && (
        <WeekDaySheet
          day={sheetDay}
          dateLabel={sheetDay.date === todayStr ? "今天" : sheetDay.date === tomorrowStr ? "明天" : sheetDay.day_name}
          canRecord={sheetDay.date === todayStr || sheetDay.date === tomorrowStr}
          swappingKey={swappingKey}
          editing={weekPlanEdits > 0}
          recording={recordMut.isPending}
          onSwap={(meal, dishId) => startWeekPlanEdit(() => swapMut.mutate({ date: sheetDay.date, meal_type: meal, dish_id: dishId }))}
          onConfirm={() => handleConfirmRecord(sheetDay)}
          onClose={() => setSheetDate(null)}
        />
      )}
    </div>
  )
}
