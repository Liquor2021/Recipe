package services

import (
	"encoding/json"
	"math/rand"
	"ninimenu/internal/config"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
)

type TomorrowPickOptions struct {
	MealType   string
	Profile    string
	Count      int
	ExcludeIDs []uint
}

// getRepeatDays 优先读管理后台的 repeat_days 设置，读不到再回退环境变量。
func getRepeatDays() int {
	return getSettingInt("repeat_days", config.C.RepeatDays)
}

func PickDishes(mealType string, count int, excludeRecent bool) ([]models.Dish, error) {
	var dishes []models.Dish
	query := database.DB.Where("enabled = ?", true)

	if mealType != "" {
		query = query.Where("meal_type IN ?", []string{mealType, "all"})
	}

	query.Find(&dishes)

	// strict 模式：命中忌口的菜先整体出局，全部被过滤时宁可返回空。
	// 必须在"去掉最近吃过"之前做：否则最近没吃过的恰好全是忌口菜时，
	// 去重结果非空就不会退回全量，忌口过滤后直接变空（明明还有最近吃过的合规菜）。
	cfg := loadFamilyDislikeConfig()
	dishes = applyDislikeMode(dishes, cfg)
	if len(dishes) == 0 {
		return nil, nil
	}

	pool := dishes
	if excludeRecent {
		pool = filterRecent(dishes, getRepeatDays())
	}
	// 最近几天全吃过了：退回不去重的候选池
	if len(pool) == 0 {
		pool = dishes
	}
	dishes = pool

	weighted := buildWeightedIndices(dishes, cfg.tokens)
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	r.Shuffle(len(weighted), func(i, j int) {
		weighted[i], weighted[j] = weighted[j], weighted[i]
	})

	seen := make(map[int]bool)
	var result []models.Dish
	for _, idx := range weighted {
		if !seen[idx] {
			seen[idx] = true
			result = append(result, dishes[idx])
			if len(result) >= count {
				break
			}
		}
	}

	return result, nil
}

func PickTomorrowDishes(opts TomorrowPickOptions) ([]models.Dish, error) {
	count := opts.Count
	if count < 1 {
		count = 1
	}
	if count > 10 {
		count = 10
	}

	mealType := strings.TrimSpace(opts.MealType)
	if mealType != "lunch" && mealType != "dinner" {
		mealType = ""
	}

	profile := strings.TrimSpace(opts.Profile)
	if profile == "" {
		profile = "balanced"
	}

	var dishes []models.Dish
	query := database.DB.Where("enabled = ?", true)
	if mealType != "" {
		query = query.Where("meal_type IN ?", []string{mealType, "all", ""})
	}
	query.Find(&dishes)

	if len(dishes) == 0 {
		return nil, nil
	}

	// strict 模式：先整体剔除命中忌口的菜，下面所有 fallback 层都基于这个已过滤的池子，
	// 全部被过滤时宁可返回空
	cfg := loadFamilyDislikeConfig()
	dishes = applyDislikeMode(dishes, cfg)
	if len(dishes) == 0 {
		return nil, nil
	}

	excluded := make(map[uint]bool, len(opts.ExcludeIDs))
	for _, id := range opts.ExcludeIDs {
		if id > 0 {
			excluded[id] = true
		}
	}

	recent := recentDishIDMap(getRepeatDays())
	pool := filterTomorrowPool(dishes, profile, excluded, recent, true)
	if len(pool) == 0 {
		pool = filterTomorrowPool(dishes, profile, excluded, recent, false)
	}
	if len(pool) == 0 {
		pool = filterTomorrowPool(dishes, "balanced", excluded, recent, false)
	}
	if len(pool) == 0 {
		pool = filterTomorrowPool(dishes, "balanced", map[uint]bool{}, recent, false)
	}

	sortTomorrowPool(pool, profile, cfg.tokens)
	if len(pool) > count {
		pool = pool[:count]
	}
	return pool, nil
}

