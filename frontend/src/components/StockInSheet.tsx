import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { shoppingListApi } from "@/api"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import toast from "react-hot-toast"

export interface StockInCandidate {
  name: string
  amount: string
  category: string
}

// 默认勾选蔬菜和肉类；"其他"（米面、牛奶等）不一定放冰箱，列出来但不默认勾
function defaultSelected(c: StockInCandidate) {
  return c.category === "蔬菜" || c.category === "肉类"
}

// StockInSheet 买菜回来把已买的食材放进冰箱：数量取清单用量，保质期按食材字典自动设置
export default function StockInSheet({ candidates, onClose }: { candidates: StockInCandidate[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string[]>(() => candidates.filter(defaultSelected).map((c) => c.name))

  const stockInMut = useMutation({
    mutationFn: () =>
      shoppingListApi.stockIn(
        candidates
          .filter((c) => selected.includes(c.name))
          // "适量"不是数量，放进冰箱时不带
          .map((c) => ({ item_name: c.name, quantity: c.amount === "适量" ? "" : c.amount })),
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
    onError: () => toast.error("放进冰箱失败，稍后再试"),
  })

  const toggle = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]))

  return (
    <AnimatedBottomSheet onClose={onClose} className="rounded-t-3xl p-5">
      {({ close }) => (
        <>
          <div className="text-lg font-extrabold mb-0.5">🧊 已买的放进冰箱</div>
          <div className="text-xs text-text3 mb-4">数量按清单用量，保质期按常见食材自动设置，之后可在冰箱页改</div>
          <div className="flex flex-wrap gap-2 mb-5 max-h-[45vh] overflow-y-auto">
            {candidates.map((c) => {
              const active = selected.includes(c.name)
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => toggle(c.name)}
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
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={close}
              className="flex-1 py-2.5 rounded-full text-sm font-semibold border-[1.5px] border-border2 text-text2 active:scale-96 transition-all"
            >
              先不放
            </button>
            <button
              type="button"
              disabled={selected.length === 0 || stockInMut.isPending}
              onClick={() => stockInMut.mutate()}
              className="flex-1 py-2.5 rounded-full text-sm font-bold bg-primary text-white transition-all active:scale-96 disabled:opacity-50"
            >
              放进冰箱 {selected.length > 0 ? `(${selected.length})` : ""}
            </button>
          </div>
        </>
      )}
    </AnimatedBottomSheet>
  )
}
