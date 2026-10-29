import { api, getUploadErrorMessage } from "./client"
import defaultClient from "./client"
import type { Dish, DishInput, PaginatedData, PickResult, BlindBoxResult, MealRecord, StatsData, DashboardData, Achievement, WeekPlan, ShoppingCategory, ShoppingCategoryOverride, Holiday, Quote, DayRating, PhotoWall, DishRecordsResponse, DishCategoryCounts, FavoriteOverview, InventoryBatch, FridgeMatch, ConsumptionMatch, DietReport } from "@/types"

export const dishesApi = {
  list: (params?: Record<string, string>) =>
    api<PaginatedData<Dish>>("GET", "/dishes", params),
  categoryCounts: () => api<DishCategoryCounts>("GET", "/dishes/category-counts"),
  get: (id: number) => api<Dish>("GET", `/dishes/${id}`),
  records: (id: number) => api<DishRecordsResponse>("GET", `/dishes/${id}/records`),
  create: (data: DishInput) => api<Dish>("POST", "/dishes", data),
  update: (id: number, data: DishInput) => api<Dish>("PUT", `/dishes/${id}`, data),
  delete: (id: number) => api<null>("DELETE", `/dishes/${id}`),
  toggle: (id: number) => api<Dish>("PUT", `/dishes/${id}/toggle`),
  clone: (id: number) => api<Dish>("POST", `/dishes/${id}/clone`),
  batchToggle: (ids: number[], enabled: boolean) => api<null>("POST", "/dishes/batch-toggle", { ids, enabled }),
  batchDelete: (ids: number[]) => api<null>("POST", "/dishes/batch-delete", { ids }),
  batchCategory: (ids: number[], category: string) => api<null>("POST", "/dishes/batch-category", { ids, category }),
}

export const pickApi = {
  lunch: (count?: number) => api<PickResult>("POST", `/pick/lunch${count ? `?count=${count}` : ""}`),
  dinner: (count?: number) => api<PickResult>("POST", `/pick/dinner${count ? `?count=${count}` : ""}`),
  mood: (mood: string) => api<PickResult>("POST", "/pick/mood", { mood }),
  tomorrow: (data: { meal_type: string; profile: string; count: number; exclude_ids?: number[] }) =>
    api<PickResult>("POST", "/pick/tomorrow", data),
  blindBox: () => api<BlindBoxResult>("POST", "/pick/blind-box"),
}

export const recordsApi = {
  list: (params?: Record<string, string>) =>
    api<PaginatedData<MealRecord>>("GET", "/records", params),
  create: (data: Partial<MealRecord>) => api<MealRecord>("POST", "/records", data),
  batchCreate: (data: Partial<MealRecord>[]) => api<{ created: MealRecord[] | null; skipped: number; failed: number; total: number }>("POST", "/records/batch", { records: data }),
  update: (id: number, data: Partial<MealRecord>) =>
    api<MealRecord>("PUT", `/records/${id}`, data),
  delete: (id: number) => api<null>("DELETE", `/records/${id}`),
}

export const favoritesApi = {
  list: () => api<Dish[]>("GET", "/favorites"),
  overview: () => api<FavoriteOverview>("GET", "/favorites/overview"),
  add: (dishId: number) => api<null>("POST", `/favorites/${dishId}`),
  remove: (dishId: number) => api<null>("DELETE", `/favorites/${dishId}`),
}

export { getUploadErrorMessage }

export const uploadApi = {
  image: (file: File) => {
    const formData = new FormData()
    formData.append("image", file)
    return defaultClient.post<{ code: number; message: string; data: { url: string; filename: string } }>("/upload/image", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    })
  },
}

export const statsApi = {
  get: () => api<StatsData>("GET", "/stats"),
}

export const authApi = {
  appLogin: (password: string) => api<{ verified: boolean }>("POST", "/app/login", { password }),
  login: (password: string) => api<{ token: string }>("POST", "/admin/login", { password }),
}

export const quotesApi = {
  list: () => api<Quote[]>("GET", "/quotes"),
  create: (data: { content: string; scene: string }) => api<Quote>("POST", "/quotes", data),
  update: (id: number, data: { content: string; scene: string }) => api<Quote>("PUT", `/quotes/${id}`, data),
  delete: (id: number) => api<null>("DELETE", `/quotes/${id}`),
}

export const achievementsApi = {
  list: async () => {
    const data = await api<Achievement[] | null>("GET", "/achievements")
    return Array.isArray(data) ? data : []
  },
  unlock: (id: number) => api<null>("POST", `/achievements/${id}/unlock`),
  toggle: (id: number) => api<null>("POST", `/achievements/${id}/toggle`),
  create: (data: Partial<Achievement>) => api<Achievement>("POST", "/achievements", data),
  update: (id: number, data: Partial<Achievement>) => api<Achievement>("PUT", `/achievements/${id}`, data),
  delete: (id: number) => api<null>("DELETE", `/achievements/${id}`),
}

