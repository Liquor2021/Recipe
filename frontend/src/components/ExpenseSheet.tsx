import { useId, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { NotebookPen } from "lucide-react"
import { ledgerApi } from "@/api/ledger"
import { getUploadErrorMessage } from "@/api/client"
import { shoppingListApi } from "@/api"
import { expenseCategories, ledgerToday, money, newExpenseRequestID, parseMoney } from "@/lib/ledger"
import type { Expense, ExpenseCategory, ExpenseInput, ShoppingPurchase } from "@/lib/ledger"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import KitchenSheet from "./KitchenSheet"
import ShoppingLedgerToggle from "./ShoppingLedgerToggle"
import toast from "react-hot-toast"
import "@/styles/kitchen-ledger.css"

type Props = { expense?: Expense; initialDate?: string; purchase?: ShoppingPurchase; onClose: () => void; onSaved?: (date: string) => void }

export default function ExpenseSheet({ expense, initialDate, purchase, onClose, onSaved }: Props) {
  const theme = useKitchenTheme((s) => s.theme)
  const qc = useQueryClient()
  const formId = useId()
  const [amount, setAmount] = useState(expense ? (expense.amount_cents / 100).toFixed(2) : "")
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? "ingredients")
  const [date, setDate] = useState(expense?.expense_date ?? initialDate ?? ledgerToday())
  const [note, setNote] = useState(expense?.note ?? purchase?.item_name ?? "")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState("")
  // 一次打开共用请求号：超时后即使改了输入，也不能悄悄新增第二笔。
  const [requestID] = useState(newExpenseRequestID)
  const busy = useRef(false)
  const mutation = useMutation({
    mutationKey: purchase ? ["shopping-edit", "receipt"] : ["ledger-edit"],
    mutationFn: async (action: { kind: "save" | "skip" | "delete"; input?: ExpenseInput; item_name?: string }) => {
      if (action.kind === "delete" && expense) return ledgerApi.remove(expense)
      if (purchase) return shoppingListApi.toggle({ ...purchase, expense: action.input })
      if (!action.input) throw new Error("请填写金额")
      return expense ? ledgerApi.update(expense, action.input) : ledgerApi.create(action.input)
    },
    onSuccess: (_, action) => {
      void qc.invalidateQueries({ queryKey: ["ledger"] })
      if (purchase) {
        void qc.invalidateQueries({ queryKey: ["shopping-list"] })
        void qc.invalidateQueries({ queryKey: ["achievements"] })
      }
      toast.success(action.kind === "delete" ? "已删除这笔支出" : action.kind === "skip" ? "已标记买好" : purchase ? "已标记买好并记入账本" : expense ? "账目已修改" : "已记下一笔")
      onSaved?.(date)
      onClose()
    },
    onError: (err) => {
      setError(getUploadErrorMessage(err, "保存失败，请重试"))
      void qc.invalidateQueries({ queryKey: ["ledger"] })
      if (purchase) void qc.invalidateQueries({ queryKey: ["shopping-list"] })
    },
    onSettled: () => { busy.current = false },
    retry: false,
  })
  function submit(kind: "save" | "skip" | "delete") {
    if (busy.current) return
    setError("")
    let input: ExpenseInput | undefined
    if (kind === "save") {
      const cents = parseMoney(amount)
      if (cents === null) { setError("请填 0.01～999999.99 元，最多两位小数"); return }
      if (!date || date > ledgerToday()) { setError("请选择今天或之前的支出日期"); return }
      const value = { amount_cents: cents, category, expense_date: date, note: note.trim() }
      input = { ...value, request_id: requestID }
    }
    busy.current = true
    mutation.mutate({ kind, input, item_name: purchase?.item_name })
  }
  return <KitchenSheet title={confirmDelete ? "删掉这笔支出？" : purchase ? "买好了，顺手记一笔" : expense ? "修改这笔支出" : "记一笔"}
    theme={theme} onClose={onClose} closeDisabled={mutation.isPending} icon={<NotebookPen size={18} />} className="ledger-sheet"
    footer={confirmDelete ? <>
      <button type="button" disabled={mutation.isPending} onClick={() => setConfirmDelete(false)}>保留</button>
      <button type="button" className="is-danger" disabled={mutation.isPending} onClick={() => submit("delete")}>{mutation.isPending ? "删除中…" : "确认删除"}</button>
    </> : <>
      <button type="button" disabled={mutation.isPending} onClick={() => purchase ? submit("skip") : onClose()}>{purchase ? "只标已买" : "取消"}</button>
      <button type="submit" form={formId} className="is-ink" disabled={mutation.isPending}>{mutation.isPending ? "保存中…" : purchase ? "已买并记账" : "存进账本"}</button>
    </>}>
    {confirmDelete ? <p className="kitchen-sheet-context"><strong>¥{money(expense!.amount_cents)} · {expense!.note || "这笔支出"}</strong><span>删除后将从月支出中扣除；采购清单和冰箱库存保持原状。</span></p> : <form id={formId} onSubmit={(e) => { e.preventDefault(); submit("save") }}>
      {purchase && <p className="kitchen-sheet-context"><strong>{purchase.item_name}</strong><span>填写这份食材的实付金额；整张小票请只记一次，其他食材选“只标已买”。</span></p>}
      <label className="ledger-amount"><span>支出金额（元）</span><span className="ledger-money-input"><b aria-hidden="true">¥</b><input aria-label="支出金额" inputMode="decimal" placeholder="0.00" value={amount} maxLength={9} onChange={(e) => setAmount(e.target.value)} disabled={mutation.isPending} /></span></label>
      <fieldset className="ledger-category-field" disabled={mutation.isPending}><legend>这笔花在哪</legend><div className="ledger-category-options">{expenseCategories.map((c) => <label key={c.key} className={category === c.key ? "is-selected" : ""}><input type="radio" name={`${formId}-category`} value={c.key} checked={category === c.key} onChange={() => setCategory(c.key)} /><span>{c.label}</span></label>)}</div></fieldset>
      <label className="ledger-field">支出日期<input type="date" className="kitchen-date-input" value={date} min="1900-01-01" max={ledgerToday()} required onInput={(e) => setDate(e.currentTarget.value)} onChange={(e) => setDate(e.target.value)} disabled={mutation.isPending} /></label>
      <label className="ledger-field">备注 <span>选填 · 最多 200 字</span><textarea value={note} maxLength={200} rows={2} placeholder="买了什么，记在这里" onChange={(e) => setNote(e.target.value)} disabled={mutation.isPending} /></label>
      {expense?.source === "shopping" && <p className="kitchen-sheet-hint">来自采购清单：{expense.shopping_item}。修改账目不改变采购和库存数量。</p>}
      {!expense && !purchase && <ShoppingLedgerToggle />}
      {expense && <button type="button" className="ledger-text-button is-danger" disabled={mutation.isPending} onClick={() => { setError(""); setConfirmDelete(true) }}>删除这笔支出</button>}
    </form>}
    {error && <p role="alert" className="ledger-error">{error}</p>}
  </KitchenSheet>
}
