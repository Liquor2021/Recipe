import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { fridgeApi } from "@/api"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import type { Dish } from "@/types"
import toast from "react-hot-toast"

// ConsumeInventorySheet 做完菜后提示清库存：
// 复用清冰箱匹配结果（含别名/大类语义）找出这道菜用得到、且正在冰箱里的食材，
// 勾选后一键移出库存，让"做饭 → 库存扣减"形成闭环。
export default function ConsumeInventorySheet({ dish, onClose }: { dish: Dish | null; onClose: () => void }) {
  const qc = useQueryClient()
  const open = !!dish

  const { data: matches } = useQuery({
    queryKey: ["fridge-recipes"],
    queryFn: () => fridgeApi.recipes(50),
    enabled: open,
  })

  const match = useMemo(
    () => (dish && matches ? matches.find((m) => m.dish.id === dish.id) : undefined),
    [dish, matches],
  )
  const available = useMemo(() => (match ? match.matched || [] : []), [match])

  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => {
    if (open) setSelected(available)
  }, [open, available.join("|")]) // eslint-disable-line react-hooks/exhaustive-deps -- 依赖食材列表内容

  const removeMut = useMutation({
    mutationFn: async (names: string[]) => {
      for (const name of names) {
        await fridgeApi.remove(name)
      }
    },
    onSuccess: (_data, names) => {
      qc.invalidateQueries({ queryKey: ["fridge"] })
      qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
      qc.invalidateQueries({ queryKey: ["fridge-urgent"] })
      toast.success(`🧊 已从冰箱移除 ${names.length} 样`)
      onClose()
    },
    onError: () => toast.error("移除失败，稍后再试"),
  })

  if (!dish || available.length === 0) return null

  const toggle = (name: string) => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  return (
    <AnimatedBottomSheet onClose={onClose} className="rounded-t-3xl p-5">
      <div className="text-lg font-extrabold mb-0.5">🧊 做完{dish.name}，清一下冰箱？</div>
      <div className="text-xs text-text3 mb-4">勾选用掉的食材，从库存里移除</div>
      <div className="flex flex-wrap gap-2 mb-5">
        {available.map((name) => {
          const active = selected.includes(name)
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className={`px-3.5 py-2 rounded-full text-sm font-medium border-[1.5px] transition-all active:scale-95 ${
                active ? "border-mint bg-mint-light text-[#2E8577]" : "border-border2 bg-card text-text3"
              }`}
            >
              {active ? "✓ " : ""}{name}
            </button>
          )
        })}
      </div>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 py-2.5 rounded-full text-sm font-semibold border-[1.5px] border-border2 text-text2 active:scale-96 transition-all"
        >
          留着
        </button>
        <button
          type="button"
          disabled={selected.length === 0 || removeMut.isPending}
          onClick={() => removeMut.mutate(selected)}
          className="flex-1 py-2.5 rounded-full text-sm font-bold bg-primary text-white transition-all active:scale-96 disabled:opacity-50"
        >
          移除选中 {selected.length > 0 ? `(${selected.length})` : ""}
        </button>
      </div>
    </AnimatedBottomSheet>
  )
}
