export interface DishIngredient {
  name: string
  amount?: string
}

export interface DishStep {
  text: string
  time?: number
  image?: string
}

export interface Dish {
  id: number
  name: string
  image_url: string
  // 后端返回真正的 JSON 数组；历史数据可能是字符串数组或对象数组，统一用 asArray 消费
  images: string[]
  video_url: string
  category: string
  meal_type: string
  taste: string
  ingredients: Array<string | DishIngredient>
  seasonings: Array<string | DishIngredient>
  steps: Array<string | DishStep>
  cook_time: number
  difficulty: string
  remark: string
  favorite: boolean
  enabled: boolean
  tags: string[]
  sort_order: number
  created_at: string
  updated_at: string
}

// 创建/更新菜品的请求体：JSON 数组字段以字符串形式提交，与后端 CreateDishRequest 对应
export interface DishInput {
  name: string
  image_url?: string
  images?: string
  video_url?: string
  category?: string
  meal_type?: string
  taste?: string
  ingredients?: string
  seasonings?: string
  steps?: string
  cook_time?: number
  difficulty?: string
  remark?: string
  tags?: string
  sort_order?: number
}

export interface MealRecord {
  id: number
  dish_id: number
  dish_name: string
  dish_image_url: string
  dish_emoji: string
  meal_type: string
  meal_date: string
  rating: number
  remark: string
  mood: string
  photo: string
  created_at: string
}

export interface PickResult {
  dishes: Dish[]
  quote: string
}

export interface BlindBoxResult {
  hint: string
  dish: Dish
  quote: string
}

export interface PaginatedData<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export interface StatsData {
  total_records: number
  total_dishes: number
  lunch_count: number
  dinner_count: number
  top_dishes: { dish_name: string; count: number }[]
}

export interface DashboardData {
  total_dishes: number
  enabled_dishes: number
  disabled_dishes: number
  total_records: number
  today_records: number
  favorite_count: number
  category_counts: { category: string; count: number }[]
  top_dishes: { dish_id: number; dish_name: string; count: number }[]
  recent_records: { id: number; dish_id: number; dish_name: string; meal_type: string; meal_date: string; mood: string; rating: number }[]
  week_trend: { date: string; count: number }[]
  difficulty_counts: { difficulty: string; count: number }[]
}

export interface Achievement {
  id: number
  code: string
  name: string
  description: string
  icon: string
  condition: string
  is_unlocked: boolean
  unlocked_at: string | null
  created_at: string
}

export interface WeekDayPlan {
  date: string
  day_name: string
  lunch: Dish[]
  dinner: Dish[]
}

export interface WeekPlan {
  days: WeekDayPlan[]
}

export interface ShoppingCategory {
  category: string
  items: ShoppingItem[]
}

export interface ShoppingItem {
  name: string
  amount: string
  checked: boolean
  in_stock: boolean
  stock_batches: number // 冰箱里未过期的批次数；取消"家中有"会一并移出
  removable: boolean // 只来自补料，可以直接删掉
  stocked: boolean // 已买且已经放进冰箱
}

export interface ShoppingCategoryOverride {
  item_name: string
  category: string
}

export interface Holiday {
  id: number
  name: string
  date: string
  dish_ids: string
  greeting: string
  created_at: string
}

export interface Quote {
  id: number
  content: string
  scene: string
  enabled: boolean
  created_at: string
}

export interface DayRating {
  id: number
  meal_date: string
  home_mood: string
  mood: string
  remark: string
  photos: string
  created_at: string
  updated_at: string
}

export interface PhotoWallRecord {
  dish_id: number
  dish_name: string
  meal_type: string
  mood: string
  remark: string
}

export interface PhotoWallDay {
  meal_date: string
  photos: string[]
  home_mood: string
  day_mood: string
  day_remark: string
  records: PhotoWallRecord[]
  photo_count: number
}

export interface PhotoWall {
  days: PhotoWallDay[]
  total_days: number
  total_photos: number
}

