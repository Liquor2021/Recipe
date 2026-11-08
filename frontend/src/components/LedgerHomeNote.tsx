import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import { ledgerApi } from "@/api/ledger"
import { expenseCategories, homeCategoryTotals, money } from "@/lib/ledger"
import ExpenseSheet from "./ExpenseSheet"
import LedgerComparison from "./LedgerComparison"
import "@/styles/kitchen-ledger.css"

export default function LedgerHomeNote({ month, active }: { month: string; active: boolean }) {
  const navigate = useNavigate()
  const [entryOpen, setEntryOpen] = useState(false)
  // 首页保留挂载，离开时结束本次抽屉，返回后不重现旧表单。
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active) setEntryOpen(false)
  }
  const query = useQuery({ queryKey: ["ledger", month], queryFn: () => ledgerApi.month(month) })
  const data = query.data
  const latest = data?.entries[0]
  const budget = data?.budget_cents ?? 0
  const total = data?.total_cents ?? 0
  const over = budget > 0 && total > budget
  const used = budget > 0 ? Math.round(total / budget * 100) : 0
  return <>
    <section className="ledger-home-note" aria-label="厨房存折">
      <span className="ledger-home-tape" aria-hidden="true" />
      <header className="ledger-home-heading">
        <span className="ledger-home-icon" aria-hidden="true">🐷</span>
        <div>
          <h2><button type="button" className="ledger-home-title" onClick={() => navigate("/ledger")} aria-label="打开厨房账本"><span>本月支出 · </span>厨房存折<ChevronRight size={12} aria-hidden="true" /></button></h2>
          <div className="ledger-home-total"><strong>{data ? `¥${money(total)}` : "—"}</strong>{data && <LedgerComparison total={total} previous={data.previous_total_cents} />}</div>
        </div>
        <button type="button" className="ledger-home-add" onClick={() => setEntryOpen(true)}>记一笔</button>
      </header>
      {data ? <>
        <div className={`ledger-home-budget ${over ? "is-over" : ""}`}>
          <div role="progressbar" aria-label="本月预算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={budget ? Math.min(used, 100) : undefined} aria-valuetext={budget ? `已花 ${money(total)} 元，预算 ${money(budget)} 元` : "尚未设置预算"} className={`ledger-budget-track ${over ? "is-over" : ""}`}><i style={{ width: `${budget ? Math.min(100, total / budget * 100) : 0}%` }} /></div>
          <span>{budget ? `预算 ¥${money(budget)} · ${over ? `超出 ¥${money(total - budget)}` : `用了 ${used}%`}` : "未设预算"}</span>
        </div>
        <div className="ledger-home-categories">{homeCategoryTotals(data.categories).map((category) => <span key={category.key} style={{ color: category.color }} title={category.key === "supplies" ? "厨房用品与其他支出" : undefined}>{category.label} <b>¥{money(category.amount).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}</b></span>)}</div>
      </> : <p className="ledger-home-status" role="status">{query.isError ? "本月花销读取失败" : "正在整理本月花销…"}</p>}
      {query.isError && <button type="button" className="ledger-text-button" disabled={query.isFetching} onClick={() => void query.refetch()}>{data ? "花销更新失败，点此重试" : "重新读取"}</button>}
      <footer className="ledger-home-footer">
        {latest ? <button type="button" className="ledger-home-latest" onClick={() => navigate("/ledger")} aria-label={`查看最近一笔：${latest.note || expenseCategories.find((c) => c.key === latest.category)?.label}，支出${money(latest.amount_cents)}元`}><span>最近一笔</span><strong>{latest.note || expenseCategories.find((c) => c.key === latest.category)?.label}</strong><b>−¥{money(latest.amount_cents)}</b><time dateTime={latest.expense_date}>{latest.expense_date.slice(5)}</time></button> : <span className="ledger-home-status">{data ? "这个月还没记账" : "柴米油盐，记在这里"}</span>}
      </footer>
    </section>
    {entryOpen && active && <ExpenseSheet onClose={() => setEntryOpen(false)} />}
  </>
}
