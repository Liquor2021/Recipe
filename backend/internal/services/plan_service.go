package services

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type WeekDayPlan struct {
	Date    string        `json:"date"`
	DayName string        `json:"day_name"`
	Lunch   []models.Dish `json:"lunch"`
	Dinner  []models.Dish `json:"dinner"`
}

type WeekPlan struct {
	Days []WeekDayPlan `json:"days"`
}

// weekPlanRecord 周菜单缓存（内存与 settings.week_plan_cache 共用）。
// 只存菜品 ID：读取时按 ID 回库取最新菜品，菜被改名/换图能及时反映，被删/停用/
// 命中 strict 忌口则整份重新生成。（旧缓存存的是完整菜品对象，而 Dish 只有
// MarshalJSON 没有对应的 UnmarshalJSON，数组字段反序列化必失败——旧缓存从来没被
// 读回过，每次重启都会重排一周菜单。只取 id 的结构同时兼容新旧两种格式。）
type weekPlanRecord struct {
	Days []weekPlanRecordDay `json:"days"`
	// LunchCount/DinnerCount 生成时的每餐道数；旧格式缓存没有（为 0）则不校验
	LunchCount  int `json:"lunch_count,omitempty"`
	DinnerCount int `json:"dinner_count,omitempty"`
}

type weekPlanRecordDay struct {
	Date    string        `json:"date"`
	DayName string        `json:"day_name"`
	Lunch   []weekPlanRef `json:"lunch"`
	Dinner  []weekPlanRef `json:"dinner"`
}

// weekPlanRef 只解出菜品 id；旧格式里的完整菜品对象其余字段直接忽略
type weekPlanRef struct {
	ID uint `json:"id"`
}

// weekPlanConfig 生成/校验周菜单所依据的设置快照（一次读取，生成与校验口径一致）
type weekPlanConfig struct {
	lunchCount  int
	dinnerCount int
	dislikes    familyDislikeConfig
}

func loadWeekPlanConfig() weekPlanConfig {
	return weekPlanConfig{
		lunchCount:  getSettingInt("lunch_dishes_per_day", 1),
		dinnerCount: getSettingInt("dinner_dishes_per_day", 1),
		dislikes:    loadFamilyDislikeConfig(),
	}
}

var (
	// weekPlanMu 串行化周菜单的"校验缓存 → 必要时重新生成 → 保存"，
	// 避免并发请求各自生成出两份不同的菜单
	weekPlanMu   sync.Mutex
	cachedRecord *weekPlanRecord
)

