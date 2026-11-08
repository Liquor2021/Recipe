import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Heart, Plus, Search, X } from "lucide-react"
import toast from "react-hot-toast"
import { favoritesApi } from "@/api"
import DishImage from "@/components/DishImage"
import PageHeader from "@/components/PageHeader"
import type { FavoriteOverviewItem } from "@/types"
import "@/styles/kitchen-memories.css"

type SortKey = "favorite" | "time" | "repeat" | "name"
type ShelfKey = "all" | "quick" | "repeat" | "try"
const sortOptions: Array<{ key: SortKey; label: string }> = [
  { key: "favorite", label: "收藏时间" }, { key: "time", label: "最快上桌" },
  { key: "repeat", label: "常吃优先" }, { key: "name", label: "名称" },
]

function formatDate(value: string) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const prefix = date.getFullYear() === new Date().getFullYear() ? "" : date.getFullYear() + "."
  return prefix + String(date.getMonth() + 1).padStart(2, "0") + "." + String(date.getDate()).padStart(2, "0")
}
function dateValue(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}
function inShelf(item: FavoriteOverviewItem, shelf: ShelfKey) {
  if (shelf === "quick") return item.dish.cook_time > 0 && item.dish.cook_time <= 30
  if (shelf === "repeat") return item.record_count > 0
  if (shelf === "try") return item.record_count === 0
  return true
}

export default function Favorites() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [activeCategory, setActiveCategory] = useState("全部")
  const [sortBy, setSortBy] = useState<SortKey>("favorite")
  const [shelf, setShelf] = useState<ShelfKey>("all")
  const [search, setSearch] = useState("")
  const { data: overview, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: ["favorites", "overview"], queryFn: () => favoritesApi.overview(),
  })
  const items = useMemo(() => overview?.items ?? [], [overview])
  const stats = overview?.stats
  const categories = overview?.categories ?? []
  const favMut = useMutation({
    mutationFn: (dishId: number) => favoritesApi.remove(dishId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["favorites"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      toast("已取消收藏")
    },
    onError: () => toast.error("取消收藏失败"),
  })
  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return items
      .filter((item) => inShelf(item, shelf))
      .filter((item) => activeCategory === "全部" || (item.dish.category || "其他") === activeCategory)
      .filter(({ dish }) => !keyword || [dish.name, dish.category, dish.taste, dish.remark, ...(dish.tags || [])]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword)))
      .sort((a, b) => {
        if (sortBy === "time") return (a.dish.cook_time || 9999) - (b.dish.cook_time || 9999) || a.dish.name.localeCompare(b.dish.name, "zh-Hans-CN")
        if (sortBy === "repeat") return b.record_count - a.record_count || dateValue(b.last_eaten_at) - dateValue(a.last_eaten_at)
        if (sortBy === "name") return a.dish.name.localeCompare(b.dish.name, "zh-Hans-CN")
        return dateValue(b.favorite_created_at) - dateValue(a.favorite_created_at)
      })
  }, [activeCategory, items, search, shelf, sortBy])

  function selectShelf(next: ShelfKey) {
    setShelf((current) => current === next ? "all" : next)
    if (next === "quick") setSortBy("time")
    if (next === "repeat") setSortBy("repeat")
  }

  return (
    <div className="kitchen-favorites animate-fadeUp">
      <PageHeader title="收藏" meta="常做的都在这" />
      <div className="kitchen-memory-body">
        {isError && <div role="alert" className="memory-error">
          <strong>{overview ? "收藏暂时无法更新" : "收藏加载失败"}</strong>
          <p>{overview ? "下方保留上次读取的收藏，可以重试更新。" : "请检查网络后重试，已有收藏不会丢失。"}</p>
          <button disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "正在重试…" : "重新加载"}</button>
        </div>}
        {isPending ? <FavoritesSkeleton /> : isError && !overview ? null : items.length === 0 || !stats ? (
          <div className="collection-empty">
            <Heart size={34} strokeWidth={1.5} aria-hidden="true" />
            <h2>菜库的第一页，留给喜欢的菜</h2>
            <p>把常吃的、想尝试的菜收藏起来，下次翻开就能找到。</p>
            <button className="memory-ink-button" onClick={() => navigate("/dishes")}>去挑几道菜 <ArrowRight size={16} /></button>
          </div>
        ) : <>
          <section className="collection-title-leaf" aria-label="私人菜库概览">
            <div>
              <p className="collection-label">私人菜库</p>
              <h2>{stats.total}<span>道</span></h2>
              <p>{stats.category_total} 个分类 · 吃过 {stats.cooked_count} 道{stats.avg_cook_time > 0 && <span className="collection-average"> · 平均 {stats.avg_cook_time} 分钟</span>}</p>
            </div>
            <button className="memory-ink-button" onClick={() => navigate("/dishes")}><Plus size={16} strokeWidth={1.8} />加菜</button>
          </section>
          <div className="collection-index" role="group" aria-label="菜库索引">
            {([
              { key: "quick", title: "快手", note: "30 分钟内上桌" },
              { key: "repeat", title: "常做", note: "吃过的老味道" },
              { key: "try", title: "未尝试", note: "留给下一顿" },
            ] as const).map((group) => <button key={group.key} aria-pressed={shelf === group.key} onClick={() => selectShelf(group.key)}>
              <strong>{group.title} <span>{items.filter((item) => inShelf(item, group.key)).length}</span></strong>
              <small>{group.note}</small>
            </button>)}
          </div>
          <div className="collection-categories" role="group" aria-label="收藏分类">
            <button aria-pressed={activeCategory === "全部"} onClick={() => setActiveCategory("全部")}>全部 {items.length}</button>
            {categories.map((category) => <button key={category.category} aria-pressed={activeCategory === category.category} onClick={() => setActiveCategory(category.category)}>{category.category} {category.count}</button>)}
          </div>
          <div className="collection-search">
            <Search size={16} strokeWidth={1.7} aria-hidden="true" />
            <input aria-label="搜索收藏菜、口味、标签" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="写个名字，翻翻收藏…" />
            {search && <button aria-label="清空搜索" onClick={() => setSearch("")}><X size={16} /></button>}
          </div>
          <div className="collection-list-heading">
            <h2>「收藏清单」</h2>
            <label className="collection-sort"><span className="sr-only">收藏排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortKey)}>{sortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
          </div>
          <div className="collection-result-count" aria-live="polite">
            <span>当前显示 {filteredItems.length} 道{shelf !== "all" ? " · " + (shelf === "quick" ? "快手" : shelf === "repeat" ? "常做" : "未尝试") : ""}</span>
            {(activeCategory !== "全部" || shelf !== "all" || search) && <button onClick={() => { setShelf("all"); setActiveCategory("全部"); setSearch("") }}>查看全部</button>}
          </div>
          {filteredItems.length === 0 ? <div className="collection-no-results"><h3>这一页还没有找到</h3><p>换个关键词、分类或索引试试。</p></div> : <div className="collection-rows">
            {filteredItems.map((item) => <FavoriteRow key={item.dish.id} item={item} removing={favMut.isPending && favMut.variables === item.dish.id} onClick={() => navigate("/dishes/" + item.dish.id)} onRemove={() => favMut.mutate(item.dish.id)} />)}
          </div>}
        </>}
      </div>
    </div>
  )
}

