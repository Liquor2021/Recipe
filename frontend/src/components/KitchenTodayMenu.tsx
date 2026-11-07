import { LoaderCircle, Trash2 } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
import { mealSelectionKey } from "@/lib/mealSelection"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import type { Dish, MealRecord } from "@/types"
import "@/styles/kitchen-fonts.css"
import "@/styles/kitchen-menu.css"

interface KitchenTodayMenuProps {
  today: string
  lunchRecords: MealRecord[]
  dinnerRecords: MealRecord[]
  dishes: Map<number, Dish>
  pendingMeals: Set<string | undefined>
  unavailable: boolean
  refreshing: boolean
  onRetry: () => void
  onClose: () => void
  onCancel: (record: MealRecord) => void
  onOpenDish: (record: MealRecord) => void
}

export default function KitchenTodayMenu({
  today, lunchRecords, dinnerRecords, dishes, pendingMeals,
  unavailable, refreshing, onRetry, onClose, onCancel, onOpenDish,
}: KitchenTodayMenuProps) {
  const theme = useKitchenTheme((state) => state.theme)
  const date = new Date(`${today}T12:00:00`)
  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日 · 星期${"日一二三四五六"[date.getDay()]}`
  const records = [...lunchRecords, ...dinnerRecords]
  const completed = records.filter((record) => record.status === "completed").length

  return (
    <KitchenSheet title="今日菜单" theme={theme} onClose={onClose} className="kitchen-menu-sheet">
      <div className="kitchen-menu-date">
        <time dateTime={today}>{dateLabel}</time>
        <span> · 共 {records.length} 道</span>
      </div>
      <div className="kitchen-menu-rule" aria-hidden="true" />

      {unavailable && (
        <div className="kitchen-menu-warning" role="alert">
          <span>菜单状态读取失败，暂时不能修改计划。</span>
          <button type="button" onClick={onRetry} disabled={refreshing}>重新读取</button>
        </div>
      )}

      <div className="kitchen-menu-sections">
        {([
          { name: "午市", meal: "午餐", records: lunchRecords },
          { name: "晚市", meal: "晚餐", records: dinnerRecords },
        ]).map((section) => section.records.length > 0 && (
          <section key={section.name} className="kitchen-menu-section" aria-label={section.meal}>
            <h3>{section.name}</h3>
            <ul>
              {section.records.map((record) => {
                const dish = dishes.get(record.dish_id)
                const pending = pendingMeals.has(mealSelectionKey(record))
                const cooked = record.status === "completed"
                return (
                  <li key={record.id} className="kitchen-menu-item">
                    <button
                      type="button"
                      className="kitchen-menu-dish"
                      onClick={() => onOpenDish(record)}
                      aria-label={`查看${record.dish_name}的做法`}
                    >
                      <span className="kitchen-menu-line">
                        <strong>{record.dish_name}</strong>
                        <span className="kitchen-menu-leader" aria-hidden="true" />
                        {dish && dish.cook_time > 0 && <span className="kitchen-menu-time">{dish.cook_time}分钟</span>}
                      </span>
                      <span className="kitchen-menu-portion">原量 × {record.portion_scale || 1}{dish?.category ? ` · ${dish.category}` : ""}</span>
                    </button>
                    <span className={`kitchen-menu-stamp ${cooked ? "is-cooked" : "is-planned"}`}>
                      {cooked ? "吃过了" : "待做"}
                    </span>
                    {record.status === "planned" && (
                      <button
                        type="button"
                        className="kitchen-menu-cancel"
                        onClick={() => onCancel(record)}
                        aria-label={pending ? `正在更新${record.dish_name}的计划` : `取消${record.dish_name}的计划`}
                        title="取消这道菜的计划"
                        aria-busy={pending}
                        disabled={unavailable || pending}
                      >
                        {pending ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {records.length === 0 && <p className="kitchen-menu-empty">今日菜单还是空白，选几道喜欢的吧。</p>}
      </div>

      <footer className="kitchen-menu-footer">
        <span>{records.length > 0 ? `已吃 ${completed} 道 · 待做 ${records.length - completed} 道` : "好好安排下一餐"}</span>
        <button type="button" onClick={onClose}>继续选菜</button>
      </footer>
    </KitchenSheet>
  )
}