export interface DishRecordWithDay {
  id: number
  meal_type: string
  meal_date: string
  rating: number
  remark: string
  mood: string
  photo: string
  home_mood: string
  day_mood: string
  day_remark: string
  photos: string[]
}

export interface CategoryCount {
  category: string
  count: number
}

export interface DishCategoryCounts {
  total: number
  categories: CategoryCount[]
}

export interface FavoriteOverviewItem {
  dish: Dish
  favorite_created_at: string
  record_count: number
  lunch_count: number
  dinner_count: number
  last_eaten_at: string
  avg_rating: number
  is_never_cooked: boolean
}

export interface FavoriteCategorySummary {
  category: string
  count: number
  avg_cook_time: number
  cooked_count: number
  never_cooked_count: number
  quick_dish_id: number
  quick_dish_name: string
}

export interface FavoriteOverviewStats {
  total: number
  category_total: number
  avg_cook_time: number
  cooked_count: number
  never_cooked_count: number
  quick_dish: Dish | null
  most_cooked_dish: Dish | null
}

export interface FavoriteOverview {
  items: FavoriteOverviewItem[]
  categories: FavoriteCategorySummary[]
  stats: FavoriteOverviewStats
  quick_picks: FavoriteOverviewItem[]
  most_cooked: FavoriteOverviewItem[]
  need_try: FavoriteOverviewItem[]
}

export interface DishRecordsStats {
  total_count: number
  lunch_count: number
  dinner_count: number
  yum_percent: number
  ok_percent: number
  no_percent: number
  avg_rating: number
  last_date: string
  avg_interval: number
}

export interface DishRecordsResponse {
  records: DishRecordWithDay[]
  stats: DishRecordsStats
}

export interface InventoryBatch {
  id: number
  item_name: string
  in_stock: boolean
  quantity: string
  expiry_date: string
  updated_at: string
}

export interface FridgeMatch {
  dish: Dish
  matched: string[] // 命中的菜谱食材名
  missing: string[]
  matched_count: number
  coverage: number
  using_urgent: string[]
  // 与 matched 一一对应：冰箱里实际对上的是什么（离线缓存的旧响应可能没有）
  have?: FridgeHave[]
}

export interface FridgeHave {
  stock: string // 冰箱里的名字（如"五花肉"）
  recipe: string // 对应菜谱里的哪样（如"瘦肉"）
  substitute: boolean // 不是同一种、只是同一大类（五花肉当瘦肉用）
}

// 扣库存匹配类型：exact=同名/别名，generic=一方是大类泛称（猪肉↔排骨），similar=同类不同部位（只供参考）
export type ConsumptionKind = "exact" | "generic" | "similar"

export interface ConsumptionBatch {
  batch_id: number
  stock_name: string
  quantity: string
  expiry_date: string
  days_left: number // 999 = 未设置保质期
  kind: ConsumptionKind
  remaining_hint: string // 按菜谱用量算出的剩余量建议，空 = 算不出（单位不同/会用完）
}

export interface ConsumptionSlot {
  requested_name: string
  amount: string
  batches: ConsumptionBatch[]
  suggested_batch_id: number // 0 = 不建议默认扣
}

export interface ConsumptionMatch {
  dish_id: number
  slots: ConsumptionSlot[]
}

export interface ReportShare {
  name: string
  count: number
}

export interface ReportTopDish {
  dish_id: number
  dish_name: string
  count: number
}

export interface DietReport {
  range: string
  start_date: string
  end_date: string
  cook_days: number
  prev_cook_days: number
  total_meals: number
  lunch_count: number
  dinner_count: number
  distinct_dishes: number
  repeat_rate: number
  new_dish_rate: number
  avg_rating: number
  top_dishes: ReportTopDish[]
  taste_shares: ReportShare[]
  category_shares: ReportShare[]
  mood_shares: ReportShare[]
}

export interface FamilyMember {
  name: string
  dislikes: string[]
}
