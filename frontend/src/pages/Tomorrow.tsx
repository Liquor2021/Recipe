import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { getTomorrow, nextLocalMidnightDelay } from "@/lib/tomorrowDate"
import PageHeader from "@/components/PageHeader"
import DishPickerModal from "@/components/DishPickerModal"
import "@/styles/kitchen-tools.css"
import { CalendarClock, Check, Dice5, ShoppingBasket } from "lucide-react"
import { mealOrder, profileOptions, mealMeta, mealRecords } from "@/pages/tomorrow/model"
import {
  PlanMealCard,
  ProfileButton,
  PlanSummary,
  LoadingState
} from "@/pages/tomorrow/PlanMealCard"
import { usePlanEditor } from "@/pages/tomorrow/usePlanEditor"
export default function Tomorrow() {
  const [date, setDate] = useState(getTomorrow)
  useEffect(() => {
    let timer: number
    function refresh() {
      const next = getTomorrow()
      setDate((previous) => (previous.str === next.str ? previous : next))
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, nextLocalMidnightDelay())
    }
    function onVisibility() {
      if (document.visibilityState === "visible") refresh()
    }
    timer = window.setTimeout(refresh, nextLocalMidnightDelay())
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])
  // A new calendar date owns a fresh editor, including drafts, pending requests
  // and conflict state. Failed recommendations cannot retain yesterday's dishes.
  return <TomorrowEditor key={date.str} date={date} />
}
function TomorrowEditor({ date }: { date: ReturnType<typeof getTomorrow> }) {
  const navigate = useNavigate()
  const {
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
  } = usePlanEditor(date)
  return (
    <div className="animate-fadeUp pb-[116px] k-tools-page k-tomorrow-page">
      {createPortal(
        <div
          ref={confettiRef}
          className="fixed inset-0 z-50 pointer-events-none overflow-hidden"
        />,
        document.body
      )}

      <PageHeader title="明天吃什么" icon={CalendarClock} onBack={() => navigate(-1)} />

      {recordsError && initializedFor !== tomorrowStr ? (
        <div className="px-5 py-12 text-center text-text2">
          <p>明日计划读取失败，请重试。</p>
          <button
            onClick={() => reloadRecords()}
            className="mt-4 rounded-full bg-primary px-5 py-2 text-sm text-white"
          >
            重新读取
          </button>
        </div>
      ) : loading ? (
        <LoadingState />
      ) : (
        <main className="px-5 py-4">
          {conflict && (
            <section
              className="mx-auto mb-4 max-w-[640px] rounded-2xl border border-yellow/40 bg-yellow-light p-4"
              role="alert"
            >
              <div className="font-bold text-text">
                {conflict.reason === "unconfirmed"
                  ? "保存结果未确认，草稿已保留"
                  : "菜单已有变化，草稿已保留"}
              </div>
              <p className="mt-1 text-sm text-text2">
                请核对最新安排，再决定继续编辑这份草稿，或载入最新菜单。
              </p>
              {conflict.latest ? (
                <>
                  {mealOrder.map((meal) => (
                    <p key={meal} className="mt-2 text-sm text-text2">
                      最新{mealMeta[meal].shortLabel}：
                      {mealRecords(conflict.latest!.records, meal)
                        .map(
                          (record) =>
                            `${record.dish_name}${record.portion_scale !== 1 ? ` ×${record.portion_scale}` : ""}`
                        )
                        .join("、") || "未安排"}
                    </p>
                  ))}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => acceptLatestPlan(true)}
                      className="min-h-11 rounded-full bg-primary px-4 text-sm font-semibold text-white"
                    >
                      保留草稿继续编辑
                    </button>
                    <button
                      onClick={() => acceptLatestPlan(false)}
                      className="min-h-11 rounded-full border border-border bg-card px-4 text-sm font-semibold text-text2"
                    >
                      载入最新菜单
                    </button>
                  </div>
                </>
              ) : (
                <button
                  disabled={readingConflict}
                  onClick={() => void loadConflictingPlan()}
                  className="mt-3 min-h-11 rounded-full bg-card px-4 text-sm font-semibold text-primary"
                >
                  {readingConflict ? "读取最新菜单…" : "重新读取最新菜单"}
                </button>
              )}
            </section>
          )}
          <fieldset
            disabled={savePlanMut.isPending || !!conflict}
            className="k-plan-layout mx-auto min-w-0 max-w-[640px]"
          >
            <div className="k-plan-paper">
              <PlanSummary
                dateLabel={tomorrowLabel}
                totalCount={totalCount}
                hasSavedPlan={hasSavedPlan}
                hasChanges={hasChanges}
                pendingReview={!!conflict}
              />

              <div className="k-plan-meals">
                <PlanMealCard
                  meal="lunch"
                  dishes={lunchView}
                  target={targets.lunch}
                  disabled={disabled}
                  onTargetChange={(value) => updateTarget("lunch", value)}
                  onOpenDish={(dish) => openDish(dish, "lunch")}
                  onFill={() => fillMeal("lunch")}
                  onReplaceMeal={() => replaceMeal("lunch")}
                  onSwapDish={(dishId) => swapDish("lunch", dishId)}
                  onRemoveDish={(dishId) => removeDish("lunch", dishId)}
                  onOpenPicker={() => setPickerMeal("lunch")}
                />

                <PlanMealCard
                  meal="dinner"
                  dishes={dinnerView}
                  target={targets.dinner}
                  disabled={disabled}
                  onTargetChange={(value) => updateTarget("dinner", value)}
                  onOpenDish={(dish) => openDish(dish, "dinner")}
                  onFill={() => fillMeal("dinner")}
                  onReplaceMeal={() => replaceMeal("dinner")}
                  onSwapDish={(dishId) => swapDish("dinner", dishId)}
                  onRemoveDish={(dishId) => removeDish("dinner", dishId)}
                  onOpenPicker={() => setPickerMeal("dinner")}
                />
              </div>
            </div>
            <section className="k-plan-preferences">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="k-tool-section-title">「口味偏好」</h2>
                  <div className="text-[11px] font-medium text-text3">生成和替换都会按这里来</div>
                </div>
                <button
                  onClick={() => generateAll()}
                  disabled={disabled}
                  className="k-tool-text-button"
                >
                  <Dice5 size={14} strokeWidth={2.5} />
                  重新生成
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                {profileOptions.map((option) => (
                  <ProfileButton
                    key={option.key}
                    option={option}
                    active={profile === option.key}
                    onClick={() => applyProfile(option.key)}
                  />
                ))}
              </div>
            </section>

            <button
              type="button"
              onClick={() => navigate("/more#shopping")}
              className="k-plan-shopping-note"
            >
              <ShoppingBasket size={17} aria-hidden="true" />
              <span>保存后自动生成明天的买菜清单</span>
              <span className="k-plan-shopping-link">查看清单</span>
            </button>
          </fieldset>
        </main>
      )}

      {!loading && (
        <div
          className="k-plan-save-bar"
          style={{ paddingBottom: "calc(12px + env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto flex max-w-[640px] items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-bold text-text2">
                {totalCount > 0 ? `${tomorrowLabel} · ${totalCount} 道菜` : "还没有选择菜品"}
              </div>
              <div className="truncate text-[11px] font-medium text-text3">
                {conflict
                  ? "核对最新菜单后继续"
                  : hasSavedPlan
                    ? hasChanges
                      ? "保存后会覆盖原明日菜单"
                      : "当前菜单已同步到买菜清单"
                    : "保存后自动生成买菜清单"}
              </div>
            </div>
            <button
              onClick={savePlan}
              disabled={
                disabled ||
                !!conflict ||
                (totalCount === 0 && !hasSavedPlan) ||
                (hasSavedPlan && !hasChanges)
              }
              className="k-tool-button is-ink k-plan-save-button"
            >
              <Check size={17} strokeWidth={2.6} />
              {conflict
                ? "待核对"
                : savePlanMut.isPending
                  ? "保存中"
                  : hasSavedPlan
                    ? hasChanges
                      ? "更新菜单"
                      : "已保存"
                    : "保存菜单"}
            </button>
          </div>
        </div>
      )}

      {pickerMeal && (
        <DishPickerModal
          meal={pickerMeal}
          selectedMealById={selectedMealById}
          onAdd={(dish) => addManual(pickerMeal, dish)}
          onRemove={(meal, dishId) => removeDish(meal, dishId)}
          onClose={() => setPickerMeal(null)}
        />
      )}
    </div>
  )
}