export const weekPlanApi = {
  get: () => api<WeekPlan>("GET", "/week-plan"),
  regenerate: () => api<WeekPlan>("POST", "/week-plan/regenerate"),
  // 只换某天某餐的一道菜：返回换好的整份菜单和换上的菜
  swap: (data: { date: string; meal_type: "lunch" | "dinner"; dish_id: number }) =>
    api<{ plan: WeekPlan; dish: Dish }>("POST", "/week-plan/swap", data),
}

export const shoppingListApi = {
  get: () => api<ShoppingCategory[]>("GET", "/shopping-list"),
  toggle: (data: { item_name: string; meal_date: string; checked: boolean }) =>
    api<null>("POST", "/shopping-list/toggle", data),
  setInventory: (data: { item_name: string; in_stock: boolean }) =>
    api<null>("POST", "/shopping-list/inventory", data),
  // 未带 amount 时后端按 dish_id 的菜谱补上用量
  addItems: (p: { dish_id?: number; dish_name?: string; items: { name: string; amount?: string }[] }) =>
    api<{ added: number }>("POST", "/shopping-list/items", p),
  // 删掉补料条目（菜品联动的条目跟着用餐记录走，不受影响）
  removeItem: (itemName: string) =>
    api<{ removed: number }>("DELETE", `/shopping-list/items/${encodeURIComponent(itemName)}`),
  // 已买的放进冰箱：每样建一批，保质期按食材字典自动设置
  stockIn: (items: { item_name: string; quantity: string }[]) =>
    api<{ added: number }>("POST", "/shopping-list/stock-in", { items }),
}

export const shoppingCategoriesApi = {
  list: () => api<ShoppingCategoryOverride[]>("GET", "/shopping-categories"),
  save: (data: { item_name: string; category: string }) =>
    api<null>("POST", "/shopping-categories", data),
  delete: (itemName: string) =>
    api<null>("DELETE", `/shopping-categories/${encodeURIComponent(itemName)}`),
}

export const holidaysApi = {
  upcoming: () => api<Holiday[]>("GET", "/holidays/upcoming"),
}

export const dayRatingApi = {
  get: (date: string) => api<DayRating>("GET", `/day-rating?date=${date}`),
  list: (params: { date_from: string; date_to: string }) =>
    api<DayRating[]>("GET", "/day-ratings", params),
  updateHomeMood: (data: { meal_date: string; home_mood: string }) =>
    api<DayRating>("POST", "/day-rating/home-mood", data),
  create: (data: { meal_date: string; mood?: string; remark?: string; photos?: string }) =>
    api<DayRating>("POST", "/day-rating", data),
}

export const photoWallApi = {
  get: () => api<PhotoWall>("GET", "/photo-wall"),
}

export const settingsApi = {
  get: () => api<Record<string, unknown>>("GET", "/settings"),
  update: (settings: Record<string, string>) => api<null>("PUT", "/settings", { settings }),
}

export const dashboardApi = {
  get: () => api<DashboardData>("GET", "/admin/dashboard"),
}

export const securityApi = {
  // 仍是默认值的口令/密钥（环境变量名）
  status: () => api<{ insecure_defaults: string[] }>("GET", "/admin/security"),
}

export const backupApi = {
  list: () => api<{ keep: number; dir: string; files: { name: string; size: number; mod_time: string }[] }>("GET", "/admin/backups"),
  // 现做一份完整的数据库副本并下载（二进制，不走 JSON 封装）
  download: async () => {
    const res = await defaultClient.get<Blob>("/admin/backup/download", { responseType: "blob", timeout: 60000 })
    const url = URL.createObjectURL(res.data)
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, "0")
    const a = document.createElement("a")
    a.href = url
    a.download = `ninimenu-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}

export const fridgeApi = {
  list: () => api<InventoryBatch[]>("GET", "/fridge"),
  add: (item_name: string, quantity?: string, expiry_date?: string) =>
    api<null>("POST", "/fridge", { item_name, quantity: quantity || "", expiry_date: expiry_date || "" }),
  updateBatch: (id: number, quantity: string, expiry_date: string) =>
    api<null>("PUT", `/fridge/batch/${id}`, { quantity, expiry_date }),
  removeBatch: (id: number) => api<null>("DELETE", `/fridge/batch/${id}`),
  remove: (itemName: string) => api<null>("DELETE", `/fridge/${encodeURIComponent(itemName)}`),
  recipes: (limit = 12) => api<FridgeMatch[]>("GET", `/fridge/recipes?limit=${limit}`),
  consumption: (dishId: number) => api<ConsumptionMatch>("GET", `/fridge/consumption?dish_id=${dishId}`),
  // batchIds 整批移出；remaining 用了一部分的批次改成剩余数量（同一事务）
  consume: (batchIds: number[], remaining?: { batch_id: number; quantity: string }[]) =>
    api<{ removed: number; updated: number }>("POST", "/fridge/consume", { batch_ids: batchIds, remaining }),
  urgent: () => api<InventoryBatch[]>("GET", "/fridge/urgent"),
}

export const reportApi = {
  get: (range: "week" | "month") => api<DietReport>("GET", `/report?range=${range}`),
}
