import { useId, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, NotebookPen, Plus, ReceiptText, Wallet } from "lucide-react"
import { ledgerApi } from "@/api/ledger"
import { getUploadErrorMessage } from "@/api/client"
import { expenseCategories, ledgerToday, money, parseMoney, shiftMonth } from "@/lib/ledger"
import type { Expense } from "@/lib/ledger"
import PageHeader from "@/components/PageHeader"
import ExpenseSheet from "@/components/ExpenseSheet"
import LedgerComparison from "@/components/LedgerComparison"
import KitchenSheet from "@/components/KitchenSheet"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import toast from "react-hot-toast"
import "@/styles/kitchen-ledger.css"

function BudgetSheet({ month, budget, onClose }: { month: string; budget: number; onClose: () => void }) {
  const theme = useKitchenTheme((s) => s.theme)
  const qc = useQueryClient()
  const formId = useId()
  const busy = useRef(false)
  const [amount, setAmount] = useState(budget ? (budget / 100).toFixed(2) : "")
  const [error, setError] = useState("")
  const mutation = useMutation({
    mutationFn: (cents: number) => ledgerApi.budget(month, cents),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["ledger"] }); toast.success("本月预算已保存"); onClose() },
    onError: (err) => setError(getUploadErrorMessage(err, "预算未保存")),
    onSettled: () => { busy.current = false },
  })
  return <KitchenSheet title={`${Number(month.slice(5))} 月的厨房预算`} theme={theme} onClose={onClose} closeDisabled={mutation.isPending} icon={<Wallet size={18} />}
    footer={<><button type="button" disabled={mutation.isPending} onClick={onClose}>取消</button><button type="submit" form={formId} className="is-ink" disabled={mutation.isPending}>{mutation.isPending ? "保存中…" : "保存预算"}</button></>}>
    <form id={formId} onSubmit={(e) => {
      e.preventDefault()
      if (busy.current) return
      const cents = parseMoney(amount, true)
      if (cents === null) { setError("请填 0～999999.99 元，最多两位小数"); return }
      busy.current = true
      setError("")
      mutation.mutate(cents)
    }}>
      <label className="ledger-amount"><span>预算金额（元）</span><span className="ledger-money-input"><b aria-hidden="true">¥</b><input inputMode="decimal" aria-label="预算金额" maxLength={9} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" disabled={mutation.isPending} /></span></label>
      <p className="kitchen-sheet-hint">只设置 {month}，其他月份不变。填 0 可取消这个月的预算。</p>
      {error && <p role="alert" className="ledger-error">{error}</p>}
    </form>
  </KitchenSheet>
}

