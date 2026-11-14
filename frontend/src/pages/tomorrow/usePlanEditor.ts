import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { dishesApi, recordsApi } from "@/api"
import type { Dish, MealRecord } from "@/types"
import { launchConfetti } from "@/lib/confetti"
import { readTomorrowDraft, tomorrowPlanBaseline, writeTomorrowDraft } from "@/lib/tomorrowDraft"
import { isMealPlanConflict } from "@/lib/tomorrowRequests"
import { getTomorrow } from "@/lib/tomorrowDate"
import toast from "react-hot-toast"
import {
  type MealType,
  type PlanProfile,
  defaultTargets,
  maxPerMeal,
  mealRecords,
  keyFromRecords,
  keyFromDishes,
  recordToDish,
  hydrateDishes,
  type SavePlanPayload,
  type PlanConflict
} from "@/pages/tomorrow/model"
import { usePlanRecommendations } from "@/pages/tomorrow/usePlanRecommendations"
export function usePlanEditor(date: ReturnType<typeof getTomorrow>) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const confettiRef = useRef<HTMLDivElement>(null)
  const { str: tomorrowStr, label: tomorrowLabel } = date
  const [profile, setProfile] = useState<PlanProfile>("balanced")
  const [targets, setTargets] = useState<Record<MealType, number>>(defaultTargets)
  const [lunch, setLunch] = useState<Dish[]>([])
  const [dinner, setDinner] = useState<Dish[]>([])
  const [originalRecords, setOriginalRecords] = useState<MealRecord[]>([])
  const [originalVersion, setOriginalVersion] = useState("")
  const [conflict, setConflict] = useState<PlanConflict | null>(null)
  const [readingConflict, setReadingConflict] = useState(false)
  const [initializedFor, setInitializedFor] = useState<string | null>(null)
  const [pickerMeal, setPickerMeal] = useState<MealType | null>(null)
  const initStartedForRef = useRef<string | null>(null)
  const retryRequest = useRef<{
    key: string
    id: string
  } | null>(null)
  const saveLock = useRef(false)
  const selectedMealById = useMemo(() => {
    const map = new Map<number, MealType>()
    lunch.forEach((dish) => map.set(dish.id, "lunch"))
    dinner.forEach((dish) => map.set(dish.id, "dinner"))
    return map
  }, [lunch, dinner])
  const {
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
  } = usePlanRecommendations({
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
  })
  useEffect(() => {
    const gate = requestGate.current
    gate.activate()
    return () => {
      gate.dispose()
      initStartedForRef.current = null
    }
  }, [tomorrowStr, requestGate])
  const {
    data: tomorrowRecords,
    isLoading: recordsLoading,
    isFetchedAfterMount,
    isSuccess: recordsReady,
    isError: recordsError,
    refetch: reloadRecords
  } = useQuery({
    queryKey: ["records", "tomorrow", tomorrowStr],
    queryFn: () => recordsApi.plan(tomorrowStr),
    refetchOnMount: "always"
  })
  useEffect(() => {
    if (!isFetchedAfterMount || !recordsReady || initializedFor === tomorrowStr) return
    if (initStartedForRef.current === tomorrowStr) return
    initStartedForRef.current = tomorrowStr
    const records = tomorrowRecords?.records || []
    const stored = readTomorrowDraft(tomorrowStr, tomorrowPlanBaseline(records))
    setOriginalRecords(records)
    setOriginalVersion(tomorrowRecords?.version || "")
    if (stored.kind === "restored" || stored.kind === "conflict") {
      // Initialize once from external storage, only after checking the fresh server baseline.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLunch(stored.draft.lunch)
      setDinner(stored.draft.dinner)
      setTargets(stored.draft.targets)
      setProfile(stored.draft.profile)
      if (stored.kind === "conflict")
        setConflict({ latest: tomorrowRecords || null, reason: "changed" })
      setInitializedFor(tomorrowStr)
      return
    }
    if (records.length > 0) {
      const nextLunch = mealRecords(records, "lunch").map(recordToDish)
      const nextDinner = mealRecords(records, "dinner").map(recordToDish)
      // Each date initializes once; subsequent query refreshes must not overwrite edits.
      setLunch(nextLunch)
      setDinner(nextDinner)
      setTargets({
        lunch: Math.min(maxPerMeal, Math.max(nextLunch.length, defaultTargets.lunch)),
        dinner: Math.min(maxPerMeal, Math.max(nextDinner.length, defaultTargets.dinner))
      })
      setInitializedFor(tomorrowStr)
      return
    }
    setLunch([])
    setDinner([])
    setTargets(defaultTargets)
    void generateAll(profile, defaultTargets, tomorrowStr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializedFor, isFetchedAfterMount, recordsReady, tomorrowRecords, tomorrowStr])
  // 从已保存记录还原的菜只有 id/名字/图片（recordToDish），用时和难度都是占位值：
  // 按 id 批量取完整菜品用于展示（编辑和保存仍以 lunch/dinner 状态为准，只用到 id 和名字）
  const recordDishIds = useMemo(
    () => [...new Set(originalRecords.map((r) => r.dish_id))].sort((a, b) => a - b),
    [originalRecords]
  )
  const { data: recordDishesData } = useQuery({
    queryKey: ["dishes", "by-ids", recordDishIds.join(",")],
    queryFn: () => dishesApi.list({ ids: recordDishIds.join(","), pageSize: "100" }),
    enabled: recordDishIds.length > 0,
    staleTime: 60000
  })
  const lunchView = useMemo(
    () => hydrateDishes(lunch, recordDishesData?.items),
    [lunch, recordDishesData]
  )
  const dinnerView = useMemo(
    () => hydrateDishes(dinner, recordDishesData?.items),
    [dinner, recordDishesData]
  )
  const recordsToSave = useMemo(() => {
    const records: {
      dish_id: number
      meal_type: string
    }[] = []
    for (const [meal, dishes] of [
      ["lunch", lunch],
      ["dinner", dinner]
    ] as const) {
      dishes.forEach((dish) =>
        records.push({
          dish_id: dish.id,
          meal_type: meal
        })
      )
    }
    return records
  }, [dinner, lunch])
  const hasSavedPlan = originalRecords.length > 0
  const totalCount = lunch.length + dinner.length
  const currentKey = keyFromDishes(lunch, dinner)
  const originalKey = keyFromRecords(originalRecords)
  const hasChanges = initializedFor === tomorrowStr && currentKey !== originalKey
  const loading = recordsLoading || initializedFor !== tomorrowStr
  const savePlanMut = useMutation({
    mutationFn: ({ date, version, requestID, dishes }: SavePlanPayload) =>
      recordsApi.savePlan(date, {
        expected_version: version,
        request_id: requestID,
        dishes
      }),
    onSuccess: (res, variables) => {
      qc.invalidateQueries({ queryKey: ["records"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      qc.invalidateQueries({ queryKey: ["record"] })
      qc.invalidateQueries({ queryKey: ["dish-records"] })
      qc.invalidateQueries({ queryKey: ["admin", "records"] })
      if (!requestGate.current.active() || variables.date !== getTomorrow().str) return
      setOriginalRecords(res.records)
      setOriginalVersion(res.version)
      setConflict(null)
      retryRequest.current = null
      // Keep even an empty snapshot, so clearing a menu does not regenerate it on return.
      writeTomorrowDraft(variables.date, tomorrowPlanBaseline(res.records), variables.draft)
      launchConfetti(confettiRef.current)
      toast.success(
        res.replayed
          ? "已确认上次保存成功"
          : variables.wasSaved
            ? "明天菜单已更新"
            : "明天菜单已保存"
      )
    },
    onError: async (error, variables) => {
      if (!requestGate.current.active() || variables.date !== getTomorrow().str) return
      // A transport failure may follow a committed save. Reconcile before any
      // further editing, otherwise reverting to the old baseline can look saved.
      const reason = isMealPlanConflict(error) ? "changed" : "unconfirmed"
      setConflict({ latest: null, reason })
      await loadConflictingPlan(variables.date)
      if (requestGate.current.active() && variables.date === getTomorrow().str) {
        toast.error(
          reason === "changed"
            ? "菜单已有变化，你的草稿已保留，请核对后继续"
            : "保存结果未确认，请核对服务器菜单后继续",
          { duration: 5000 }
        )
      }
    },
    onSettled: () => {
      saveLock.current = false
    }
  })
  const disabled = loading || picking || savePlanMut.isPending
  useEffect(() => {
    if (
      initializedFor !== tomorrowStr ||
      savePlanMut.isPending ||
      conflict ||
      tomorrowStr !== getTomorrow().str
    )
      return
    writeTomorrowDraft(tomorrowStr, tomorrowPlanBaseline(originalRecords), {
      lunch,
      dinner,
      targets,
      profile
    })
  }, [
    initializedFor,
    tomorrowStr,
    savePlanMut.isPending,
    conflict,
    originalRecords,
    lunch,
    dinner,
    targets,
    profile
  ])
  async function loadConflictingPlan(date = tomorrowStr) {
    setReadingConflict(true)
    try {
      const latest = await recordsApi.plan(date)
      if (requestGate.current.active() && date === getTomorrow().str) {
        setConflict((previous) => (previous ? { ...previous, latest } : null))
      }
    } catch {
      if (requestGate.current.active() && date === getTomorrow().str)
        toast.error("最新菜单读取失败，草稿仍在，请重试")
    } finally {
      if (requestGate.current.active() && date === getTomorrow().str) setReadingConflict(false)
    }
  }
  function acceptLatestPlan(keepDraft: boolean) {
    const latest = conflict?.latest
    if (!latest) return
    invalidateRecommendations()
    setOriginalRecords(latest.records)
    setOriginalVersion(latest.version)
    setConflict(null)
    retryRequest.current = null
    if (!keepDraft) {
      setLunch(mealRecords(latest.records, "lunch").map(recordToDish))
      setDinner(mealRecords(latest.records, "dinner").map(recordToDish))
    }
    toast(keepDraft ? "已核对最新记录，请检查草稿后再次保存" : "已载入最新菜单")
  }
  function openDish(dish: Dish, meal: MealType) {
    const saved = originalRecords.find((r) => r.dish_id === dish.id && r.meal_type === meal)
    navigate(`/dishes/${dish.id}${saved ? `?record_id=${saved.id}` : ""}`)
  }
  function savePlan() {
    if (saveLock.current || conflict) return
    if (tomorrowStr !== getTomorrow().str) {
      setInitializedFor(null)
      toast("日期已变化，正在重新读取明日菜单")
      return
    }
    if (recordsToSave.length === 0 && !hasSavedPlan) {
      toast.error("至少选一道菜")
      return
    }
    if (hasSavedPlan && !hasChanges) {
      toast("菜单没有变化")
      return
    }
    invalidateRecommendations()
    const requestKey = JSON.stringify([tomorrowStr, originalVersion, recordsToSave])
    if (retryRequest.current?.key !== requestKey) {
      retryRequest.current = {
        key: requestKey,
        id:
          globalThis.crypto?.randomUUID?.() ||
          `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
      }
    }
    saveLock.current = true
    const draft = { lunch, dinner, targets, profile }
    writeTomorrowDraft(tomorrowStr, tomorrowPlanBaseline(originalRecords), draft)
    savePlanMut.mutate({
      date: tomorrowStr,
      draft,
      version: originalVersion,
      requestID: retryRequest.current.id,
      dishes: recordsToSave,
      wasSaved: hasSavedPlan
    })
  }
  return {
    confettiRef,
    recordsError,
    initializedFor,
    tomorrowStr,
    reloadRecords,
    loading,
    conflict,
    acceptLatestPlan,
    readingConflict,
    loadConflictingPlan,
    savePlanMut,
    tomorrowLabel,
    totalCount,
    hasSavedPlan,
    hasChanges,
    lunchView,
    targets,
    disabled,
    updateTarget,
    openDish,
    fillMeal,
    replaceMeal,
    swapDish,
    removeDish,
    setPickerMeal,
    dinnerView,
    generateAll,
    profile,
    applyProfile,
    savePlan,
    pickerMeal,
    selectedMealById,
    addManual
  }
}