func filterTomorrowPool(dishes []models.Dish, profile string, excluded map[uint]bool, recent map[uint]bool, strictProfile bool) []models.Dish {
	var result []models.Dish
	for _, d := range dishes {
		if excluded[d.ID] {
			continue
		}
		if recent[d.ID] {
			continue
		}
		if strictProfile && !matchesTomorrowProfile(d, profile) {
			continue
		}
		result = append(result, d)
	}
	if len(result) > 0 {
		return result
	}

	for _, d := range dishes {
		if excluded[d.ID] {
			continue
		}
		if strictProfile && !matchesTomorrowProfile(d, profile) {
			continue
		}
		result = append(result, d)
	}
	return result
}

func matchesTomorrowProfile(d models.Dish, profile string) bool {
	switch profile {
	case "quick":
		return d.Difficulty == "easy" || d.CookTime > 0 && d.CookTime <= 25 || strings.Contains(d.Category, "快手")
	case "light":
		return containsTaste(d.Taste, "清淡") || containsTaste(d.Taste, "鲜") || strings.Contains(d.Category, "汤")
	case "spicy":
		return containsTaste(d.Taste, "辣") || strings.Contains(d.Category, "川菜") || strings.Contains(d.Category, "湘菜") || strings.Contains(d.Category, "贵州菜") || strings.Contains(d.Name, "辣")
	case "favorite":
		return d.Favorite
	default:
		return true
	}
}

func sortTomorrowPool(dishes []models.Dish, profile string, dislikes map[string]bool) {
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	r.Shuffle(len(dishes), func(i, j int) {
		dishes[i], dishes[j] = dishes[j], dishes[i]
	})

	sort.SliceStable(dishes, func(i, j int) bool {
		a, b := tomorrowDishScore(dishes[i], profile, dislikes), tomorrowDishScore(dishes[j], profile, dislikes)
		if a != b {
			return a > b
		}
		return dishes[i].ID < dishes[j].ID
	})
}

func tomorrowDishScore(d models.Dish, profile string, dislikes map[string]bool) int {
	score := 0
	if d.Favorite {
		score += 12
	}
	// 命中家庭忌口的菜大幅降权，但不出局（多人就餐仍可能出现）
	if dishHitsDislikes(d, dislikes) {
		score -= 100
	}
	if matchesTomorrowProfile(d, profile) {
		score += 40
	}
	switch profile {
	case "quick":
		if d.Difficulty == "easy" {
			score += 18
		}
		if d.CookTime > 0 {
			score += maxInt(0, 35-d.CookTime)
		}
	case "light":
		if containsTaste(d.Taste, "清淡") {
			score += 18
		}
		if containsTaste(d.Taste, "鲜") {
			score += 10
		}
		if strings.Contains(d.Category, "汤") {
			score += 8
		}
	case "spicy":
		if containsTaste(d.Taste, "辣") {
			score += 18
		}
		if strings.Contains(d.Category, "川菜") || strings.Contains(d.Category, "湘菜") || strings.Contains(d.Category, "贵州菜") {
			score += 8
		}
	case "favorite":
		if d.Favorite {
			score += 30
		}
	default:
		if d.Difficulty == "easy" {
			score += 6
		}
		if d.CookTime > 0 && d.CookTime <= 35 {
			score += 4
		}
	}
	return score
}

// TodayDate 今天的日期（本地时区，YYYY-MM-DD，与记录的 meal_date 同格式）
func TodayDate() string {
	return time.Now().Format("2006-01-02")
}

// EatenRecords 只取已经吃过的用餐记录（meal_date 不晚于今天）。保存的明日菜单会生成
// 未来日期的记录，那是计划：累计次数、上次吃、成就等统计都不能把它算进去。
// 推荐去重（recentDishIDMap）仍然算上计划——明天要吃的菜今天不必再推荐。
func EatenRecords(db *gorm.DB) *gorm.DB {
	return db.Where("meal_date <= ?", TodayDate())
}

