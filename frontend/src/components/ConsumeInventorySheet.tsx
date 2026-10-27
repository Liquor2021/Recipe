import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { fridgeApi } from "@/api"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import type { Dish } from "@/types"
import toast from "react-hot-toast"

// ConsumeInventorySheet 做完菜后提示清库存：
// 复用清冰箱匹配结果（含别名/大类语义），列出这道菜用得到、且正在冰箱里的
// 库存批次，勾选后按批次移除——同食材多批次时后端给出的就是最早到期的那批，
// 天然先进先出。
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
  // matched[i] 与 matched_batch_ids[i] 一一对应：名字用于展示，id 用于移除
  const batches = useMemo(() => {
    if (!match) return []
    const names = match.matched || []
    const ids = match.matched_batch_ids || []
    return names.map((name, i) => ({ name, id: ids[i] })).filter((b) => typeof b.id === "number")
  }, [match])

  const [selected, setSelected] = useState<number[]>([])
  useEffect(() => {
    if (open) setSelected(batches.map((b) => b.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖批次列表内容
  }, [open, batches.map((b) => b.id).join("|")])

  const removeMut = useMutation({
    mutationFn: async (ids: number[]) => {
      for (const id of ids) {
        await fridgeApi.removeBatch(id)
      }
    },
    onSuccess: (_data, ids) => {
      qc.invalidateQueries({ queryKey: ["fridge"] })
      qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
      qc.invalidateQueries({ queryKey: ["fridge-urgent"] })
      toast.success(`🧊 已从冰箱移除 ${ids.length} 批`)
      onClose()
    },
    onError: () => toast.error("移除失败，稍后再试"),
  })

  if (!dish || batches.length === 0) return null

  const toggle = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <AnimatedBottomSheet onClose={onClose} className="rounded-t-3xl p-5">
      <div className="text-lg font-extrabold mb-0.5">🧊 做完{dish.name}，清一下冰箱？</div>
      <div className="text-xs text-text3 mb-4">勾选用掉的食材批次，从库存里移除</div>
      <div className="flex flex-wrap gap-2 mb-5">
        {batches.map((b) => {
          const active = selected.includes(b.id)
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => toggle(b.id)}
              className={`px-3.5 py-2 rounded-full text-sm font-medium border-[1.5px] transition-all active:scale-95 ${
                active ? "border-mint bg-mint-light text-[#2E8577]" : "border-border2 bg-card text-text3"
              }`}
            >
              {active ? "✓ " : ""}{b.name}
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
