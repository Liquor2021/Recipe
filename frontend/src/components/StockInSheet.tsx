import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { shoppingListApi, getUploadErrorMessage } from "@/api"
import KitchenSheet from "@/components/KitchenSheet"
import { Snowflake } from "lucide-react"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import toast from "react-hot-toast"

export interface StockInCandidate {
  name: string
  amount: string
  category: string
  demandVersion: string
}

// 默认勾选蔬菜和肉类；"其他"（米面、牛奶等）不一定放冰箱，列出来但不默认勾
function defaultSelected(c: StockInCandidate) {
  return c.category === "蔬菜" || c.category === "肉类"
}

// StockInSheet 买菜回来把已买的食材放进冰箱：数量取清单用量，保质期按食材字典自动设置
export default function StockInSheet({ candidates, onClose }: { candidates: StockInCandidate[]; onClose: () => void }) {
  const qc = useQueryClient()
  const theme = useKitchenTheme(s => s.theme)
  const [snapshot] = useState(candidates)
  const [selected, setSelected] = useState<string[]>(() => snapshot.filter(defaultSelected).map((c) => c.name))

  const stockInMut = useMutation({
    mutationKey: ["shopping-edit", "stock-in"],
    mutationFn: () =>
      shoppingListApi.stockIn(
        snapshot
          .filter((c) => selected.includes(c.name))
          // "适量"不是数量，放进冰箱时不带
          .map((c) => ({ item_name: c.name, quantity: c.amount === "适量" ? "" : c.amount, demand_version: c.demandVersion })),
      ),
    onSuccess: ({ added }) => {
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      qc.invalidateQueries({ queryKey: ["fridge"] })
      qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
      qc.invalidateQueries({ queryKey: ["fridge-urgent"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      toast.success(`🧊 已放进冰箱 ${added} 样`)
      onClose()
    },
    onError: (err) => { toast.error(getUploadErrorMessage(err, "放进冰箱失败，稍后再试")); onClose() },
    onSettled: () => qc.invalidateQueries({ queryKey: ["shopping-list"] }),
  })

  const toggle = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]))

  return (
    <KitchenSheet title="已买的放进冰箱" theme={theme} icon={<Snowflake size={20} />} onClose={onClose} closeDisabled={stockInMut.isPending} footer={<>
      <button disabled={stockInMut.isPending} onClick={onClose}>先不放</button>
      <button className="is-ink" disabled={selected.length === 0 || stockInMut.isPending} onClick={() => stockInMut.mutate()}>{stockInMut.isPending ? "正在入库…" : `放进冰箱（${selected.length}）`}</button>
    </>}>
          <div className="text-xs text-text3 mb-4">只放入已买但尚未入库的数量，保质期自动设置，之后可在冰箱页改</div>
          <div className="flex flex-wrap gap-2 mb-5 max-h-[45vh] overflow-y-auto">
            {snapshot.map((c) => {
              const active = selected.includes(c.name)
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => toggle(c.name)}
                  disabled={stockInMut.isPending}
                  className={`px-3 py-1.5 rounded-full text-[13px] font-medium border-[1.5px] transition-all active:scale-95 ${
                    active ? "border-mint bg-mint-light text-[#2E8577]" : "border-border2 bg-card text-text3"
                  }`}
                >
                  {active ? "✓ " : ""}{c.name}
                  {c.amount && c.amount !== "适量" && <span className="ml-1 opacity-80">{c.amount}</span>}
                </button>
              )
            })}
          </div>
    </KitchenSheet>
  )
}
