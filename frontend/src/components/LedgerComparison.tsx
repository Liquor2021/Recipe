import { comparisonLabel } from "@/lib/ledger"

export default function LedgerComparison({ total, previous }: { total: number; previous: number }) {
  const label = comparisonLabel(total, previous)
  if (!label) return null
  return <span className={`ledger-comparison ${total > previous ? "is-up" : total === previous ? "is-flat" : "is-down"}`}>{label}</span>
}
