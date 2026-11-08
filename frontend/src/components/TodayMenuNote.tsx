import { useNavigate } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import type { MealRecord } from "@/types"
import { mealMoodOptions } from "@/lib/mealRating"

const mealNames: Record<string, string> = { breakfast: "早市", lunch: "午市", dinner: "晚市", snack: "加餐", extra: "加餐" }
const mealOrder: Record<string, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3, extra: 3 }

export default function TodayMenuNote({ date, records, mood, pending, error, onRetry }: { date: string; records: MealRecord[]; mood?: string; pending: boolean; error: boolean; onRetry: () => void }) {
  const navigate = useNavigate()
  const menu = records.filter((record) => record.meal_date === date && record.status !== "cancelled")
    .sort((a, b) => (mealOrder[a.meal_type] ?? 4) - (mealOrder[b.meal_type] ?? 4) || a.id - b.id)
  const completed = menu.filter((record) => record.status === "completed").length
  const historyPath = `/history?date=${date}`
  return <section className="kitchen-today-menu" aria-labelledby="today-menu-title">
    <header><h2 id="today-menu-title"><span className="kitchen-today-icon" aria-hidden="true">🍱</span><span><i>「</i>今日菜单<i>」</i></span></h2><button type="button" onClick={() => navigate("/dishes")}>去挑两道 <ArrowRight size={12} aria-hidden="true" /></button></header>
    {pending ? <p role="status">正在翻开今日菜单…</p> : error ? <button type="button" className="kitchen-today-retry" onClick={onRetry}>今日菜单读取失败，点此重试</button> : menu.length ? <>
      <ul>{menu.slice(0, 4).map((record) => <li key={record.id}>
        <button type="button" className="kitchen-today-row" aria-label={`${mealNames[record.meal_type] || "加餐"}，${record.dish_name}，${record.status === "completed" ? "已吃" : "待做"}，查看记录`} onClick={() => navigate(`${historyPath}&record=${record.id}`)}>
          <span className={`kitchen-today-meal is-${record.meal_type}`}>{mealNames[record.meal_type] || "加餐"}</span><strong>{record.dish_name}</strong><span className={`kitchen-today-status ${record.status === "completed" ? "is-eaten" : ""}`}>{record.status === "completed" ? "已吃" : "待做"}</span>{record.status === "completed" && record.rating > 0 && <small aria-label={`${record.rating}星`}>★{record.rating}</small>}
        </button>
      </li>)}</ul>
      {menu.length > 4 && <button type="button" className="kitchen-today-more" onClick={() => navigate(historyPath)}>查看全部 {menu.length} 道 <ArrowRight size={12} aria-hidden="true" /></button>}
    </> : <p>今天的菜单还是空白，挑两道想吃的吧。</p>}
    {!pending && !error && menu.length > 0 && <footer>
      <span>{completed ? "吃完打个分" : "吃完再打分"}</span>
      <div className="kitchen-today-moods" role="group" aria-label="今日用餐评价">
        {mealMoodOptions.map((option) => <button type="button" key={option.key} disabled={!completed} aria-label={`今日用餐${option.label}，打开评价`} aria-pressed={!!completed && mood === option.key} title={completed ? option.label : "先在今日记录里标记已吃，再来评价"} onClick={() => navigate(`${historyPath}&review=day&mood=${option.key}`)}><span aria-hidden="true">{option.emoji}</span></button>)}
      </div>
    </footer>}
  </section>
}
