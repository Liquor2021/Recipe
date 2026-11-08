export const expenseCategories = [
  { key: "ingredients", label: "食材", color: "var(--k-green)" },
  { key: "takeout", label: "外卖", color: "var(--k-amber)" },
  { key: "seasoning", label: "调料", color: "var(--k-ochre)" },
  { key: "kitchenware", label: "厨房用品", color: "var(--k-gray)" },
  { key: "other", label: "其他", color: "var(--k-faint)" },
] as const

export type ExpenseCategory = typeof expenseCategories[number]["key"]
export type ExpenseInput = { amount_cents: number; category: ExpenseCategory; expense_date: string; note: string; request_id: string }
export type Expense = Omit<ExpenseInput, "request_id"> & { id: number; revision: number; source: "manual" | "shopping"; shopping_item: string }
export type LedgerMonth = { month: string; entries: Expense[]; total_cents: number; previous_total_cents: number; budget_cents: number; categories: Record<ExpenseCategory, number> }
export type ShoppingPurchase = { item_name: string; meal_date: string; checked: boolean; demand_version: string; expense?: ExpenseInput }

export const MAX_MONEY_CENTS = 99999999
// 字符串拆分再转分，不用浮点乘法；拒绝指数、负数和三位小数。
export function parseMoney(text: string, allowZero = false): number | null {
  const value = text.trim()
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return cents <= MAX_MONEY_CENTS && (allowZero ? cents >= 0 : cents > 0) ? cents : null
}
export function money(cents: number) { return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
export function ledgerToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
export function shiftMonth(month: string, offset: number) {
  const [year, m] = month.split("-").map(Number)
  const date = new Date(year, m - 1 + offset, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
}
export function comparisonLabel(total: number, previous: number) {
  if (previous <= 0 || !Number.isFinite(previous) || !Number.isFinite(total)) return null
  const change = (total - previous) / previous * 100
  return change === 0 ? "与上月持平" : `${change > 0 ? "↑" : "↓"} 比上月 ${Math.abs(change).toFixed(1)}%`
}
export function newExpenseRequestID() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export function homeCategoryTotals(categories: LedgerMonth["categories"]) {
  return [
    ...expenseCategories.slice(0, 3).map((category) => ({ ...category, amount: categories[category.key] })),
    { key: "supplies", label: categories.other > 0 ? "用品等" : "用品", color: "var(--k-gray)", amount: categories.kitchenware + categories.other },
  ]
}