func recentDishIDMap(days int) map[uint]bool {
	if days <= 0 {
		return map[uint]bool{}
	}
	since := time.Now().AddDate(0, 0, -days).Format("2006-01-02")
	var recentIDs []uint
	database.DB.Model(&models.MealRecord{}).
		Where("meal_date >= ?", since).
		Pluck("dish_id", &recentIDs)

	result := make(map[uint]bool, len(recentIDs))
	for _, id := range recentIDs {
		result[id] = true
	}
	return result
}

func containsTaste(raw string, target string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" || target == "" {
		return false
	}
	for _, sep := range []string{"，", "、", "/", "|", ";", "；", " "} {
		raw = strings.ReplaceAll(raw, sep, ",")
	}
	for _, part := range strings.Split(raw, ",") {
		if strings.Contains(strings.TrimSpace(part), target) {
			return true
		}
	}
	return strings.Contains(raw, target)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func filterRecent(dishes []models.Dish, days int) []models.Dish {
	recentMap := recentDishIDMap(days)

	var filtered []models.Dish
	for _, d := range dishes {
		if !recentMap[d.ID] {
			filtered = append(filtered, d)
		}
	}
	return filtered
}

// familyDislikeConfig 家庭忌口完整配置
type familyDislikeConfig struct {
	tokens map[string]bool // 忌口集合（来自 family_members）
	strict bool            // true=严格过滤（命中即排除），false=温和降权（默认）
}

