import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ledgerApi } from "@/api/ledger"
import { getUploadErrorMessage } from "@/api/client"
import toast from "react-hot-toast"
import "@/styles/kitchen-ledger.css"

export default function ShoppingLedgerToggle() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ["ledger-settings"], queryFn: ledgerApi.settings })
  const mutation = useMutation({
    mutationFn: ledgerApi.setShoppingLink,
    onSuccess: (data) => { qc.setQueryData(["ledger-settings"], data) },
    onError: (err) => toast.error(getUploadErrorMessage(err, "记账偏好未保存")),
  })
  return <div className="ledger-link-setting">
    <button type="button" role="switch" aria-label="采购时顺手记账" aria-checked={query.data?.shopping_link_enabled ?? false}
      disabled={!query.data || mutation.isPending} onClick={() => { if (!mutation.isPending) mutation.mutate(!query.data?.shopping_link_enabled) }}>
      <span><strong>采购时顺手记账</strong><small>勾选“已买”后，可填金额或跳过</small></span>
      <span className={`ledger-switch ${query.data?.shopping_link_enabled ? "is-on" : ""}`} aria-hidden="true"><i /></span>
    </button>
    {query.isError && <button type="button" className="ledger-text-button" onClick={() => void query.refetch()}>偏好读取失败，点此重试</button>}
  </div>
}
