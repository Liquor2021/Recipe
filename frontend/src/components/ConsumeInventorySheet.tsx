import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { fridgeApi } from "@/api"
import AnimatedBottomSheet from "@/components/AnimatedBottomSheet"
import type { ConsumptionBatch, ConsumptionSlot, Dish } from "@/types"
import toast from "react-hot-toast"

// 距过期天数 → 简短文案；999 表示未设置保质期
function expiryText(daysLeft: number): string {
  if (daysLeft >= 999) return ""
  if (daysLeft < 0) return `过期${-daysLeft}天`
  if (daysLeft === 0) return "今天到期"
  return `${daysLeft}天后到期`
}

// ConsumeInventorySheet 做完菜后提示清库存：
// 后端按菜谱主料精确/别名匹配出真实库存批次（/fridge/consumption），
// 默认只勾选每项主料里最早到期的未过期批次；同类不同部位（菜要排骨、冰箱是五花肉）
// 只列出供参考、不默认勾选，避免扣错食材。
export default function ConsumeInventorySheet({ dish, onClose }: { dish: Dish | null; onClose: () => void }) {
  const { data, isError } = useQuery({
    queryKey: ["fridge-consumption", dish?.id],
    queryFn: () => fridgeApi.consumption(dish!.id),
    enabled: !!dish,
    // 候选是"做完这道菜那一刻"的快照：每次打开都重新取，打开期间不因切回页面/重连而刷新
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  // 冰箱里没有这道菜能扣的批次（或读取失败）就直接结束这次提示：
  // 否则 dish 一直挂着，之后别人往冰箱加了食材，切回页面时弹层会突然冒出来且已默认勾选
  const settledEmpty = !!dish && (isError || (data?.dish_id === dish.id && data.slots.length === 0))
  useEffect(() => {
    if (settledEmpty) onClose()
  }, [settledEmpty, onClose])

  if (!dish || !data || data.dish_id !== dish.id || data.slots.length === 0) return null
  // key 按菜区分：换一道菜时重置勾选状态
  return <ConsumeSheetBody key={dish.id} dish={dish} slots={data.slots} onClose={onClose} />
}

function ConsumeSheetBody({ dish, slots, onClose }: { dish: Dish; slots: ConsumptionSlot[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<number[]>(() =>
    slots.map((s) => s.suggested_batch_id).filter((id) => id > 0),
  )
  const hasSimilar = slots.some((s) => s.batches.some((b) => b.kind === "similar"))
  // 只计当前候选里仍存在的批次（计数与提交口径一致）
  const present = new Set(slots.flatMap((s) => s.batches.map((b) => b.batch_id)))
  const chosen = selected.filter((id) => present.has(id))

  const consumeMut = useMutation({
    mutationFn: (ids: number[]) => fridgeApi.consume(ids),
    onSuccess: ({ removed }) => {
      qc.invalidateQueries({ queryKey: ["fridge"] })
      qc.invalidateQueries({ queryKey: ["fridge-recipes"] })
      qc.invalidateQueries({ queryKey: ["fridge-urgent"] })
      toast.success(removed > 0 ? `🧊 已从冰箱移除 ${removed} 批` : "这些批次已经不在冰箱里了")
      onClose()
    },
    onError: () => toast.error("移除失败，稍后再试"),
  })

  const toggle = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = () => {
    if (chosen.length > 0) consumeMut.mutate(chosen)
  }

  return (
    <AnimatedBottomSheet onClose={onClose} className="rounded-t-3xl p-5">
      {({ close }) => (
        <>
          <div className="text-lg font-extrabold mb-0.5">🧊 做完{dish.name}，清一下冰箱？</div>
          <div className="text-xs text-text3 mb-4">勾选用掉的批次从冰箱移除；默认只勾同名食材里最早到期的一批</div>
          <div className="flex flex-col gap-3.5 mb-4 max-h-[50vh] overflow-y-auto">
            {slots.map((slot) => (
              <div key={slot.requested_name}>
                <div className="text-xs font-semibold text-text2 mb-1.5">
                  {slot.requested_name}
                  {slot.amount && <span className="font-normal text-text3"> · 菜谱用量 {slot.amount}</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {slot.batches.map((b) => (
                    <BatchChip key={b.batch_id} batch={b} active={selected.includes(b.batch_id)} onToggle={() => toggle(b.batch_id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {hasSimilar && (
            <div className="text-[11px] text-text3 mb-4">「相近」是同类的其他部位（如菜要排骨、冰箱里是五花肉），确实用了再勾选</div>
          )}
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={close}
              className="flex-1 py-2.5 rounded-full text-sm font-semibold border-[1.5px] border-border2 text-text2 active:scale-96 transition-all"
            >
              留着
            </button>
            <button
              type="button"
              disabled={chosen.length === 0 || consumeMut.isPending}
              onClick={submit}
              className="flex-1 py-2.5 rounded-full text-sm font-bold bg-primary text-white transition-all active:scale-96 disabled:opacity-50"
            >
              移除选中 {chosen.length > 0 ? `(${chosen.length})` : ""}
            </button>
          </div>
        </>
      )}
    </AnimatedBottomSheet>
  )
}

function BatchChip({ batch, active, onToggle }: { batch: ConsumptionBatch; active: boolean; onToggle: () => void }) {
  const expiry = expiryText(batch.days_left)
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`px-3 py-1.5 rounded-full text-[13px] font-medium border-[1.5px] transition-all active:scale-95 ${
        active ? "border-mint bg-mint-light text-[#2E8577]" : "border-border2 bg-card text-text3"
      }`}
    >
      {active ? "✓ " : ""}
      {batch.kind === "similar" && <span className="mr-1 text-[10px] font-bold text-[#C8A23C]">相近</span>}
      {batch.stock_name}
      {batch.quantity && <span className="ml-1 opacity-80">{batch.quantity}</span>}
      {expiry && <span className={`ml-1 text-[10px] ${batch.days_left < 0 ? "text-red" : "opacity-70"}`}>{expiry}</span>}
    </button>
  )
}
