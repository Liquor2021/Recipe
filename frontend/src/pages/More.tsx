import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient, useMutationState } from "@tanstack/react-query"
import { achievementsApi, shoppingListApi, settingsApi, getUploadErrorMessage } from "@/api"
import { logoutApp } from "@/api/client"
import { ledgerApi } from "@/api/ledger"
import type { ShoppingPurchase } from "@/lib/ledger"
import ExpenseSheet from "@/components/ExpenseSheet"
import ShoppingLedgerToggle from "@/components/ShoppingLedgerToggle"
import { useAuthStore } from "@/store/useAuthStore"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import { asString } from "@/lib/utils"
import StockInSheet, { type StockInCandidate } from "@/components/StockInSheet"
import PageHeader from "@/components/PageHeader"
import type { Achievement, ShoppingCategory, ShoppingItem } from "@/types"
import toast from "react-hot-toast"
import { Menu, ShoppingBasket, Snowflake, CalendarDays, Trophy, ChevronRight, ChevronDown, Settings2, LockKeyhole, LogOut, NotebookPen } from "lucide-react"
import { isAxiosError } from "axios"
import "@/styles/kitchen-tools.css"
import WeekPlanner from "@/components/WeekPlanner"
import ShoppingScope from "@/components/ShoppingScope"

function getTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

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