export default function Ledger() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const today = ledgerToday()
  const selected = params.get("month") ?? ""
  const month = /^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(selected) ? selected : today.slice(0, 7)
  const [editing, setEditing] = useState<Expense | "new" | null>(null)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [category, setCategory] = useState<string>("all")
  const query = useQuery({ queryKey: ["ledger", month], queryFn: () => ledgerApi.month(month) })
  const data = query.data
  const visible = data?.entries.filter((e) => category === "all" || e.category === category) ?? []
  const days = new Map<string, Expense[]>()
  for (const expense of visible) {
    const list = days.get(expense.expense_date) ?? []
    list.push(expense)
    days.set(expense.expense_date, list)
  }
  function changeMonth(value: string) { setParams({ month: value }, { replace: true }); setCategory("all") }
  const budget = data?.budget_cents ?? 0
  const total = data?.total_cents ?? 0
  const over = budget > 0 && total > budget
  return <div className="ledger-page">
    <PageHeader title="厨房账本" onBack={() => navigate("/more")} meta="柴米油盐，都记下" />
    <main className="ledger-content">
      <nav className="ledger-month-nav" aria-label="账本月份">
        <button type="button" aria-label="上个月" disabled={month === "1900-01"} onClick={() => changeMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
        <label><span className="sr-only">选择账本月份</span><input type="month" aria-label="选择账本月份" value={month} min="1900-01" max="9999-12" onInput={(e) => { if (e.currentTarget.value) changeMonth(e.currentTarget.value) }} onChange={(e) => { if (e.target.value) changeMonth(e.target.value) }} /></label>
        <button type="button" aria-label="下个月" disabled={month === "9999-12"} onClick={() => changeMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
        {month !== today.slice(0, 7) && <button type="button" className="ledger-this-month" onClick={() => changeMonth(today.slice(0, 7))}>回本月</button>}
      </nav>
      {query.isPending && <div role="status" className="kitchen-empty">正在翻开这个月的账本…</div>}
      {query.isError && <div role="alert" className="ledger-error">{data ? "账本未能更新，下方是上次读取的账目。" : "账本暂时没能打开。"}<button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>重新读取</button></div>}
      {data && <>
        <section className="ledger-summary" aria-label="月度收支概览">
          <div className="ledger-tape" aria-hidden="true" />
          <p className="ledger-eyebrow">{Number(month.slice(5))} 月厨房支出</p>
          <div className="ledger-total-line"><strong><span>¥</span>{money(total)}</strong><LedgerComparison total={total} previous={data.previous_total_cents} /></div>
          <div className="ledger-budget-caption"><span>{budget ? `本月预算 ¥${money(budget)}` : "给柴米油盐留一份预算"}</span><button type="button" onClick={() => setBudgetOpen(true)}>{budget ? "调整预算" : "设置预算"}</button></div>
          {budget > 0 && <>
            <div role="progressbar" aria-label="预算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(total / budget * 100))} aria-valuetext={`已花 ${money(total)} 元，预算 ${money(budget)} 元`} className={`ledger-budget-track ${over ? "is-over" : ""}`}><i style={{ width: `${Math.min(100, total / budget * 100)}%` }} /></div>
            <p className={`ledger-budget-note ${over ? "is-over" : ""}`}>{over ? `超预算 ¥${money(total - budget)}` : `还可用 ¥${money(budget - total)}`}</p>
          </>}
          <div className="ledger-category-totals">{expenseCategories.map((c) => <span key={c.key}>{c.label} <b>¥{money(data.categories[c.key])}</b></span>)}</div>
        </section>
        <section className="ledger-distribution" aria-labelledby="ledger-distribution-title">
          <h2 id="ledger-distribution-title"><ReceiptText size={16} aria-hidden="true" />都花在哪了</h2>
          <div className="ledger-mixbar" aria-hidden="true">{total > 0 && expenseCategories.map((c) => <i key={c.key} style={{ width: `${data.categories[c.key] / total * 100}%`, background: c.color }} />)}</div>
          <div className="ledger-legend">{expenseCategories.map((c) => <span key={c.key}><i style={{ background: c.color }} />{c.label} {total ? (data.categories[c.key] / total * 100).toFixed(1) : "0"}%</span>)}</div>
        </section>
        <div className="ledger-entries-heading"><h2>这一月的流水</h2><span>{data.entries.length} 笔 · 点开可修改</span></div>
        <div className="ledger-filters" aria-label="筛选支出分类"><button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")}>全部</button>{expenseCategories.map((c) => <button type="button" key={c.key} aria-pressed={category === c.key} onClick={() => setCategory(c.key)}>{c.label}</button>)}</div>
        {visible.length === 0 ? <div className="kitchen-empty ledger-empty"><NotebookPen size={30} aria-hidden="true" /><strong>{data.entries.length ? "这个分类还没有支出" : "这一页，等你记下第一笔"}</strong><span>{data.entries.length ? "换个分类看看，或记下一笔新支出。" : "买菜、外卖、添一口锅，都可以记在这里。"}</span></div> : <div className="ledger-days">{[...days].map(([date, entries]) => <section key={date} className="ledger-day">
          <h3><span>{date === today ? "今天" : `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日`}</span><small>{date === today ? date.slice(5).replace("-", "/") : `${entries.length} 笔`}</small><b>¥{money(entries.reduce((sum, e) => sum + e.amount_cents, 0))}</b></h3>
          {entries.map((expense) => <button type="button" key={expense.id} className="ledger-entry" aria-label={`修改${expense.note || expenseCategories.find((c) => c.key === expense.category)?.label}，${money(expense.amount_cents)}元`} onClick={() => setEditing(expense)}>
            <span className="ledger-source" style={{ color: expenseCategories.find((c) => c.key === expense.category)?.color }}>{expense.source === "shopping" ? "买菜" : expense.category === "takeout" ? "外卖" : "手记"}</span>
            <span className="ledger-entry-note"><strong>{expense.note || expenseCategories.find((c) => c.key === expense.category)?.label}</strong><small>{expenseCategories.find((c) => c.key === expense.category)?.label}</small></span>
            <span className="ledger-leader" aria-hidden="true" /><b>¥{money(expense.amount_cents)}</b><ChevronRight size={13} aria-hidden="true" />
          </button>)}
        </section>)}</div>}
      </>}
    </main>
    <div className="ledger-add-bar"><button type="button" onClick={() => setEditing("new")}><Plus size={19} aria-hidden="true" />记一笔</button></div>
    {editing && <ExpenseSheet expense={editing === "new" ? undefined : editing} initialDate={month === today.slice(0, 7) || month > today.slice(0, 7) ? today : `${month}-01`} onClose={() => setEditing(null)} onSaved={(date) => changeMonth(date.slice(0, 7))} />}
    {budgetOpen && data && <BudgetSheet month={month} budget={budget} onClose={() => setBudgetOpen(false)} />}
  </div>
}
