import { useRef, useState } from "react"
import { pickApi } from "@/api"
import type { Dish } from "@/types"
import { createTomorrowRequestGate } from "@/lib/tomorrowRequests"
import {
  createTomorrowRecommendations,
  InsufficientTomorrowDishesError
} from "@/lib/tomorrowRecommendations"
import { getTomorrow } from "@/lib/tomorrowDate"
import toast from "react-hot-toast"
import {
  type MealType,
  type PlanProfile,
  maxPerMeal,
  mealMeta,
  uniqueById
} from "@/pages/tomorrow/model"
import type { Dispatch, SetStateAction } from "react"
export function usePlanRecommendations({
  tomorrowStr,
  lunch,
  dinner,
  targets,
  profile,
  setLunch,
  setDinner,
  setTargets,
  setProfile,
  setInitializedFor,
  selectedMealById
}: {
  tomorrowStr: string
  lunch: Dish[]
  dinner: Dish[]
  targets: Record<MealType, number>
  profile: PlanProfile
  setLunch: Dispatch<SetStateAction<Dish[]>>
  setDinner: Dispatch<SetStateAction<Dish[]>>
  setTargets: Dispatch<SetStateAction<Record<MealType, number>>>
  setProfile: Dispatch<SetStateAction<PlanProfile>>
  setInitializedFor: Dispatch<SetStateAction<string | null>>
  selectedMealById: Map<number, MealType>
}) {
  const [picking, setPicking] = useState(false)
  const requestGate = useRef(createTomorrowRequestGate())
  const recommendations = useRef(createTomorrowRecommendations(pickApi.tomorrow))
  function getMeal(meal: MealType) {
    return meal === "lunch" ? lunch : dinner
  }
  function updateMeal(meal: MealType, updater: (prev: Dish[]) => Dish[]) {
    if (meal === "lunch") setLunch(updater)
    else setDinner(updater)
  }
  function invalidateRecommendations() {
    requestGate.current.invalidate()
    setPicking(false)
  }
  function beginRecommendation() {
    const token = requestGate.current.begin()
    const date = tomorrowStr
    setPicking(true)
    return () => requestGate.current.current(token) && date === getTomorrow().str
  }
  function updateTarget(meal: MealType, value: number) {
    invalidateRecommendations()
    recommendations.current.remember(getMeal(meal))
    const next = Math.max(0, Math.min(maxPerMeal, value))
    setTargets((prev) => ({ ...prev, [meal]: next }))
    updateMeal(meal, (prev) => (prev.length > next ? prev.slice(0, next) : prev))
  }
  async function requestTomorrowDishes(
    meal: MealType,
    count: number,
    nextProfile = profile,
    additionalDishes: Dish[] = [],
    allowPartial = false
  ) {
    return recommendations.current.pick({
      meal,
      count,
      profile: nextProfile,
      allowPartial,
      current: [...lunch, ...dinner, ...additionalDishes]
    })
  }
  function recommendationError(error: unknown) {
    toast.error(
      error instanceof InsufficientTomorrowDishesError
        ? error.message
        : "推荐失败，原菜单已保留，请重试"
    )
  }
  async function fillMeal(meal: MealType) {
    const current = getMeal(meal)
    const needed = Math.max(0, targets[meal] - current.length)
    if (needed === 0) return
    const currentRequest = beginRecommendation()
    try {
      const picks = await requestTomorrowDishes(meal, needed, profile, [], true)
      if (!currentRequest()) return
      if (picks.length === 0) {
        toast.error("没有更多合适的菜了")
        return
      }
      updateMeal(meal, (prev) => uniqueById([...prev, ...picks]).slice(0, maxPerMeal))
      if (picks.length < needed) toast(`已补入 ${picks.length} 道，暂时没有更多合适的菜了`)
    } catch (error) {
      if (currentRequest()) recommendationError(error)
    } finally {
      if (currentRequest()) setPicking(false)
    }
  }
  async function replaceMeal(meal: MealType) {
    const count = Math.max(1, targets[meal] || getMeal(meal).length || 1)
    const currentRequest = beginRecommendation()
    try {
      const picks = await requestTomorrowDishes(meal, count)
      if (!currentRequest()) return
      recommendations.current.remember([...lunch, ...dinner])
      updateMeal(meal, () => picks)
    } catch (error) {
      if (currentRequest()) recommendationError(error)
    } finally {
      if (currentRequest()) setPicking(false)
    }
  }
  async function swapDish(meal: MealType, dishId: number) {
    const currentRequest = beginRecommendation()
    try {
      const [pick] = await requestTomorrowDishes(meal, 1)
      if (!currentRequest()) return
      recommendations.current.remember([...lunch, ...dinner])
      updateMeal(meal, (prev) => prev.map((dish) => (dish.id === dishId ? pick : dish)))
    } catch (error) {
      if (currentRequest()) recommendationError(error)
    } finally {
      if (currentRequest()) setPicking(false)
    }
  }
  function addManual(meal: MealType, dish: Dish) {
    const selectedMeal = selectedMealById.get(dish.id)
    if (selectedMeal) {
      toast.error(`这道菜已经在${mealMeta[selectedMeal].shortLabel}里了`)
      return
    }
    if (getMeal(meal).length >= maxPerMeal) {
      toast.error(`每餐最多 ${maxPerMeal} 道菜`)
      return
    }
    invalidateRecommendations()
    updateMeal(meal, (prev) => [...prev, dish])
    setTargets((prev) => ({ ...prev, [meal]: Math.max(prev[meal], getMeal(meal).length + 1) }))
  }
  function removeDish(meal: MealType, dishId: number) {
    invalidateRecommendations()
    recommendations.current.remember([{ id: dishId }])
    updateMeal(meal, (prev) => prev.filter((dish) => dish.id !== dishId))
  }
  async function generateAll(
    nextProfile = profile,
    nextTargets = targets,
    initializeDate?: string
  ) {
    const currentRequest = beginRecommendation()
    try {
      const nextLunch =
        nextTargets.lunch > 0
          ? await requestTomorrowDishes(
              "lunch",
              nextTargets.lunch,
              nextProfile,
              [],
              !!initializeDate
            )
          : []
      if (!currentRequest()) return
      const nextDinner =
        nextTargets.dinner > 0
          ? await requestTomorrowDishes(
              "dinner",
              nextTargets.dinner,
              nextProfile,
              nextLunch,
              !!initializeDate
            )
          : []
      if (!currentRequest()) return
      if (nextLunch.length === 0 && nextDinner.length === 0) {
        toast.error("暂无可推荐的菜品")
        return
      }
      recommendations.current.remember([...lunch, ...dinner])
      setLunch(nextLunch)
      setDinner(nextDinner)
      if (nextLunch.length < nextTargets.lunch || nextDinner.length < nextTargets.dinner) {
        toast("已列出目前合适的菜，剩余可以手动选菜")
      }
    } catch (error) {
      if (currentRequest()) recommendationError(error)
    } finally {
      if (currentRequest()) {
        setPicking(false)
        if (initializeDate) setInitializedFor(initializeDate)
      }
    }
  }
  function applyProfile(nextProfile: PlanProfile) {
    setProfile(nextProfile)
    void generateAll(nextProfile)
  }
  return {
    picking,
    requestGate,
    invalidateRecommendations,
    updateTarget,
    fillMeal,
    replaceMeal,
    swapDish,
    addManual,
    removeDish,
    generateAll,
    applyProfile
  }
}