export default function More() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const theme = useKitchenTheme((s) => s.theme)
  const toggleTheme = useKitchenTheme((s) => s.toggleTheme)
  // 请求状态由 QueryClient 保留：去冰箱再返回时，同一食材仍不能重复提交。
  const pendingNames = useMutationState({
    filters: { mutationKey: ["shopping-edit"], status: "pending" },
    select: (mutation) => shoppingMutationName(mutation.state.variables),
  })
  const pendingShopping = new Set(pendingNames)
  const shoppingEdits = pendingNames.length

  const { data: rawAchievements } = useQuery({ queryKey: ["achievements"], queryFn: () => achievementsApi.list() })
  const achievements = Array.isArray(rawAchievements) ? rawAchievements : []
  const { data: rawShoppingList, isPending: shoppingLoading, isError: shoppingError, isFetching: shoppingFetching, refetch: reloadShopping } = useQuery({
    queryKey: ["shopping-list"], queryFn: () => shoppingListApi.get(), staleTime: 0,
    // 写入时保留已确认的采购数量；最后一个请求结束后读取新的待买/待入库差额。
    enabled: shoppingEdits === 0,
  })
  const shoppingList = rawShoppingList ?? []
  const { data: ledgerSettings } = useQuery({ queryKey: ["ledger-settings"], queryFn: ledgerApi.settings })
  const [purchase, setPurchase] = useState<ShoppingPurchase | null>(null)
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => settingsApi.get() })

  const [showStockIn, setShowStockIn] = useState(false)
  const [onlyNeedBuy, setOnlyNeedBuy] = useState(false)
  const [shoppingOpen, setShoppingOpen] = useState(location.hash === "#shopping")
  const [weekOpen, setWeekOpen] = useState(location.hash === "#week")
  const shoppingRef = useRef<HTMLElement>(null)
  const { data: shoppingScope } = useQuery({ queryKey: ["shopping-settings"], queryFn: shoppingListApi.settings })
  useEffect(() => {
    if (location.pathname !== "/more" || location.hash !== "#week") return
    const frame = requestAnimationFrame(() => setWeekOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.hash, location.key])


  useEffect(() => {
    if (location.pathname !== "/more" || location.hash !== "#shopping") return
    const frame = requestAnimationFrame(() => setShoppingOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.hash, location.key])

  useLayoutEffect(() => {
    if (!shoppingOpen || shoppingLoading || location.pathname !== "/more" || location.hash !== "#shopping") return
    // 展开提交后再测量；旧的收起高度会把 scrollTop 截断。只滚动当前 tab。
    const section = shoppingRef.current
    const scroller = section?.closest<HTMLElement>("[data-tab-scroll]")
    if (!section || !scroller) return
    const header = section.closest(".k-more-page")?.querySelector<HTMLElement>(".kitchen-page-header")
    const headerHeight = header?.getBoundingClientRect().height ?? 0
    scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headerHeight - 12
  }, [shoppingOpen, shoppingLoading, location.pathname, location.hash, location.key])

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
  const checkMut = useMutation({
    mutationKey: ["shopping-edit", "check"],
    mutationFn: (data: { item_name: string; meal_date: string; checked: boolean; demand_version: string }) =>
      shoppingListApi.toggle(data),
    retry: false,
    onMutate: () => qc.cancelQueries({ queryKey: ["shopping-list"] }),
    onSuccess: (_, data) => {
      qc.invalidateQueries({ queryKey: ["achievements"] })
      if (!data.checked) toast("已取消勾选；已记支出仍保留，可到账本修改", { duration: 3500 })
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
    mutationFn: (item: { item_name: string; demand_version: string }) => shoppingListApi.removeItem(item.item_name, item.demand_version),
    onMutate: () => qc.cancelQueries({ queryKey: ["shopping-list"] }),
    onSuccess: () => {
      toast.success("已从清单移除")
    },
    onError: (err) => toast.error(getUploadErrorMessage(err, "移除失败，稍后再试")),
    onSettled: () => qc.invalidateQueries({ queryKey: ["shopping-list"] }),
  })

  const settingsMut = useMutation({
    mutationFn: (s: Record<string, string>) => settingsApi.update(s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      toast.success("已更新")
    },
    onError: (error) => toast.error(getUploadErrorMessage(error, "设置未保存，请重试")),
  })

  function toggleSetting(key: string, currentVal: string) {
    if (settingsMut.isPending) return
    const newVal = currentVal === "1" ? "0" : "1"
    settingsMut.mutate({ [key]: newVal })
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
        onClick={() => startShoppingEdit(item.name, () => {
          const data = { item_name: item.name, meal_date: getTodayStr(), checked: !item.checked, demand_version: item.demand_version }
          if (data.checked && ledgerSettings?.shopping_link_enabled) setPurchase(data)
          else checkMut.mutate(data)
        })}
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
            onClick={() => startShoppingEdit(item.name, () => removeItemMut.mutate({ item_name: item.name, demand_version: item.demand_version }))}
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
        .map((item) => ({ name: item.name, amount: item.stock_in_amount || item.amount, category: cat.category, demandVersion: item.demand_version })),
  )

  return (
    <div className="animate-fadeUp k-tools-page k-more-page">
      <PageHeader title="更多" meta="手册目录" icon={Menu} />

      <div className="px-5 py-4 max-w-[640px] mx-auto">
        <div className="k-more-shopping-cover">
          <button type="button" className="k-more-shopping-open" aria-expanded={shoppingOpen} aria-controls="shopping" onClick={() => setShoppingOpen(value => !value)}>
            <span className="k-more-shopping-title"><ShoppingBasket size={19} aria-hidden="true" /><strong>买菜清单</strong><span className="k-tool-leader" aria-hidden="true" /><small>{shoppingLoading ? "整理中" : shoppingError && !rawShoppingList ? "待重试" : `待买 ${needBuyItems} · 已买 ${totalChecked}`}</small></span>
            <span className="k-more-shopping-caption">{shoppingScope?.days === 7 ? "未来 7 天" : "今天 + 明天"}要用的食材，按分类收好了<ChevronDown size={16} className={shoppingOpen ? "is-expanded" : ""} aria-hidden="true" /></span>
          </button>
          {totalItems > 0 && <button type="button" className="k-tool-text-button k-more-copy" onClick={copyShoppingList}>复制待买</button>}
        </div>
        <section ref={shoppingRef} id="shopping" aria-label="买菜清单">
        <div hidden={!shoppingOpen} className="k-more-shopping-content">
        <h2 className="k-tool-section-title mb-3">「采购明细」</h2>
        <ShoppingScope />
        <ShoppingLedgerToggle />
        {totalItems > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-xs text-text2">
              <span className="font-semibold text-text">待买 {needBuyItems}</span> · 已买 {totalChecked} · 家中 {totalInStock}
            </div>
            <button
              onClick={() => setOnlyNeedBuy((value) => !value)}
              aria-pressed={onlyNeedBuy}
              className={`k-tool-chip ${onlyNeedBuy ? "is-active" : ""}`}
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
        <div className="k-more-shopping-paper">
          {shoppingLoading ? (
            <div role="status" className="py-5 px-4 text-center text-sm text-text3">正在整理买菜清单…</div>
          ) : !rawShoppingList ? null : shoppingList.length === 0 ? (
            <div className="py-5 px-4 text-center text-sm text-text3">暂无采购需求，安排菜单后自动汇总所选范围的食材</div>
          ) : (
            <>
              {onlyNeedBuy && needBuyItems === 0 ? (
                <div className="py-5 px-4 text-center text-sm text-text2">主料已买齐，可以准备做饭了{stapleNeedCount > 0 ? "；常备调料也记得检查一下" : ""}</div>
              ) : mainCategories.length === 0 && (
                <div className="py-4 px-4 text-center text-[13px] text-text3">要买的只有家里常备的调料</div>
              )}
              {visibleCategories.map((cat: ShoppingCategory, ci: number) => (
                <div key={cat.category} className={`px-4 py-3 ${ci > 0 ? "border-t border-border" : ""}`}>
                  <h3 className="k-more-shopping-category">{cat.category}</h3>
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
            className="k-tool-button w-full mb-5"
          >
            🧊 把已买的 {stockInCandidates.length} 样放进冰箱
          </button>
        )}
        </div>
        {showStockIn && <StockInSheet candidates={stockInCandidates} onClose={() => setShowStockIn(false)} />}
        {purchase && <ExpenseSheet purchase={purchase} onClose={() => setPurchase(null)} />}
        </section>

        <nav className="k-more-directory" aria-label="厨房手册目录">
          <button type="button" onClick={() => navigate("/fridge")} className="k-more-entry">
            <span className="k-more-entry-icon"><Snowflake size={20} aria-hidden="true" /></span>
            <strong>冰箱库存</strong><span className="k-tool-leader" aria-hidden="true" /><small>食材与保质期</small><ChevronRight size={17} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => navigate("/ledger")} className="k-more-entry">
            <span className="k-more-entry-icon"><NotebookPen size={20} aria-hidden="true" /></span>
            <strong>厨房账本</strong><span className="k-tool-leader" aria-hidden="true" /><small>柴米油盐的花销</small><ChevronRight size={17} aria-hidden="true" />
          </button>
          <button type="button" className="k-more-entry" aria-expanded={weekOpen} aria-controls="week-menu-pages" onClick={() => setWeekOpen(value => !value)}>
            <span className="k-more-entry-icon"><CalendarDays size={20} aria-hidden="true" /></span>
            <strong>一周菜单</strong><span className="k-tool-leader" aria-hidden="true" /><small>手选 · 加菜 · 钉住</small><ChevronRight className={weekOpen ? "is-expanded" : ""} size={17} aria-hidden="true" />
          </button>
        </nav>
        <section id="week-menu-pages" className="k-more-week-content">
          {weekOpen && <WeekPlanner />}
        </section>
        <nav className="k-more-directory" aria-label="更多厨房入口">
          <button type="button" className="k-more-entry" onClick={() => navigate("/achievements")}>
            <span className="k-more-entry-icon"><Trophy size={20} aria-hidden="true" /></span>
            <strong>成就墙</strong><span className="k-tool-leader" aria-hidden="true" /><small>{unlockedCount} / {achievements.length} 已解锁</small><ChevronRight size={17} aria-hidden="true" />
          </button>
        </nav>

        <section className="k-more-settings" aria-label="外观">
          <h2 className="k-tool-section-title">「外观」</h2>
          <button type="button" role="switch" aria-checked={theme === "night"} aria-label="深夜厨房" onClick={toggleTheme} className="k-more-setting">
            <span><strong>深夜厨房</strong><small>当前：{theme === "night" ? "深夜厨房" : "白日厨房"}</small></span>
            <span className="k-tool-leader" aria-hidden="true" />
            <span className={`k-more-switch ${theme === "night" ? "is-on" : ""}`} aria-hidden="true"><i /></span>
          </button>
        </section>

        {isLoggedIn && (
          <section className="k-more-settings" aria-label="设置">
            <h2 className="k-tool-section-title">「设置」</h2>
            <button type="button" role="switch" aria-checked={settings?.voice_enabled !== "0"} aria-label="语音播报步骤" disabled={settingsMut.isPending} onClick={() => toggleSetting("voice_enabled", asString(settings?.voice_enabled, "1"))} className="k-more-setting">
              <span><strong>语音播报步骤</strong><small>做菜时朗读当前步骤</small></span><span className="k-tool-leader" aria-hidden="true" /><span className={`k-more-switch ${settings?.voice_enabled !== "0" ? "is-on" : ""}`} aria-hidden="true"><i /></span>
            </button>
            <button type="button" role="switch" aria-checked={settings?.blind_box_enabled !== "0"} aria-label="惊喜盲盒入口" disabled={settingsMut.isPending} onClick={() => toggleSetting("blind_box_enabled", asString(settings?.blind_box_enabled, "1"))} className="k-more-setting">
              <span><strong>惊喜盲盒入口</strong><small>首页保留一点小惊喜</small></span><span className="k-tool-leader" aria-hidden="true" /><span className={`k-more-switch ${settings?.blind_box_enabled !== "0" ? "is-on" : ""}`} aria-hidden="true"><i /></span>
            </button>
            <button type="button" onClick={() => toast(`推荐去重天数：${asString(settings?.repeat_days, "3")}天`)} className="k-more-setting">
              <span><strong>推荐去重 · 近 {asString(settings?.repeat_days, "3")} 天</strong><small>最近吃过的菜不优先推荐</small></span><span className="k-tool-leader" aria-hidden="true" /><Settings2 size={17} aria-hidden="true" />
            </button>
          </section>
        )}
        <section className="k-more-settings" aria-label="登录与管理">
          <h2 className="k-tool-section-title">「登录与管理」</h2>
          <button type="button" onClick={() => navigate(isLoggedIn ? "/admin/dashboard" : "/admin/login")} className="k-more-setting">
            <span><strong>管理模式</strong><small>{isLoggedIn ? "菜品、推荐语与成就" : "输入管理密码，维护厨房手账"}</small></span>
            <span className="k-tool-leader" aria-hidden="true" /><LockKeyhole size={17} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => { logoutApp(); qc.clear() }} className="k-more-setting">
            <span><strong>退出并返回登录</strong><small>合上手账，下次输入口令再打开</small></span>
            <span className="k-tool-leader" aria-hidden="true" />
            <LogOut size={17} aria-hidden="true" />
          </button>
        </section>
      </div>

    </div>
  )
}
