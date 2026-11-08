import { api, apiFresh } from "./client"
import type { Expense, ExpenseInput, LedgerMonth } from "@/lib/ledger"

export const ledgerApi = {
  month: (month: string) => apiFresh<LedgerMonth>("GET", "/expenses", { month }),
  create: (input: ExpenseInput) => api<Expense>("POST", "/expenses", input),
  update: (expense: Expense, input: ExpenseInput) => api<null>("PUT", `/expenses/${expense.id}`, { ...input, revision: expense.revision }),
  remove: (expense: Expense) => api<null>("DELETE", `/expenses/${expense.id}`, { revision: expense.revision }),
  budget: (month: string, amount_cents: number) => api<null>("PUT", `/ledger/budget/${month}`, { amount_cents }),
  settings: () => apiFresh<{ shopping_link_enabled: boolean }>("GET", "/ledger/settings"),
  setShoppingLink: (shopping_link_enabled: boolean) => api<{ shopping_link_enabled: boolean }>("PUT", "/ledger/settings", { shopping_link_enabled }),
}