func getCurrentWeekKey() string {
	now := time.Now()
	weekday := int(now.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	monday := now.AddDate(0, 0, 1-weekday)
	return monday.Format("2006-01-02")
}

func getSettingInt(key string, defaultVal int) int {
	var setting models.Setting
	if err := database.DB.Where("`key` = ?", key).First(&setting).Error; err == nil {
		if n, err := strconv.Atoi(setting.Value); err == nil && n > 0 {
			return n
		}
	}
	return defaultVal
}

// GetCachedWeekPlan 本周菜单：缓存仍有效则返回（菜品信息为最新），否则按当前设置重新生成。
// 缓存失效条件：不是本周的、每餐道数设置变了、有菜被删/停用、strict 模式下有菜命中忌口。
// 失效的缓存绝不作为兜底返回——那正是"改了忌口还看到忌口菜"的来源。
func GetCachedWeekPlan() *WeekPlan {
	weekPlanMu.Lock()
	defer weekPlanMu.Unlock()

	cfg := loadWeekPlanConfig()
	if cachedRecord == nil {
		cachedRecord = loadWeekPlanRecord()
	}
	if plan, ok := rehydrateWeekPlan(cachedRecord, getCurrentWeekKey(), cfg); ok {
		return plan
	}

	plan := generateWeekPlan(cfg)
	if len(plan.Days) > 0 {
		saveWeekPlanRecord(plan, cfg)
	}
	// 生成为空（如 strict 忌口过滤掉了全部菜）就如实返回空，不缓存，下次请求重新判断
	return plan
}

// RegenerateWeekPlan 手动重新生成本周菜单；生成为空时保留仍然有效的旧菜单
func RegenerateWeekPlan() *WeekPlan {
	weekPlanMu.Lock()
	defer weekPlanMu.Unlock()

	cfg := loadWeekPlanConfig()
	plan := generateWeekPlan(cfg)
	if len(plan.Days) > 0 {
		saveWeekPlanRecord(plan, cfg)
		return plan
	}
	if cachedRecord == nil {
		cachedRecord = loadWeekPlanRecord()
	}
	if stale, ok := rehydrateWeekPlan(cachedRecord, getCurrentWeekKey(), cfg); ok {
		return stale
	}
	return plan
}

// loadWeekPlanRecord 从 settings 读周菜单缓存；不存在或无法解析返回 nil
func loadWeekPlanRecord() *weekPlanRecord {
	var setting models.Setting
	if err := database.DB.Where("`key` = ?", "week_plan_cache").First(&setting).Error; err != nil || setting.Value == "" {
		return nil
	}
	var rec weekPlanRecord
	if err := json.Unmarshal([]byte(setting.Value), &rec); err != nil || len(rec.Days) == 0 {
		return nil
	}
	return &rec
}

// rehydrateWeekPlan 校验缓存并按 ID 回库组装出带最新菜品信息的周菜单；
// 缓存缺失、不是本周、每餐道数不符、有菜不可用或命中 strict 忌口时返回 ok=false
func rehydrateWeekPlan(rec *weekPlanRecord, weekKey string, cfg weekPlanConfig) (*WeekPlan, bool) {
	if rec == nil || len(rec.Days) == 0 || rec.Days[0].Date != weekKey {
		return nil, false
	}
	if rec.LunchCount > 0 {
		if rec.LunchCount != cfg.lunchCount || rec.DinnerCount != cfg.dinnerCount {
			return nil, false
		}
	} else {
		// 旧格式缓存没记生成时的道数：按每天实际道数与当前设置比对（不一致就重排一次，之后存成新格式）
		for _, day := range rec.Days {
			if len(day.Lunch) != cfg.lunchCount || len(day.Dinner) != cfg.dinnerCount {
				return nil, false
			}
		}
	}

	idSet := make(map[uint]bool)
	for _, day := range rec.Days {
		for _, ref := range day.Lunch {
			idSet[ref.ID] = true
		}
		for _, ref := range day.Dinner {
			idSet[ref.ID] = true
		}
	}
	ids := make([]uint, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	var dishes []models.Dish
	if len(ids) > 0 {
		if err := database.DB.Where("id IN ? AND enabled = ?", ids, true).Find(&dishes).Error; err != nil {
			return nil, false
		}
	}
	byID := make(map[uint]models.Dish, len(dishes))
	for _, d := range dishes {
		if cfg.dislikes.strict && dishHitsDislikes(d, cfg.dislikes.tokens) {
			continue
		}
		byID[d.ID] = d
	}

	resolve := func(refs []weekPlanRef) ([]models.Dish, bool) {
		out := make([]models.Dish, 0, len(refs))
		for _, ref := range refs {
			d, ok := byID[ref.ID]
			if !ok {
				return nil, false
			}
			out = append(out, d)
		}
		return out, true
	}
	plan := &WeekPlan{Days: make([]WeekDayPlan, 0, len(rec.Days))}
	for _, day := range rec.Days {
		lunch, ok := resolve(day.Lunch)
		if !ok {
			return nil, false
		}
		dinner, ok := resolve(day.Dinner)
		if !ok {
			return nil, false
		}
		plan.Days = append(plan.Days, WeekDayPlan{Date: day.Date, DayName: day.DayName, Lunch: lunch, Dinner: dinner})
	}
	return plan, true
}

// saveWeekPlanRecord 把周菜单（只存菜品 ID）写入内存与 settings；调用方需持有 weekPlanMu
func saveWeekPlanRecord(plan *WeekPlan, cfg weekPlanConfig) {
	refs := func(dishes []models.Dish) []weekPlanRef {
		out := make([]weekPlanRef, 0, len(dishes))
		for _, d := range dishes {
			out = append(out, weekPlanRef{ID: d.ID})
		}
		return out
	}
	rec := &weekPlanRecord{LunchCount: cfg.lunchCount, DinnerCount: cfg.dinnerCount}
	for _, day := range plan.Days {
		rec.Days = append(rec.Days, weekPlanRecordDay{Date: day.Date, DayName: day.DayName, Lunch: refs(day.Lunch), Dinner: refs(day.Dinner)})
	}
	cachedRecord = rec

	data, err := json.Marshal(rec)
	if err != nil {
		return
	}
	if err := database.DB.Where("`key` = ?", "week_plan_cache").
		Assign(models.Setting{Key: "week_plan_cache", Value: string(data)}).
		FirstOrCreate(&models.Setting{}).Error; err != nil {
		// 落库失败只影响重启后的复用，内存缓存仍有效
		fmt.Printf("[week-plan] 保存周菜单缓存失败: %v\n", err)
	}
}

// GenerateWeekPlan 按当前设置生成一份新的本周菜单（不读写缓存）
func GenerateWeekPlan() *WeekPlan {
	return generateWeekPlan(loadWeekPlanConfig())
}

func generateWeekPlan(cfg weekPlanConfig) *WeekPlan {
	var dishes []models.Dish
	if err := database.DB.Where("enabled = ?", true).Find(&dishes).Error; err != nil {
		return &WeekPlan{}
	}
	// strict 忌口：命中的菜整体出局（与日推荐口径一致），全被过滤时宁可返回空菜单
	dishes = applyDislikeMode(dishes, cfg.dislikes)
	if len(dishes) == 0 {
		return &WeekPlan{}
	}

	lunchCount := cfg.lunchCount
	dinnerCount := cfg.dinnerCount

	var lunchPool, dinnerPool []models.Dish
	for _, d := range dishes {
		tags := parseTags(d.Tags)
		mt := d.MealType
		if mt == "all" || mt == "lunch" || containsTag(tags, "午餐") || containsTag(tags, "lunch") {
			lunchPool = append(lunchPool, d)
		}
		if mt == "all" || mt == "dinner" || containsTag(tags, "晚餐") || containsTag(tags, "dinner") {
			dinnerPool = append(dinnerPool, d)
		}
	}
	if len(lunchPool) == 0 {
		lunchPool = dishes
	}
	if len(dinnerPool) == 0 {
		dinnerPool = dishes
	}

	dayNames := []string{"周一", "周二", "周三", "周四", "周五", "周六", "周日"}
	now := time.Now()
	weekday := int(now.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	monday := now.AddDate(0, 0, 1-weekday)

	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	var days []WeekDayPlan
	usedAllIDs := make(map[uint]bool)

	for i := 0; i < 7; i++ {
		date := monday.AddDate(0, 0, i)
		dayPlan := WeekDayPlan{
			Date:    date.Format("2006-01-02"),
			DayName: dayNames[i],
		}

		usedThisDay := make(map[uint]bool)

		dayPlan.Lunch = pickNDishes(lunchPool, lunchCount, usedAllIDs, usedThisDay, r)
		dayPlan.Dinner = pickNDishes(dinnerPool, dinnerCount, usedAllIDs, usedThisDay, r)

		days = append(days, dayPlan)
	}

	return &WeekPlan{Days: days}
}

func pickNDishes(pool []models.Dish, count int, globalUsed map[uint]bool, dayUsed map[uint]bool, r *rand.Rand) []models.Dish {
	available := filterAvailableBoth(pool, globalUsed, dayUsed)
	var picked []models.Dish

	for len(picked) < count && len(available) > 0 {
		idx := r.Intn(len(available))
		d := available[idx]
		picked = append(picked, d)
		globalUsed[d.ID] = true
		dayUsed[d.ID] = true
		available = filterAvailableBoth(pool, globalUsed, dayUsed)
	}

	if len(picked) < count {
		available2 := filterAvailable(pool, dayUsed)
		for len(picked) < count && len(available2) > 0 {
			idx := r.Intn(len(available2))
			d := available2[idx]
			picked = append(picked, d)
			dayUsed[d.ID] = true
			available2 = filterAvailable(pool, dayUsed)
		}
	}

	return picked
}

func filterAvailableBoth(dishes []models.Dish, globalUsed map[uint]bool, dayUsed map[uint]bool) []models.Dish {
	var result []models.Dish
	for _, d := range dishes {
		if !globalUsed[d.ID] && !dayUsed[d.ID] {
			result = append(result, d)
		}
	}
	if len(result) == 0 {
		for _, d := range dishes {
			if !dayUsed[d.ID] {
				result = append(result, d)
			}
		}
	}
	return result
}

func filterAvailable(dishes []models.Dish, used map[uint]bool) []models.Dish {
	var result []models.Dish
	for _, d := range dishes {
		if !used[d.ID] {
			result = append(result, d)
		}
	}
	return result
}

func parseTags(tagsStr string) []string {
	var tags []string
	json.Unmarshal([]byte(tagsStr), &tags)
	return tags
}

func containsTag(tags []string, target string) bool {
	for _, t := range tags {
		if strings.EqualFold(t, target) {
			return true
		}
	}
	return false
}

type ShoppingCategory struct {
	Category string         `json:"category"`
	Items    []ShoppingItem `json:"items"`
}

type ShoppingItem struct {
	Name    string `json:"name"`
	Amount  string `json:"amount"`
	Checked bool   `json:"checked"`
	InStock bool   `json:"in_stock"`
	// StockBatches 冰箱里该食材的未过期批次数（取消"家中有"会把它们一起移出，前端据此确认）
	StockBatches int `json:"stock_batches"`
}

type ShoppingCategoryOverride struct {
	ItemName string `json:"item_name"`
	Category string `json:"category"`
}

var shoppingCategoryOrder = map[string]int{
	"蔬菜": 0,
	"肉类": 1,
	"配料": 2,
	"其他": 3,
}

var shoppingCategoryExactTerms = map[string][]string{
	"蔬菜": {
		"番茄", "西红柿", "圣女果", "小番茄",
		"西兰花", "花菜", "菜花", "包菜", "卷心菜", "娃娃菜",
		"白菜", "大白菜", "小白菜", "青菜", "油菜", "油麦菜", "生菜",
		"菠菜", "空心菜", "苋菜", "茼蒿", "芹菜", "香菜", "韭菜",
		"葱", "小葱", "大葱", "葱花", "姜", "姜片", "姜丝",
		"蒜", "大蒜", "蒜瓣", "蒜末", "蒜苗", "蒜苔", "洋葱",
		"土豆", "马铃薯", "红薯", "地瓜", "山药", "芋头", "莲藕",
		"萝卜", "白萝卜", "胡萝卜", "莴笋", "竹笋", "冬笋", "春笋",
		"黄瓜", "丝瓜", "冬瓜", "南瓜", "苦瓜", "西葫芦", "茄子",
		"青椒", "红椒", "彩椒", "甜椒", "尖椒", "线椒", "小米辣",
		"蘑菇", "香菇", "平菇", "金针菇", "杏鲍菇", "口蘑", "蟹味菇",
		"木耳", "银耳", "海带", "紫菜", "裙带菜",
		"豆腐", "嫩豆腐", "老豆腐", "内酯豆腐", "油豆腐", "豆皮", "千张",
		"腐竹", "豆芽", "黄豆芽", "绿豆芽", "毛豆", "豌豆", "荷兰豆",
		"四季豆", "豆角", "豇豆", "玉米",
	},
	"肉类": {
		"猪肉", "猪肉末", "肉末", "肉丝", "肉片", "五花肉", "里脊肉",
		"排骨", "猪蹄", "猪肝", "猪肚", "腊肉", "火腿", "香肠", "午餐肉",
		"牛肉", "牛腩", "牛排", "肥牛", "牛肉丸",
		"羊肉", "羊排", "鸡肉", "鸡腿", "鸡翅", "鸡胸肉", "鸡爪",
		"鸭肉", "鸭腿", "鸭血", "鹅肉",
		"鸡蛋", "蛋液", "蛋清", "蛋白", "蛋黄", "鸭蛋", "鹌鹑蛋", "皮蛋", "咸鸭蛋",
		"鱼", "鱼片", "鲈鱼", "鲫鱼", "草鱼", "带鱼", "三文鱼", "鳕鱼",
		"虾", "虾仁", "基围虾", "明虾", "虾滑", "蟹", "螃蟹", "蟹棒",
		"蛤蜊", "花甲", "扇贝", "干贝", "鱿鱼", "墨鱼", "章鱼",
	},
	"配料": {
		"盐", "食盐", "糖", "白糖", "冰糖", "红糖", "蜂蜜",
		"生抽", "老抽", "酱油", "蚝油", "醋", "陈醋", "白醋", "米醋",
		"料酒", "黄酒", "白酒", "啤酒", "味淋",
		"油", "食用油", "花生油", "玉米油", "菜籽油", "橄榄油", "香油", "麻油", "辣椒油",
		"豆瓣酱", "郫县豆瓣酱", "黄豆酱", "甜面酱", "番茄酱", "沙茶酱", "芝麻酱",
		"辣椒酱", "蒜蓉辣酱", "剁椒酱", "老干妈", "火锅底料",
		"淀粉", "玉米淀粉", "土豆淀粉", "红薯淀粉", "生粉",
		"花椒", "花椒粉", "胡椒", "胡椒粉", "白胡椒粉", "黑胡椒", "黑胡椒粉",
		"辣椒粉", "五香粉", "孜然", "孜然粉", "椒盐", "十三香", "咖喱", "咖喱块", "咖喱粉",
		"八角", "桂皮", "香叶", "小茴香", "草果", "丁香", "豆蔻", "陈皮",
		"鸡精", "味精", "鸡粉", "高汤", "浓汤宝",
		"白芝麻", "黑芝麻", "芝麻", "豆豉", "腐乳", "虾皮", "海米", "鱼露", "蛋黄酱",
	},
	"其他": {
		"大米", "米", "糯米", "小米", "黑米", "燕麦", "面粉", "低筋面粉", "高筋面粉", "糯米粉",
		"面条", "挂面", "意面", "鸡蛋面", "方便面", "泡面", "粉丝", "粉条", "米粉", "河粉", "宽粉", "红薯粉", "土豆粉",
		"年糕", "馒头", "面包", "吐司", "饺子皮", "馄饨皮",
		"牛奶", "淡奶油", "黄油", "芝士", "奶酪", "可乐", "雪碧",
		"花生", "花生米", "腰果", "核桃", "杏仁", "葡萄干",
	},
}

var shoppingCategoryExact = buildShoppingCategoryExact(shoppingCategoryExactTerms)

func buildShoppingCategoryExact(terms map[string][]string) map[string]string {
	result := make(map[string]string)
	for category, names := range terms {
		if !isValidShoppingCategory(category) {
			continue
		}
		for _, name := range names {
			name = strings.TrimSpace(name)
			if name != "" {
				result[name] = category
			}
		}
	}
	return result
}

var amountPattern = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)(.*)$`)

type numericAmountAccum struct {
	total float64
}

func compactShoppingAmounts(amounts []string) string {
	numericByUnit := make(map[string]*numericAmountAccum)
	textSeen := make(map[string]bool)

	for _, amount := range amounts {
		for _, part := range strings.Split(strings.ReplaceAll(amount, "＋", "+"), "+") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}

			if m := amountPattern.FindStringSubmatch(part); m != nil {
				num, err := strconv.ParseFloat(m[1], 64)
				if err == nil {
					unit := strings.TrimSpace(m[2])
					acc, exists := numericByUnit[unit]
					if !exists {
						acc = &numericAmountAccum{}
						numericByUnit[unit] = acc
					}
					acc.total += num
					continue
				}
			}

			if !textSeen[part] {
				textSeen[part] = true
			}
		}
	}

	if len(numericByUnit) == 0 && len(textSeen) == 0 {
		return "适量"
	}

	parts := make([]string, 0, len(textSeen)+len(numericByUnit))
	texts := make([]string, 0, len(textSeen))
	for text := range textSeen {
		texts = append(texts, text)
	}
	sort.Strings(texts)
	parts = append(parts, texts...)

	units := make([]string, 0, len(numericByUnit))
	for unit := range numericByUnit {
		units = append(units, unit)
	}
	sort.Strings(units)
	for _, unit := range units {
		parts = append(parts, formatAmountNumber(numericByUnit[unit].total)+unit)
	}

	if len(parts) == 0 {
		return "适量"
	}
	return strings.Join(parts, "+")
}

func formatAmountNumber(n float64) string {
	rounded := math.Round(n)
	if math.Abs(n-rounded) < 1e-9 {
		return strconv.FormatInt(int64(rounded), 10)
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func sortShoppingItems(items []ShoppingItem) {
	sort.Slice(items, func(i, j int) bool {
		if shoppingItemPriority(items[i]) != shoppingItemPriority(items[j]) {
			return shoppingItemPriority(items[i]) < shoppingItemPriority(items[j])
		}
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		if items[i].Amount != items[j].Amount {
			return items[i].Amount < items[j].Amount
		}
		return false
	})
}

func shoppingItemPriority(item ShoppingItem) int {
	switch {
	case item.InStock:
		return 2
	case item.Checked:
		return 1
	default:
		return 0
	}
}

// addItemsMu 串行化"先查已有再插入"：双击补料或多端同时补料时不会写出重复条目
// （单进程 SQLite 应用，进程内互斥即可覆盖全部写入方）
var addItemsMu sync.Mutex

// AddShoppingListItems 手动往买菜清单补料（如清冰箱推荐里缺的食材）。
// mealDate 为空默认今天；同日已有同一食材（含真别名，番茄=西红柿）的条目则跳过；
// 未带用量且给了 dishID 时，按该菜菜谱补上用量。返回实际新增条数；
// 数据库读写失败返回 error，调用方不能把失败当成"清单里已经有了"。
// mealType 用 "extra" 与菜品联动条目隔离，避免删菜时被误清。
func AddShoppingListItems(items []ShoppingItem, dishID uint, dishName string, mealDate string) (int, error) {
	if mealDate == "" {
		mealDate = time.Now().Format("2006-01-02")
	}

	addItemsMu.Lock()
	defer addItemsMu.Unlock()

	var existing []string
	if err := database.DB.Model(&models.ShoppingCheck{}).
		Where("meal_date = ?", mealDate).
		Pluck("item_name", &existing).Error; err != nil {
		return 0, err
	}
	exists := make(map[string]bool, len(existing)+len(items))
	for _, name := range existing {
		exists[ingredients.Normalize(name)] = true
	}

	recipeAmounts := dishRecipeAmounts(dishID)
	rows := make([]models.ShoppingCheck, 0, len(items))
	for _, item := range items {
		name := strings.TrimSpace(item.Name)
		key := ingredients.Normalize(name)
		if name == "" || exists[key] {
			continue
		}
		exists[key] = true
		amount := strings.TrimSpace(item.Amount)
		if amount == "" {
			amount = recipeAmounts[key]
		}
		rows = append(rows, models.ShoppingCheck{
			MealDate:   mealDate,
			MealType:   "extra",
			DishID:     dishID,
			DishName:   dishName,
			ItemName:   name,
			ItemAmount: amount,
		})
	}
	if len(rows) == 0 {
		return 0, nil
	}
	if err := database.DB.Create(&rows).Error; err != nil {
		return 0, err
	}
	return len(rows), nil
}

// dishRecipeAmounts 菜谱里食材与调料的用量（按真别名归一后的名字索引）；菜不存在返回空表
func dishRecipeAmounts(dishID uint) map[string]string {
	amounts := make(map[string]string)
	if dishID == 0 {
		return amounts
	}
	var dish models.Dish
	if err := database.DB.First(&dish, dishID).Error; err != nil {
		return amounts
	}
	for _, list := range []string{dish.Ingredients, dish.Seasonings} {
		for _, ing := range ParseIngredientList(list) {
			key := ingredients.Normalize(ing.Name)
			if _, ok := amounts[key]; !ok && ing.Amount != "" {
				amounts[key] = ing.Amount
			}
		}
	}
	return amounts
}

// BuildShoppingList 指定日期的买菜清单（同名合并用量、按分类分组）；读库失败返回 error
func BuildShoppingList(dates []string) ([]ShoppingCategory, error) {
	if len(dates) == 0 {
		return []ShoppingCategory{}, nil
	}

	var checks []models.ShoppingCheck
	if err := database.DB.Where("meal_date IN ?", dates).Find(&checks).Error; err != nil {
		return nil, err
	}
	if len(checks) == 0 {
		return []ShoppingCategory{}, nil
	}

	// 补料条目（extra）是"这道菜还缺什么"的提前登记：之后真的记录了这道菜，
	// 菜品联动会按菜谱再写一条同名条目，两条说的是同一份需求，用量只算一次（勾选状态照常合并）
	type linkKey struct {
		date   string
		dishID uint
		item   string
	}
	linked := make(map[linkKey]bool)
	for _, ch := range checks {
		if ch.MealType != "extra" {
			linked[linkKey{ch.MealDate, ch.DishID, ch.ItemName}] = true
		}
	}

	type nameAccum struct {
		amounts []string
		checked bool
	}
	merged := make(map[string]*nameAccum)
	for _, ch := range checks {
		entry, exists := merged[ch.ItemName]
		if !exists {
			entry = &nameAccum{}
			merged[ch.ItemName] = entry
		}
		superseded := ch.MealType == "extra" && linked[linkKey{ch.MealDate, ch.DishID, ch.ItemName}]
		if ch.ItemAmount != "" && !superseded {
			entry.amounts = append(entry.amounts, ch.ItemAmount)
		}
		if ch.Checked {
			entry.checked = true
		}
	}

	// "家中有"只看未过期批次，并按真别名匹配（清单写西红柿、冰箱记番茄也算有）
	stockCounts, err := availableBatchCounts()
	if err != nil {
		return nil, err
	}

	categoryByName := getShoppingCategoryOverrideMap()

	grouped := map[string][]ShoppingItem{
		"蔬菜": {},
		"肉类": {},
		"配料": {},
		"其他": {},
	}
	for name, entry := range merged {
		amountStr := compactShoppingAmounts(entry.amounts)
		stock := stockCounts[ingredients.Normalize(name)]
		item := ShoppingItem{Name: name, Amount: amountStr, Checked: entry.checked, InStock: stock > 0, StockBatches: stock}
		category := classifyShoppingItem(name, categoryByName)
		if _, ok := grouped[category]; !ok {
			category = "其他"
		}
		grouped[category] = append(grouped[category], item)
	}

	var result []ShoppingCategory
	categoryNames := []string{"蔬菜", "肉类", "配料", "其他"}
	for _, category := range categoryNames {
		items := grouped[category]
		if len(items) == 0 {
			continue
		}
		sortShoppingItems(items)
		result = append(result, ShoppingCategory{Category: category, Items: items})
	}

	return result, nil
}

func classifyShoppingItem(name string, overrides map[string]string) string {
	if category := overrides[name]; isValidShoppingCategory(category) {
		return category
	}

	normalized := strings.TrimSpace(name)
	if normalized == "" {
		return "其他"
	}

	if category := shoppingCategoryExact[normalized]; isValidShoppingCategory(category) {
		return category
	}

	seasoningKw := []string{
		"盐", "糖", "酱", "油", "醋", "料酒", "生抽", "老抽", "蚝油", "淀粉", "生粉", "粉",
		"八角", "花椒", "胡椒", "孜然", "香叶", "桂皮", "辣椒粉", "豆瓣", "冰糖", "鸡精", "味精",
		"十三香", "五香", "椒盐", "香油", "麻油", "咖喱", "芡", "汁", "底料", "腐乳", "豆豉", "芝麻",
	}
	meatKw := []string{
		"肉", "排骨", "牛腩", "五花", "里脊", "肥牛", "猪蹄", "猪肝", "猪肚", "火腿", "香肠", "午餐肉",
		"鸡腿", "鸡翅", "鸡胸", "鸡爪", "鸭腿", "鸭血", "羊排", "牛排", "鱼片", "虾仁", "虾滑", "蟹",
		"蛤蜊", "花甲", "扇贝", "鱿鱼", "墨鱼", "章鱼",
	}
	vegetableKw := []string{
		"菜", "瓜", "豆", "葱", "姜", "蒜", "椒", "萝卜", "笋", "菇", "木耳", "银耳", "藕", "番茄",
		"西红柿", "西兰花", "土豆", "洋葱", "茄子", "芹菜", "香菜", "韭菜", "菠菜", "紫菜", "海带",
		"豆腐", "豆皮", "豆芽", "冬瓜", "南瓜", "山药", "芋头", "莲藕", "玉米", "菌", "蘑",
	}
	otherKw := []string{
		"米", "面", "粉丝", "粉条", "米粉", "河粉", "宽粉", "年糕", "馒头", "面包", "吐司", "饺子皮",
		"馄饨皮", "牛奶", "奶油", "黄油", "芝士", "奶酪", "可乐", "雪碧", "花生", "腰果", "核桃", "杏仁",
	}

	if hasKeyword(normalized, seasoningKw) {
		return "配料"
	}
	if hasKeyword(normalized, meatKw) {
		return "肉类"
	}
	if hasKeyword(normalized, vegetableKw) {
		return "蔬菜"
	}
	if hasKeyword(normalized, otherKw) {
		return "其他"
	}
	return "其他"
}

func getShoppingCategoryOverrideMap() map[string]string {
	var overrides []models.ShoppingItemCategory
	database.DB.Order("item_name ASC").Find(&overrides)

	result := make(map[string]string, len(overrides))
	for _, override := range overrides {
		if isValidShoppingCategory(override.Category) {
			result[override.ItemName] = override.Category
		}
	}
	return result
}

func isValidShoppingCategory(category string) bool {
	_, ok := shoppingCategoryOrder[category]
	return ok
}

func ListShoppingCategoryOverrides() []ShoppingCategoryOverride {
	var rows []models.ShoppingItemCategory
	database.DB.Order("category ASC, item_name ASC").Find(&rows)

	overrides := make([]ShoppingCategoryOverride, 0, len(rows))
	for _, row := range rows {
		if !isValidShoppingCategory(row.Category) {
			continue
		}
		overrides = append(overrides, ShoppingCategoryOverride{
			ItemName: row.ItemName,
			Category: row.Category,
		})
	}

	sort.SliceStable(overrides, func(i, j int) bool {
		if shoppingCategoryOrder[overrides[i].Category] != shoppingCategoryOrder[overrides[j].Category] {
			return shoppingCategoryOrder[overrides[i].Category] < shoppingCategoryOrder[overrides[j].Category]
		}
		return overrides[i].ItemName < overrides[j].ItemName
	})
	return overrides
}

// UpsertShoppingCategoryOverride 设置食材的买菜清单分类；参数无效返回 ok=false
func UpsertShoppingCategoryOverride(itemName, category string) (bool, error) {
	itemName = strings.TrimSpace(itemName)
	category = strings.TrimSpace(category)
	if itemName == "" || !isValidShoppingCategory(category) {
		return false, nil
	}

	err := database.DB.Where("item_name = ?", itemName).
		Assign(models.ShoppingItemCategory{Category: category}).
		FirstOrCreate(&models.ShoppingItemCategory{ItemName: itemName}).Error
	return true, err
}

func DeleteShoppingCategoryOverride(itemName string) error {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return nil
	}
	return database.DB.Where("item_name = ?", itemName).Delete(&models.ShoppingItemCategory{}).Error
}

// ToggleShoppingCheck 勾选/取消某食材"已买"：只改买菜清单展示范围（今天+明天）内的条目，
// 不能把历史日期和更远日期里同名的条目一起改掉（会污染"已买"统计与之后的清单）
func ToggleShoppingCheck(itemName string, checked bool) error {
	now := time.Now()
	dates := []string{now.Format("2006-01-02"), now.AddDate(0, 0, 1).Format("2006-01-02")}
	return database.DB.Model(&models.ShoppingCheck{}).
		Where("item_name = ? AND meal_date IN ?", itemName, dates).
		Update("checked", checked).Error
}

// ToggleHomeInventory 买菜清单"家中有"开关：打开 = 冰箱新增一批；
// 关闭 = 移出该食材（含真别名）的全部未过期批次（前端已按 stock_batches 二次确认）
func ToggleHomeInventory(itemName string, inStock bool) error {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return ErrEmptyItemName
	}

	if !inStock {
		_, err := removeAvailableBatches(itemName)
		return err
	}

	// 复用冰箱添加逻辑：按食材字典自动设默认保质期，与冰箱页行为一致，
	// 从买菜清单点"家中有"的食材同样能产生临期提醒
	return CreateInventoryBatch(itemName, "", "")
}

func hasKeyword(s string, keywords []string) bool {
	for _, k := range keywords {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}
