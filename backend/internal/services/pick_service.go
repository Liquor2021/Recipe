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

	if len(dishes) == 0 {
		return nil, nil
	}

	if excludeRecent {
		dishes = filterRecent(dishes, getRepeatDays())
	}

	if len(dishes) == 0 {
		var allDishes []models.Dish
		database.DB.Where("enabled = ?", true).Find(&allDishes)
		if mealType != "" {
			var filtered []models.Dish
			for _, d := range allDishes {
				if d.MealType == mealType || d.MealType == "all" {
					filtered = append(filtered, d)
				}
			}
			dishes = filtered
		} else {
			dishes = allDishes
		}
	}

	if len(dishes) == 0 {
		return nil, nil
	}

	weighted := buildWeightedIndices(dishes, loadFamilyDislikes())
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

	sortTomorrowPool(pool, profile, loadFamilyDislikes())
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

// loadFamilyDislikes 读取家庭成员忌口集合（设置键 family_members），未配置返回 nil
func loadFamilyDislikes() map[string]bool {
	var setting models.Setting
	if err := database.DB.Where("`key` = ?", "family_members").First(&setting).Error; err != nil {
		return nil
	}
	var members []struct {
		Name     string   `json:"name"`
		Dislikes []string `json:"dislikes"`
	}
	if json.Unmarshal([]byte(setting.Value), &members) != nil {
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
	return set
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

// buildWeightedIndices 生成按权重重复的下标数组：命中家庭忌口的菜固定权重 1（取消收藏加权）
func buildWeightedIndices(dishes []models.Dish, dislikes map[string]bool) []int {
	indices := make([]int, 0)
	for i, d := range dishes {
		w := 1
		if d.Favorite && !dishHitsDislikes(d, dislikes) {
			w += 2
		}
		for j := 0; j < w; j++ {
			indices = append(indices, i)
		}
	}
	return indices
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
