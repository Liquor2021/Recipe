// 份量是原菜谱的倍率；菜谱没有基准人数，不能把倍率称为“人份”。
export function parsePortionScale(value: unknown): number {
  const scale = Number(value)
  return Number.isFinite(scale) && scale >= 0.5 && scale <= 8 ? scale : 1
}

export function portionLabel(scale: number): string {
  return `原量×${parsePortionScale(scale)}`
}

// 只缩放明确的数字用量。范围、组合用量和“适量”等原文交给做菜的人判断。
export function scaleAmount(amount: string, scale: number): string {
  if (scale === 1) return amount
  const match = amount.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z\u3400-\u9fff]*)$/)
  if (!match) return amount
  const scaled = Math.round(Number(match[1]) * parsePortionScale(scale) * 100) / 100
  if (!Number.isFinite(scaled)) return amount
  return `${scaled}${match[2]}`
}
