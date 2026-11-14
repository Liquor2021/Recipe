import type { Dish } from "@/types"
import DishImage from "@/components/DishImage"
import "@/styles/kitchen-tools.css"
import { Dice5, Minus, Plus, RefreshCw, Search, Trash2, UtensilsCrossed } from "lucide-react"
import {
  type MealType,
  maxPerMeal,
  profileOptions,
  mealMeta,
  diffLabel
} from "@/pages/tomorrow/model"
export function CountStepper({
  value,
  onChange
}: {
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="k-plan-stepper">
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className="flex items-center justify-center text-text3 transition-all hover:text-primary disabled:opacity-30"
        aria-label="减少数量"
        title="减少数量"
      >
        <Minus size={14} strokeWidth={2.4} />
      </button>
      <div className="flex items-center justify-center text-sm font-extrabold text-text">
        {value}
      </div>
      <button
        onClick={() => onChange(Math.min(maxPerMeal, value + 1))}
        disabled={value >= maxPerMeal}
        className="flex items-center justify-center text-text3 transition-all hover:text-primary disabled:opacity-30"
        aria-label="增加数量"
        title="增加数量"
      >
        <Plus size={14} strokeWidth={2.4} />
      </button>
    </div>
  )
}
export function ProfileButton({
  option,
  active,
  onClick
}: {
  option: (typeof profileOptions)[number]
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={option.hint}
      className={`k-tool-chip ${active ? "is-active" : ""}`}
    >
      {option.label}
    </button>
  )
}
export function PlanSummary({
  dateLabel,
  totalCount,
  hasSavedPlan,
  hasChanges,
  pendingReview
}: {
  dateLabel: string
  totalCount: number
  hasSavedPlan: boolean
  hasChanges: boolean
  pendingReview: boolean
}) {
  const savedText = pendingReview
    ? "待核对"
    : hasSavedPlan
      ? hasChanges
        ? "有修改"
        : "已保存"
      : "待保存"
  const savedTone = hasSavedPlan && !hasChanges && !pendingReview ? "is-fresh" : "is-urgent"
  return (
    <header className="k-plan-heading">
      <span className={`k-tool-stamp k-plan-save-stamp ${savedTone}`}>{savedText}</span>
      <h2>明日菜单</h2>
      <p>
        {dateLabel} · 共 {totalCount} 道
      </p>
    </header>
  )
}
export function DishRow({
  dish,
  meal,
  onOpen,
  onSwap,
  onRemove
}: {
  dish: Dish
  meal: MealType
  onOpen: () => void
  onSwap: () => void
  onRemove: () => void
}) {
  return (
    <div className="k-plan-dish">
      <button
        onClick={onOpen}
        className="k-tool-polaroid k-plan-photo"
        aria-label={`查看${dish.name}`}
      >
        <DishImage dish={dish} className="h-full w-full" emojiSize="text-[30px]" />
      </button>
      <button onClick={onOpen} className="k-plan-dish-name">
        <strong>{dish.name}</strong>
        <span>
          {[
            dish.category,
            dish.cook_time > 0 ? `${dish.cook_time} 分钟` : "",
            `火候·${diffLabel(dish.difficulty)}`
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      <span className="k-tool-leader" aria-hidden="true" />
      <div className="k-plan-dish-actions">
        <button
          onClick={onSwap}
          className="k-tool-icon-button"
          aria-label={`替换${mealMeta[meal].shortLabel}的${dish.name}`}
          title="换一个"
        >
          <RefreshCw size={16} strokeWidth={2.35} />
        </button>
        <button
          onClick={onRemove}
          className="k-tool-icon-button is-delete"
          aria-label={`移除${dish.name}`}
          title="移除"
        >
          <Trash2 size={16} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  )
}
export function PlanMealCard({
  meal,
  dishes,
  target,
  disabled,
  onTargetChange,
  onOpenDish,
  onFill,
  onReplaceMeal,
  onSwapDish,
  onRemoveDish,
  onOpenPicker
}: {
  meal: MealType
  dishes: Dish[]
  target: number
  disabled: boolean
  onTargetChange: (value: number) => void
  onOpenDish: (dish: Dish) => void
  onFill: () => void
  onReplaceMeal: () => void
  onSwapDish: (dishId: number) => void
  onRemoveDish: (dishId: number) => void
  onOpenPicker: () => void
}) {
  const meta = mealMeta[meal]
  const missing = Math.max(0, target - dishes.length)
  return (
    <section className="k-plan-meal">
      <div className="k-plan-meal-heading">
        <h3>{meal === "lunch" ? "午市" : "晚市"}</h3>
        <CountStepper value={target} onChange={onTargetChange} />
      </div>

      <div>
        {dishes.length === 0 ? (
          <div className="py-7 text-center">
            <div
              className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl ${meta.soft} ${meta.text}`}
            >
              <UtensilsCrossed size={24} strokeWidth={2.35} />
            </div>
            <div className="text-sm font-bold text-text">还没选{meta.shortLabel}</div>
            <div className="mt-1 text-[12px] text-text3">可以智能补齐，也可以自己挑</div>
          </div>
        ) : (
          <div>
            {dishes.map((dish) => (
              <DishRow
                key={dish.id}
                dish={dish}
                meal={meal}
                onOpen={() => onOpenDish(dish)}
                onSwap={() => onSwapDish(dish.id)}
                onRemove={() => onRemoveDish(dish.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="k-plan-meal-tools">
        <button
          onClick={onFill}
          disabled={disabled || missing === 0}
          className="k-tool-text-button"
        >
          <Plus size={15} strokeWidth={2.5} />
          {missing > 0 ? `补 ${missing} 道` : "已够数"}
        </button>
        <button
          onClick={onReplaceMeal}
          disabled={disabled || target === 0}
          className="k-tool-text-button"
        >
          <Dice5 size={15} strokeWidth={2.5} />
          换一批
        </button>
        <button onClick={onOpenPicker} disabled={disabled} className="k-tool-text-button">
          <Search size={15} strokeWidth={2.5} />
          手动选
        </button>
      </div>
    </section>
  )
}
export function LoadingState() {
  return (
    <div className="px-5 py-4">
      <div className="mx-auto max-w-[640px] space-y-4">
        <div className="h-[194px] rounded-[24px] skeleton" />
        <div className="h-[180px] rounded-[24px] skeleton" />
        <div className="h-[180px] rounded-[24px] skeleton" />
      </div>
    </div>
  )
}
