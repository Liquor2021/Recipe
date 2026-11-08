export const mealMoodOptions = [
  { key: "great", emoji: "😋", label: "超满足" },
  { key: "ok", emoji: "😐", label: "还行吧" },
  { key: "meh", emoji: "😕", label: "不太行" },
] as const

export type MealMood = typeof mealMoodOptions[number]["key"]

export function mealMoodFromParam(value: string | null): MealMood | undefined {
  return mealMoodOptions.find((option) => option.key === value)?.key
}
