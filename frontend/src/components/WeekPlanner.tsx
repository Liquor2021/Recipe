import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, ShoppingBasket } from "lucide-react"
import { mealPlanWeekApi } from "@/api/mealPlan"
import { getUploadErrorMessage } from "@/api"
import { localDateKey, planDateShortcuts } from "@/lib/planDate"
import { planRequestId, planWeekStart, refreshMealPlans, shiftPlanDate, validPlanDate } from "@/lib/mealPlan"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import DayPlanEditor from "@/components/DayPlanEditor"
import KitchenSheet from "@/components/KitchenSheet"
import "@/styles/kitchen-planner.css"

export default function WeekPlanner() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const theme = useKitchenTheme(s => s.theme)
  const today = localDateKey(new Date())
  const date = validPlanDate(new URLSearchParams(location.search).get("date")) ?? today
  const start = planWeekStart(date)
  const end = shiftPlanDate(start, 6)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState("")
  const section = useRef<HTMLElement>(null)
  const positioned = useRef("")
  const pending = useMutationState({ filters: { mutationKey: ["meal-plan-edit"], status: "pending" } }).length > 0
  const query = useQuery({ queryKey: ["records", "meal-plan-week", start], queryFn: () => mealPlanWeekApi.get(start) })
  const week = query.data
  const excludeIds = week?.days.flatMap(day => day.records.map(row => row.dish_id)) ?? []

  useEffect(() => {
    if (!week || location.hash !== "#week" || positioned.current === location.key) return
    const target = section.current?.querySelector<HTMLElement>(`[data-plan-date="${date}"]`)
    const scroller = target?.closest<HTMLElement>("[data-tab-scroll]")
    if (!target || !scroller) return
    const frame = requestAnimationFrame(() => {
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 86
      positioned.current = location.key
    })
    return () => cancelAnimationFrame(frame)
  }, [week, date, location.hash, location.key])

  const regenerate = useMutation({
    mutationKey: ["meal-plan-edit", "week"],
    mutationFn: () => mealPlanWeekApi.regenerate(start, { expected_version: week!.version, request_id: planRequestId() }),
    onSuccess: async (result) => {
      qc.setQueryData(["records", "meal-plan-week", start], result)
      setConfirm(false); setError(""); setSaved("已保存这一周，钉住的菜和已吃记录均已保留")
      await refreshMealPlans(qc)
    },
    onError: async err => {
      setConfirm(false); setError(getUploadErrorMessage(err, "保存结果未确认，请刷新菜单后核对")); setSaved("")
      await refreshMealPlans(qc)
    },
  })
  function selectDate(next: string) {
    if (!validPlanDate(next) || pending) return
    setConfirm(false); setError(""); setSaved("")
    navigate(`/more?date=${next}#week`)
  }
  return <section className="planner-week" ref={section} aria-label="一周菜单">
    <div className="planner-heading"><h2>「一周菜单」</h2><button type="button" className="k-tool-text-button" disabled={!week || pending || query.isFetching || query.isError || end < today} onClick={() => setConfirm(true)}><RefreshCw size={14} />全部重排</button></div>
    <p className="planner-note">手选、加菜、钉住喜欢的。每次修改都会保存。</p>
    <nav className="planner-week-nav" aria-label="选择菜单周">
      <button type="button" aria-label="上一周" disabled={pending} onClick={() => selectDate(shiftPlanDate(start, -7))}><ChevronLeft size={17} /></button>
      <label><span>{start.slice(5).replace("-", "/")} — {end.slice(5).replace("-", "/")}</span><input type="date" aria-label="选择菜单日期" value={date} disabled={pending} onChange={event => selectDate(event.target.value)} /></label>
      <button type="button" aria-label="下一周" disabled={pending} onClick={() => selectDate(shiftPlanDate(start, 7))}><ChevronRight size={17} /></button>
    </nav>
    <div className="planner-shortcuts"><button onClick={() => selectDate(today)} disabled={pending}>今天</button>{planDateShortcuts(new Date()).map(shortcut => <button key={shortcut.label} disabled={pending} onClick={() => selectDate(shortcut.date)}>{shortcut.label}</button>)}</div>
    {query.isPending && <p className="planner-feedback" role="status">正在翻开这周菜单…</p>}
    {(query.isError || error) && <p className="planner-feedback is-error" role="alert">{error || "菜单暂时无法更新"}<button onClick={() => void query.refetch()} disabled={pending || query.isFetching}>重新读取</button></p>}
    {saved && <p className="planner-feedback" role="status">{saved}</p>}
    {week?.days.map(day => <article key={day.date} className={`planner-day-card ${date === day.date ? "is-selected" : ""}`} data-plan-date={day.date}>
      <header><h3>{["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${day.date}T12:00:00`).getDay()]}{day.date === today && <span>今天</span>}</h3><time dateTime={day.date}>{day.date.slice(5)}</time></header>
      <DayPlanEditor date={day.date} snapshot={day} excludeIds={excludeIds} />
    </article>)}
    <button type="button" className="planner-shopping-link" onClick={() => navigate("/more#shopping")}><ShoppingBasket size={16} /><span>去采购清单<span>可切换为今天起 7 天的已排计划</span></span><ChevronRight size={16} /></button>
    {confirm && <KitchenSheet title="重新排这一周？" theme={theme} icon={<CalendarDays size={20} />} onClose={() => setConfirm(false)} closeDisabled={regenerate.isPending} footer={<><button disabled={regenerate.isPending} onClick={() => setConfirm(false)}>再想想</button><button className="is-ink" disabled={regenerate.isPending} onClick={() => { if (!qc.isMutating({ mutationKey: ["meal-plan-edit"] })) regenerate.mutate() }}>{regenerate.isPending ? "重排中…" : "确认重排"}</button></>}>
      <p className="planner-confirm-date">{start} — {end}</p><p>从今天起，替换未钉住的菜，并补齐空餐。已有餐次保留道数，空餐使用家庭设置的道数。</p><p className="planner-note">钉住的菜、已吃记录和过去日期保持原样。会按家庭忌口与餐别筛选，食材同步到采购清单。</p>
    </KitchenSheet>}
  </section>
}