function FavoriteRow({ item, removing, onClick, onRemove }: { item: FavoriteOverviewItem; removing: boolean; onClick: () => void; onRemove: () => void }) {
  const dish = item.dish
  const difficulty = dish.difficulty === "easy" ? "简单" : dish.difficulty === "medium" ? "中等" : "困难"
  return <article className="collection-row">
    <button className="collection-dish-link" onClick={onClick}>
      <span className="collection-polaroid"><DishImage dish={dish} className="collection-photo" emojiSize="text-[28px]" /></span>
      <span className="collection-dish-copy">
        <strong>{dish.name}</strong>
        <span className="collection-meta">{dish.category || "其他"}{dish.cook_time > 0 && <> · {dish.cook_time} 分钟</>} · 火候{difficulty}</span>
        <span className="collection-taste">{[dish.taste, ...(dish.tags || []).slice(0, 1)].filter(Boolean).join(" · ")}</span>
        <span className="collection-last-eaten">{item.last_eaten_at ? "上次吃 " + formatDate(item.last_eaten_at) : "收藏于 " + formatDate(item.favorite_created_at)}{item.record_count > 0 && " · 做过 " + item.record_count + " 次"}</span>
      </span>
    </button>
    <button className="collection-heart" disabled={removing} aria-label={"取消收藏" + dish.name} onClick={onRemove}><Heart size={19} fill="currentColor" strokeWidth={1.6} /></button>
  </article>
}

function FavoritesSkeleton() {
  return <div role="status" aria-label="正在读取收藏" className="collection-skeleton">
    <div className="skeleton h-28 w-full rounded-md" />
    <div className="skeleton h-16 w-full rounded-md" />
    {[0, 1, 2].map((index) => <div key={index} className="skeleton h-24 w-full rounded-md" />)}
  </div>
}
