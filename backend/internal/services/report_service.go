package services

import (
	"fmt"
	"math"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type TasteShare struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type ReportTopDish struct {
	DishID   uint   `json:"dish_id"`
	DishName string `json:"dish_name"`
	Count    int    `json:"count"`
}

// DietReport 周/月饮食报告：全部由用餐记录与评价聚合而来
type DietReport struct {
	Range          string          `json:"range"`
	StartDate      string          `json:"start_date"`
	EndDate        string          `json:"end_date"`
	CookDays       int             `json:"cook_days"`
	PrevCookDays   int             `json:"prev_cook_days"` // 上一周期相同已过天数内的做饭天数，见 previousPeriod
	TotalMeals     int             `json:"total_meals"`    // 同一天同一餐只计一顿，与菜品份数分开
	LunchCount     int             `json:"lunch_count"`
	DinnerCount    int             `json:"dinner_count"`
	DistinctDishes int             `json:"distinct_dishes"`
	RepeatRate     int             `json:"repeat_rate"`   // 复做率：做过 >=2 次的菜占比 %
	NewDishRate    int             `json:"new_dish_rate"` // 新菜率：本周期首次尝试的菜占比 %
	AvgRating      float64         `json:"avg_rating"`    // 有评分记录的平均分
	TopDishes      []ReportTopDish `json:"top_dishes"`
	TasteShares    []TasteShare    `json:"taste_shares"`
	CategoryShares []TasteShare    `json:"category_shares"`
	MoodShares     []TasteShare    `json:"mood_shares"`
	Balance        DietBalance     `json:"balance"`
}

// DietBalance 荤素搭配：按吃到的每一份菜统计（同一道菜吃两次算两次），归类看菜谱主料
type DietBalance struct {
	MixedCount   int          `json:"mixed_count"`    // 有荤有素
	MeatCount    int          `json:"meat_count"`     // 只有荤
	VegCount     int          `json:"veg_count"`      // 没有荤（素菜、蛋、豆腐、主食）
	Meals        int          `json:"meals"`          // 吃了几顿（同一天同一餐算一顿）
	MealsWithVeg int          `json:"meals_with_veg"` // 其中吃到蔬菜的顿数
	Vegetables   []TasteShare `json:"vegetables"`     // 吃到的蔬菜（按次数降序）
}

// notVegServing 买菜清单归在"蔬菜"、但不算吃了一份蔬菜的：香菜紫苏这类点缀、
// 干辣椒小米辣这类调味辣椒、豆沙馅、干豆子（葱蒜见 ingredients.IsStaple，姜按字判）
var notVegServing = map[string]bool{
	"香菜": true, "芫荽": true, "芜荽": true, "紫苏": true, "薄荷": true, "香茅": true, "罗勒": true, "九层塔": true,
	"干辣椒": true, "干红辣椒": true, "小米辣": true, "小米椒": true, "泡椒": true, "剁椒": true,
	"朝天椒": true, "野山椒": true, "糟辣椒": true,
	"豆沙": true, "红豆沙": true, "红豆馅": true, "黄豆": true, "绿豆": true, "红豆": true, "黑豆": true,
	"香菜根": true, "蘸水辣椒": true, "玉米面": true,
}

func isVegServing(name string) bool {
	// 先去切法、再归别名；保留“干”等前缀，避免干辣椒被当成鲜辣椒。
	n := ingredients.Normalize(reportIngredientBase(name))
	return n != "" && !ingredients.IsStaple(n) && !strings.Contains(n, "姜") && !notVegServing[n]
}

// reportIngredientBase 只去切配后缀，不去干鲜、产地等会改变食材含义的前缀。
// 一字食材只处理已知葱姜蒜，避免把“芥末”等名称误拆。
func reportIngredientBase(name string) string {
	n := strings.TrimSpace(name)
	for _, suffix := range []string{"片", "丝", "丁", "块", "段", "末", "碎", "泥", "蓉"} {
		if rest := strings.TrimSuffix(n, suffix); rest != n && (utf8.RuneCountInString(rest) >= 2 || ingredients.IsStaple(rest)) {
			return rest
		}
	}
	return n
}

// 种子菜谱中不能按“油/豆豉”等调味关键词推断的完整主料名。
// 仅补已确认的例外，其他食材沿用买菜分类，后台的人工分类始终优先。
var reportIngredientCategories = map[string]string{
	"豆豉鲮鱼罐头": "肉类",
	"黄辣丁":    "肉类",
	"东北油豆角":  "蔬菜",
}

func classifyReportIngredient(name string, overrides map[string]string) string {
	if category := overrides[name]; isValidShoppingCategory(category) {
		return category
	}
	// 完整名先于去切法后的名称：“黄辣丁”的“丁”是鱼名的一部分。
	for _, n := range []string{ingredients.Normalize(name), ingredients.Normalize(reportIngredientBase(name))} {
		if category := reportIngredientCategories[n]; category != "" {
			return category
		}
		if category := shoppingCategoryExact[n]; category != "" {
			return category
		}
	}
	return classifyShoppingItem(name, nil)
}

// 数"吃到几种蔬菜"时去掉的前后缀：干香菇=香菇、长茄子=茄子、土豆片=土豆
// （不去"条"：二荆条、豆角条的"条"是名字的一部分）
var (
	vegKindPrefixes = []string{"有机", "泡发", "铁棍", "新鲜", "鲜", "干", "嫩", "长"}
	vegKindSuffixes = []string{"片", "丝", "丁", "块", "段", "末", "碎"}
)

// vegKind 蔬菜的"种类名"：各种豆腐算一种，藕片=莲藕，去掉切法和干鲜前后缀（去完至少留两个字），再按真别名归一
func vegKind(name string) string {
	n := strings.TrimSpace(name)
	if strings.Contains(n, "豆腐") {
		return "豆腐"
	}
	if strings.HasPrefix(n, "藕") {
		return "莲藕"
	}
	for _, p := range vegKindPrefixes {
		if rest := strings.TrimPrefix(n, p); rest != n && utf8.RuneCountInString(rest) >= 2 {
			n = rest
			break
		}
	}
	for _, s := range vegKindSuffixes {
		if rest := strings.TrimSuffix(n, s); rest != n && utf8.RuneCountInString(rest) >= 2 {
			n = rest
			break
		}
	}
	return ingredients.Normalize(n)
}

// dishBalanceInfo 一道菜的荤素归类
type dishBalanceInfo struct {
	hasMeat  bool
	vegKinds []string // 去重后的蔬菜种类
}

// classifyDishBalance 按菜谱主料归类：沿用买菜分类与人工改写，修正已知主料的关键词歧义；
// 鸡蛋、咸蛋黄在买菜清单里归肉类，但家常说法里不算荤
func classifyDishBalance(d models.Dish, overrides map[string]string) dishBalanceInfo {
	var info dishBalanceInfo
	seen := make(map[string]bool)
	for _, ing := range ParseIngredientList(d.Ingredients) {
		switch classifyReportIngredient(ing.Name, overrides) {
		case "肉类":
			if !strings.Contains(ing.Name, "蛋") {
				info.hasMeat = true
			}
		case "蔬菜":
			if isVegServing(ing.Name) {
				if k := vegKind(ing.Name); !seen[k] {
					seen[k] = true
					info.vegKinds = append(info.vegKinds, k)
				}
			}
		}
	}
	return info
}

// buildDietBalance 纯函数：周期内每条用餐记录归成荤素搭配/纯荤/素，并统计每顿有没有蔬菜、吃到了哪些蔬菜。
// 菜已删除（查不到菜谱）的记录不参与
func buildDietBalance(records []models.MealRecord, dishByID map[uint]models.Dish, overrides map[string]string) DietBalance {
	b := DietBalance{Vegetables: []TasteShare{}}
	infoByDish := make(map[uint]dishBalanceInfo)
	type mealKey struct{ date, meal string }
	mealHasVeg := make(map[mealKey]bool)
	var vegTokens []string
	for _, r := range records {
		dish, ok := dishByID[r.DishID]
		if !ok {
			continue
		}
		info, done := infoByDish[r.DishID]
		if !done {
			info = classifyDishBalance(dish, overrides)
			infoByDish[r.DishID] = info
		}
		hasVeg := len(info.vegKinds) > 0
		switch {
		case info.hasMeat && hasVeg:
			b.MixedCount++
		case info.hasMeat:
			b.MeatCount++
		default:
			b.VegCount++
		}
		k := mealKey{r.MealDate, r.MealType}
		mealHasVeg[k] = mealHasVeg[k] || hasVeg
		vegTokens = append(vegTokens, info.vegKinds...)
	}
	b.Meals = len(mealHasVeg)
	for _, has := range mealHasVeg {
		if has {
			b.MealsWithVeg++
		}
	}
	b.Vegetables = countShares(vegTokens, 0)
	return b
}

// countShares 统计词频并按次数降序取前 N（稳定排序，同次数按出现顺序）
func countShares(tokens []string, topN int) []TasteShare {
	order := make([]string, 0, len(tokens))
	counts := make(map[string]int)
	for _, t := range tokens {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if _, seen := counts[t]; !seen {
			order = append(order, t)
		}
		counts[t]++
	}
	shares := make([]TasteShare, 0, len(order))
	for _, name := range order {
		shares = append(shares, TasteShare{Name: name, Count: counts[name]})
	}
	sort.SliceStable(shares, func(i, j int) bool { return shares[i].Count > shares[j].Count })
	if topN > 0 && len(shares) > topN {
		shares = shares[:topN]
	}
	return shares
}

// rateOf 百分比（四舍五入），分母为 0 返回 0
func rateOf(part, total int) int {
	if total <= 0 {
		return 0
	}
	return int(math.Round(float64(part) * 100 / float64(total)))
}

// splitTasteTokens 把菜品的口味字段（如 "酸甜,咸鲜"）拆成词
func splitTasteTokens(taste string) []string {
	return strings.FieldsFunc(taste, func(r rune) bool { return r == ',' || r == '、' || r == '/' || r == ' ' })
}

// buildDietReport 纯函数：由周期内记录、菜品表、每菜首做日期、上个周期做饭天数、心情词列表，组装报告
func buildDietReport(rng string, start, end time.Time, records []models.MealRecord, dishByID map[uint]models.Dish, firstCookedAt map[uint]string, prevCookDays int, moodTokens []string) *DietReport {
	startStr, endStr := start.Format("2006-01-02"), end.Format("2006-01-02")

	cookDaySet := make(map[string]bool)
	type mealKey struct{ date, meal string }
	mealSet := make(map[mealKey]bool)
	type perDish struct {
		count    int
		ratedSum int
		ratedN   int
	}
	stats := make(map[uint]*perDish)
	lunchCount, dinnerCount, ratedSum, ratedN := 0, 0, 0, 0
	tasteTokens := make([]string, 0, len(records))
	categoryTokens := make([]string, 0, len(records))

	for _, r := range records {
		cookDaySet[r.MealDate] = true
		key := mealKey{r.MealDate, r.MealType}
		if !mealSet[key] {
			mealSet[key] = true
			switch r.MealType {
			case "lunch":
				lunchCount++
			case "dinner":
				dinnerCount++
			}
		}
		st, ok := stats[r.DishID]
		if !ok {
			st = &perDish{}
			stats[r.DishID] = st
		}
		st.count++
		if r.Rating > 0 {
			ratedSum += r.Rating
			ratedN++
		}
		if dish, ok := dishByID[r.DishID]; ok {
			tasteTokens = append(tasteTokens, splitTasteTokens(dish.Taste)...)
			if dish.Category != "" {
				categoryTokens = append(categoryTokens, dish.Category)
			}
		}
	}

	repeated := 0
	newDishes := 0
	topDishes := make([]ReportTopDish, 0, len(stats))
	for dishID, st := range stats {
		if st.count >= 2 {
			repeated++
		}
		if first, ok := firstCookedAt[dishID]; ok && first >= startStr && first <= endStr {
			newDishes++
		}
		name := ""
		if dish, ok := dishByID[dishID]; ok {
			name = dish.Name
		}
		if name == "" {
			for _, r := range records {
				if r.DishID == dishID {
					name = r.DishName
					break
				}
			}
		}
		topDishes = append(topDishes, ReportTopDish{DishID: dishID, DishName: name, Count: st.count})
	}
	sort.SliceStable(topDishes, func(i, j int) bool {
		if topDishes[i].Count != topDishes[j].Count {
			return topDishes[i].Count > topDishes[j].Count
		}
		return topDishes[i].DishID < topDishes[j].DishID
	})
	if len(topDishes) > 5 {
		topDishes = topDishes[:5]
	}

	// 心情分布来自每日评价（词列表由调用方传入，保持本函数可测）
	avgRating := 0.0
	if ratedN > 0 {
		avgRating = math.Round(float64(ratedSum)/float64(ratedN)*10) / 10
	}

	return &DietReport{
		Range:          rng,
		StartDate:      startStr,
		EndDate:        endStr,
		CookDays:       len(cookDaySet),
		PrevCookDays:   prevCookDays,
		TotalMeals:     len(mealSet),
		LunchCount:     lunchCount,
		DinnerCount:    dinnerCount,
		DistinctDishes: len(stats),
		RepeatRate:     rateOf(repeated, len(stats)),
		NewDishRate:    rateOf(newDishes, len(stats)),
		AvgRating:      avgRating,
		TopDishes:      topDishes,
		TasteShares:    countShares(tasteTokens, 6),
		CategoryShares: countShares(categoryTokens, 6),
		MoodShares:     countShares(moodTokens, 3),
	}
}

// previousPeriod 环比的上期区间：上一周期的"相同位置"。本期是部分周期（如周三打开周报
// 只过了 3 天），上期也只取上一周期的前 3 天，否则周初/月初会系统性显示"比上期少"。
// 月报取上月 1 日起同样天数，上月更短时截到上月最后一天（3 月 31 日对比的是整个 2 月）；
// 上期永远在本期开始之前结束，不会与本期重叠。
func previousPeriod(rng string, start, today time.Time) (time.Time, time.Time) {
	// 四舍五入：有夏令时的时区两个零点之间可能是 23/25 小时
	elapsed := int(math.Round(today.Sub(start).Hours()/24)) + 1
	var prevStart time.Time
	if rng == "week" {
		prevStart = start.AddDate(0, 0, -7)
	} else {
		prevStart = time.Date(start.Year(), start.Month()-1, 1, 0, 0, 0, 0, start.Location())
	}
	prevEnd := prevStart.AddDate(0, 0, elapsed-1)
	if lastDay := start.AddDate(0, 0, -1); prevEnd.After(lastDay) {
		prevEnd = lastDay
	}
	return prevStart, prevEnd
}

// GetDietReport 生成周/月饮食报告
func GetDietReport(rng string) (*DietReport, error) {
	if rng != "month" {
		rng = "week"
	}
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)

	var start time.Time
	if rng == "week" {
		weekday := int(today.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		start = today.AddDate(0, 0, -(weekday - 1)) // 本周一
	} else {
		start = time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.Local)
	}
	end := today
	var records []models.MealRecord
	if err := database.DB.Scopes(EatenRecords).Where("meal_date >= ? AND meal_date <= ?", start.Format("2006-01-02"), end.Format("2006-01-02")).
		Order("meal_date ASC, created_at ASC").Find(&records).Error; err != nil {
		return nil, fmt.Errorf("read report meal records: %w", err)
	}

	var dishes []models.Dish
	if err := database.DB.Find(&dishes).Error; err != nil {
		return nil, fmt.Errorf("read report dishes: %w", err)
	}
	dishByID := make(map[uint]models.Dish, len(dishes))
	for _, d := range dishes {
		dishByID[d.ID] = d
	}

	type firstRow struct {
		DishID  uint
		FirstAt string
	}
	var firstRows []firstRow
	if err := database.DB.Model(&models.MealRecord{}).Scopes(EatenRecords).
		Select("dish_id, min(meal_date) as first_at").
		Group("dish_id").Scan(&firstRows).Error; err != nil {
		return nil, fmt.Errorf("read report first cooked dates: %w", err)
	}
	firstCookedAt := make(map[uint]string, len(firstRows))
	for _, row := range firstRows {
		firstCookedAt[row.DishID] = row.FirstAt
	}

	var prevCookDays int64
	prevStart, prevEnd := previousPeriod(rng, start, today)
	if err := database.DB.Model(&models.MealRecord{}).Scopes(EatenRecords).
		Where("meal_date >= ? AND meal_date <= ?", prevStart.Format("2006-01-02"), prevEnd.Format("2006-01-02")).
		Distinct("meal_date").Count(&prevCookDays).Error; err != nil {
		return nil, fmt.Errorf("read report previous cook days: %w", err)
	}

	var dayRatings []models.DayRating
	if err := database.DB.Where("meal_date >= ? AND meal_date <= ? AND mood != ''",
		start.Format("2006-01-02"), end.Format("2006-01-02")).
		Where("meal_date IN (?)", database.DB.Model(&models.MealRecord{}).Scopes(EatenRecords).Select("meal_date")).Find(&dayRatings).Error; err != nil {
		return nil, fmt.Errorf("read report day ratings: %w", err)
	}
	moodTokens := make([]string, 0, len(dayRatings))
	for _, dr := range dayRatings {
		moodTokens = append(moodTokens, dr.Mood)
	}

	categoryByName, err := getShoppingCategoryOverrideMap()
	if err != nil {
		return nil, fmt.Errorf("read report ingredient categories: %w", err)
	}
	report := buildDietReport(rng, start, end, records, dishByID, firstCookedAt, int(prevCookDays), moodTokens)
	report.Balance = buildDietBalance(records, dishByID, categoryByName)
	return report, nil
}
