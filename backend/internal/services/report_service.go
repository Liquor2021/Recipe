package services

import (
	"math"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"sort"
	"strings"
	"time"
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
	TotalMeals     int             `json:"total_meals"`
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
		switch r.MealType {
		case "lunch":
			lunchCount++
		case "dinner":
			dinnerCount++
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
		TotalMeals:     len(records),
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
func GetDietReport(rng string) *DietReport {
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
	database.DB.Where("meal_date >= ? AND meal_date <= ?", start.Format("2006-01-02"), end.Format("2006-01-02")).
		Order("meal_date ASC, created_at ASC").Find(&records)

	var dishes []models.Dish
	database.DB.Find(&dishes)
	dishByID := make(map[uint]models.Dish, len(dishes))
	for _, d := range dishes {
		dishByID[d.ID] = d
	}

	type firstRow struct {
		DishID  uint
		FirstAt string
	}
	var firstRows []firstRow
	database.DB.Model(&models.MealRecord{}).
		Select("dish_id, min(meal_date) as first_at").
		Group("dish_id").Scan(&firstRows)
	firstCookedAt := make(map[uint]string, len(firstRows))
	for _, row := range firstRows {
		firstCookedAt[row.DishID] = row.FirstAt
	}

	var prevCookDays int64
	prevStart, prevEnd := previousPeriod(rng, start, today)
	database.DB.Model(&models.MealRecord{}).
		Where("meal_date >= ? AND meal_date <= ?", prevStart.Format("2006-01-02"), prevEnd.Format("2006-01-02")).
		Distinct("meal_date").Count(&prevCookDays)

	var dayRatings []models.DayRating
	database.DB.Where("meal_date >= ? AND meal_date <= ? AND mood != ''",
		start.Format("2006-01-02"), end.Format("2006-01-02")).Find(&dayRatings)
	moodTokens := make([]string, 0, len(dayRatings))
	for _, dr := range dayRatings {
		moodTokens = append(moodTokens, dr.Mood)
	}

	return buildDietReport(rng, start, end, records, dishByID, firstCookedAt, int(prevCookDays), moodTokens)
}