// parseFamilyDislikeTokens 解析 family_members 的 JSON 数组，汇总所有成员的忌口集合。
// 兼容旧格式：family_members 一直是 [{name,dislikes:[...]}] 数组；
// 空值、非法 JSON 或没有有效忌口时返回 nil。
func parseFamilyDislikeTokens(raw string) map[string]bool {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var members []struct {
		Name     string   `json:"name"`
		Dislikes []string `json:"dislikes"`
	}
	if json.Unmarshal([]byte(raw), &members) != nil {
		return nil
	}
	set := make(map[string]bool)
	for _, m := range members {
		for _, d := range m.Dislikes {
			d = strings.TrimSpace(d)
			if d != "" {
				set[d] = true
			}
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

// loadFamilyDislikes 读取家庭成员忌口集合（设置键 family_members），未配置返回 nil
func loadFamilyDislikes() map[string]bool {
	var setting models.Setting
	if err := database.DB.Where("`key` = ?", "family_members").First(&setting).Error; err != nil {
		return nil
	}
	return parseFamilyDislikeTokens(setting.Value)
}

// loadFamilyDislikeConfig 读取家庭忌口完整配置：
// 忌口集合来自 family_members（仍是 JSON 数组，兼容旧格式），
// 模式来自 family_dislike_mode：avoid=温和降权（默认）/ strict=严格过滤，缺失或其他值按 avoid 处理。
func loadFamilyDislikeConfig() familyDislikeConfig {
	var cfg familyDislikeConfig
	var modeSetting models.Setting
	if err := database.DB.Where("`key` = ?", "family_dislike_mode").First(&modeSetting).Error; err == nil {
		cfg.strict = strings.TrimSpace(modeSetting.Value) == "strict"
	}
	cfg.tokens = loadFamilyDislikes()
	return cfg
}

// applyDislikeMode 按家庭忌口模式处理候选池（avoid/strict 的选择逻辑，纯函数便于单测）：
// strict 模式剔除命中忌口的菜（可能返回空——全被过滤时宁可空推荐）；
// avoid 模式或未配置忌口时原样返回，由调用方降权。
func applyDislikeMode(dishes []models.Dish, cfg familyDislikeConfig) []models.Dish {
	if !cfg.strict || len(cfg.tokens) == 0 {
		return dishes
	}
	out := make([]models.Dish, 0, len(dishes))
	for _, d := range dishes {
		if !dishHitsDislikes(d, cfg.tokens) {
			out = append(out, d)
		}
	}
	return out
}

// seafoodSigns 海鲜类食材的识别子串
var seafoodSigns = []string{"虾", "鱼", "蟹", "贝", "鱿", "蛤", "蛏", "蚝"}

// offalSigns 内脏类食材的识别子串
var offalSigns = []string{"肝", "腰", "肚", "胗"}

// dishMatchesDislike 判断菜品是否命中某项忌口：
// 辣看口味/菜名/菜系（与 spicy profile 口径对齐，"辣子鸡丁"漏不掉），
// 海鲜/内脏按食材子串（偏好过滤够用；过敏场景请以实际食材为准），
// 其余按食材大类匹配（不吃猪肉 → 瘦肉/五花肉/排骨全部命中）。
func dishMatchesDislike(d models.Dish, dislike string) bool {
	switch dislike {
	case "辣":
		return strings.Contains(d.Taste, "辣") ||
			strings.Contains(d.Name, "辣") ||
			strings.Contains(d.Category, "辣")
	case "海鲜":
		for _, ing := range ParseDishIngredientNames(d) {
			for _, sign := range seafoodSigns {
				if strings.Contains(ing, sign) {
					return true
				}
			}
		}
		return false
	case "内脏":
		for _, ing := range ParseDishIngredientNames(d) {
			for _, sign := range offalSigns {
				if strings.Contains(ing, sign) {
					return true
				}
			}
		}
		return false
	default:
		for _, ing := range ParseDishIngredientNames(d) {
			if ingredients.CategoryOf(ing) == ingredients.CategoryOf(dislike) {
				return true
			}
		}
		return false
	}
}

// dishHitsDislikes 菜品是否命中任一忌口
func dishHitsDislikes(d models.Dish, dislikes map[string]bool) bool {
	for token := range dislikes {
		if dishMatchesDislike(d, token) {
			return true
		}
	}
	return false
}

// preferNonDisliked 单菜推荐（心情推荐、盲盒）的忌口处理：没有多人就餐的分摊余地，
// 两种模式都优先排除命中忌口的菜；差别在于全被排除时——
// strict 宁可返回空，avoid（温和降权）退回原候选，忌口不能把推荐清空。
func preferNonDisliked(dishes []models.Dish, cfg familyDislikeConfig) []models.Dish {
	if len(cfg.tokens) == 0 {
		return dishes
	}
	out := make([]models.Dish, 0, len(dishes))
	for _, d := range dishes {
		if !dishHitsDislikes(d, cfg.tokens) {
			out = append(out, d)
		}
	}
	if len(out) == 0 && !cfg.strict {
		return dishes
	}
	return out
}

// ExcludeStrictDisliked 按当前家庭忌口配置做 strict 过滤（avoid 模式原样返回）。
// 供菜品列表接口的推荐类展示位使用（首页今日推荐、转盘）。
func ExcludeStrictDisliked(dishes []models.Dish) []models.Dish {
	return applyDislikeMode(dishes, loadFamilyDislikeConfig())
}

// PreferNonDisliked 按当前家庭忌口配置处理单菜推荐候选，见 preferNonDisliked
func PreferNonDisliked(dishes []models.Dish) []models.Dish {
	return preferNonDisliked(dishes, loadFamilyDislikeConfig())
}

// PickMoodDishes 心情推荐：按心情取候选池、先做忌口处理再判空，最多 count 道。
// 心情池为空（或被 strict 忌口滤空）时退回普通推荐；返回推荐语场景（退回时为空串）。
func PickMoodDishes(mood string, count int) ([]models.Dish, string) {
	var dishes []models.Dish
	scene := ""
	switch mood {
	case "tired", "lazy":
		database.DB.Where("enabled = ? AND difficulty = ?", true, "easy").Find(&dishes)
		scene = "quick"
	case "spicy":
		database.DB.Where("enabled = ? AND taste = ?", true, "辣").Find(&dishes)
		scene = "lunch"
	case "healthy":
		database.DB.Where("enabled = ? AND taste IN ?", true, []string{"清淡", "鲜"}).Find(&dishes)
		scene = "dinner"
	}
	if candidates := PreferNonDisliked(dishes); len(candidates) > 0 {
		r := rand.New(rand.NewSource(time.Now().UnixNano()))
		r.Shuffle(len(candidates), func(i, j int) { candidates[i], candidates[j] = candidates[j], candidates[i] })
		if len(candidates) > count {
			candidates = candidates[:count]
		}
		return candidates, scene
	}
	fallback, _ := PickDishes("", count, true)
	return fallback, ""
}

// 随机抽菜的权重（avoid 温和降权）：命中忌口的菜是普通菜的 1/3，收藏是普通菜的 3 倍
// （收藏 : 普通 维持原来的 3 : 1）。strict 模式下忌口菜在抽签前已出局，用不到降权。
const (
	dislikedDishWeight = 1
	normalDishWeight   = 3
	favoriteDishWeight = 9
)

// dishPickWeight 午/晚餐推荐的抽签权重：命中忌口优先于收藏（收藏的忌口菜也只给 1）
func dishPickWeight(d models.Dish, dislikes map[string]bool) int {
	switch {
	case dishHitsDislikes(d, dislikes):
		return dislikedDishWeight
	case d.Favorite:
		return favoriteDishWeight
	default:
		return normalDishWeight
	}
}

// buildWeightedIndices 生成按权重重复的下标数组（洗牌后按首次出现取菜 = 不放回加权抽样）
func buildWeightedIndices(dishes []models.Dish, dislikes map[string]bool) []int {
	indices := make([]int, 0)
	for i, d := range dishes {
		for j := 0; j < dishPickWeight(d, dislikes); j++ {
			indices = append(indices, i)
		}
	}
	return indices
}

// ArrangeForRecommendation 首页推荐位（今日推荐/换一个/猜你喜欢/转盘）的忌口处理：
// strict 剔除命中忌口的菜；avoid 把它们排到最后，只有前面的菜不够时才会出现。
// random=true 时先打乱再排（转盘每次不同）。原切片不被修改。
func ArrangeForRecommendation(dishes []models.Dish, random bool) []models.Dish {
	return arrangeForRecommendation(dishes, loadFamilyDislikeConfig(), random, rand.New(rand.NewSource(time.Now().UnixNano())))
}

func arrangeForRecommendation(dishes []models.Dish, cfg familyDislikeConfig, random bool, r *rand.Rand) []models.Dish {
	out := make([]models.Dish, len(dishes))
	copy(out, dishes)
	if random {
		r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	}
	if len(cfg.tokens) == 0 {
		return out
	}
	if cfg.strict {
		return applyDislikeMode(out, cfg)
	}
	// 每道菜只判一次是否命中（判定要解析食材 JSON），再稳定地分成两段
	preferred := make([]models.Dish, 0, len(out))
	disliked := make([]models.Dish, 0)
	for _, d := range out {
		if dishHitsDislikes(d, cfg.tokens) {
			disliked = append(disliked, d)
		} else {
			preferred = append(preferred, d)
		}
	}
	return append(preferred, disliked...)
}

func GetRandomQuote(scene string) string {
	var quotes []models.Quote
	query := database.DB.Where("enabled = ?", true)
	if scene != "" {
		query = query.Where("scene = ?", scene)
	}
	query.Find(&quotes)

	if len(quotes) == 0 {
		database.DB.Where("enabled = ?", true).Find(&quotes)
	}

	if len(quotes) == 0 {
		return "今天吃点什么好呢？"
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	return quotes[r.Intn(len(quotes))].Content
}
