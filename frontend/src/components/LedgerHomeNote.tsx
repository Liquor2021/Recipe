import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { ChevronRight, NotebookPen } from "lucide-react"
import { ledgerApi } from "@/api/ledger"
import { comparisonLabel, money } from "@/lib/ledger"
import "@/styles/kitchen-ledger.css"

export default function LedgerHomeNote({ month }: { month: string }) {
  const navigate = useNavigate()
  const query = useQuery({ queryKey: ["ledger", month], queryFn: () => ledgerApi.month(month) })
  return <button type="button" className="ledger-home-note" onClick={() => navigate("/ledger")}>
    <NotebookPen size={23} aria-hidden="true" />
    <span><strong>{query.data ? `本月厨房花销 ¥${money(query.data.total_cents)}` : "厨房账本"}</strong>
      <small>{query.data ? query.data.entries.length ? comparisonLabel(query.data.total_cents, query.data.previous_total_cents) : "柴米油盐，从第一笔开始记" : query.isError ? "花销暂未读到，点开重试" : "正在整理本月花销…"}</small></span>
    <ChevronRight size={17} aria-hidden="true" />
  </button>
}
