import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query"
import { shoppingListApi, getUploadErrorMessage } from "@/api"
import "@/styles/kitchen-planner.css"

export default function ShoppingScope() {
  const qc = useQueryClient()
  const { data, isError, refetch } = useQuery({ queryKey: ["shopping-settings"], queryFn: shoppingListApi.settings })
  const pending = useMutationState({ filters: { mutationKey: ["shopping-edit"], status: "pending" } }).length > 0
  const change = useMutation({ mutationKey: ["shopping-edit", "scope"], mutationFn: shoppingListApi.setDays,
    onMutate: () => qc.cancelQueries({ queryKey: ["shopping-list"] }),
    onSuccess: async next => { qc.setQueryData(["shopping-settings"], next); await qc.invalidateQueries({ queryKey: ["shopping-list"] }) },
    onError: async () => { await Promise.all(["shopping-settings", "shopping-list"].map(key => qc.invalidateQueries({ queryKey: [key] }))) },
  })
  return <div className="planner-shopping-scope"><span>采购范围</span><div role="group" aria-label="采购范围">{([2,7] as const).map(days => <button key={days} type="button" disabled={!data || pending} aria-pressed={data?.days === days} onClick={() => { if (!qc.isMutating({ mutationKey: ["shopping-edit"] })) change.mutate(days) }}>{days === 2 ? "今天 + 明天" : "未来 7 天"}</button>)}</div>
    <small>未来 7 天从今天算起，仅汇总已安排的菜；采购标记与冰箱库存会保留。</small>
    {(isError || change.isError) && <p role="alert">{change.isError ? getUploadErrorMessage(change.error, "采购范围保存失败") : "采购范围读取失败"}<button onClick={() => void refetch()}>重试读取</button></p>}
  </div>
}
