package services

import (
	"ninimenu/internal/models"
	"testing"
	"time"
)

func TestCountShares(t *testing.T) {
	shares := countShares([]string{"麻辣", "酸甜", "麻辣", "咸鲜", "麻辣", "酸甜", "", "  "}, 2)
	if len(shares) != 2 {
		t.Fatalf("topN=2 should return 2, got %v", shares)
	}
	if shares[0].Name != "麻辣" || shares[0].Count != 3 {
		t.Fatalf("shares[0] = %+v, want 麻辣 3", shares[0])
	}
	if shares[1].Name != "酸甜" || shares[1].Count != 2 {
		t.Fatalf("shares[1] = %+v, want 酸甜 2", shares[1])
	}
	if got := countShares(nil, 6); len(got) != 0 {
		t.Fatalf("nil tokens should give empty shares, got %v", got)
	}
}

func TestRateOf(t *testing.T) {
	tests := []struct {
		part, total, want int
	}{
		{0, 0, 0},  // 分母为 0
		{1, 3, 33}, // 四舍五入
		{2, 3, 67},
		{1, 2, 50},
		{3, 3, 100},
	}
	for _, tt := range tests {
		if got := rateOf(tt.part, tt.total); got != tt.want {
			t.Fatalf("rateOf(%d, %d) = %d, want %d", tt.part, tt.total, got, tt.want)
		}
	}
}

func TestSplitTasteTokens(t *testing.T) {
	got := splitTasteTokens("酸甜,咸鲜、香辣/ 清淡")
	want := []string{"酸甜", "咸鲜", "香辣", "清淡"}
	if len(got) != len(want) {
		t.Fatalf("tokens = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tokens[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestBuildDietReport(t *testing.T) {
	start := time.Date(2026, 10, 19, 0, 0, 0, 0, time.Local) // 周一
	end := start.AddDate(0, 0, 6)
	rngStart, rngEnd := start.Format("2006-01-02"), end.Format("2006-01-02")

	mk := func(id uint, name, taste, category, date string, rating int) models.Dish {
		return models.Dish{}
	}
	_ = mk
	dishA := models.Dish{ID: 1, Name: "番茄炒蛋", Taste: "酸甜", Category: "家常菜"}
	dishB := models.Dish{ID: 2, Name: "红烧排骨", Taste: "酱香,咸鲜", Category: "家常菜"}
	dishC := models.Dish{ID: 3, Name: "冬阴功汤", Taste: "酸辣", Category: "泰国菜"}
	dishByID := map[uint]models.Dish{1: dishA, 2: dishB, 3: dishC}

	records := []models.MealRecord{
		{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: rngStart, Rating: 5},
		{DishID: 1, DishName: "番茄炒蛋", MealType: "dinner", MealDate: rngStart, Rating: 4},
		{DishID: 2, DishName: "红烧排骨", MealType: "dinner", MealDate: rngStart, Rating: 0},
		{DishID: 3, DishName: "冬阴功汤", MealType: "lunch", MealDate: rngEnd, Rating: 3},
	}
	// 番茄炒蛋上周期就做过 → 不是新菜；红烧排骨/冬阴功汤本周期首做 → 新菜
	firstCookedAt := map[uint]string{1: "2026-09-01", 2: rngStart, 3: rngEnd}

	report := buildDietReport("week", start, end, records, dishByID, firstCookedAt, 4, []string{"yum", "yum", "ok"})

	if report.CookDays != 2 {
		t.Fatalf("CookDays = %d, want 2", report.CookDays)
	}
	if report.TotalMeals != 4 || report.LunchCount != 2 || report.DinnerCount != 2 {
		t.Fatalf("meals = %d/%d/%d, want 4/2/2", report.TotalMeals, report.LunchCount, report.DinnerCount)
	}
	if report.PrevCookDays != 4 {
		t.Fatalf("PrevCookDays = %d, want 4", report.PrevCookDays)
	}
	// 复做率：番茄炒蛋做过 2 次 = 1/3 ≈ 33%
	if report.RepeatRate != 33 {
		t.Fatalf("RepeatRate = %d, want 33", report.RepeatRate)
	}
	// 新菜率：排骨+冬阴功 = 2/3 ≈ 67%
	if report.NewDishRate != 67 {
		t.Fatalf("NewDishRate = %d, want 67", report.NewDishRate)
	}
	// 平均分：(5+4+3)/3 = 4.0
	if report.AvgRating != 4.0 {
		t.Fatalf("AvgRating = %.1f, want 4.0", report.AvgRating)
	}
	if len(report.TopDishes) != 3 || report.TopDishes[0].DishName != "番茄炒蛋" || report.TopDishes[0].Count != 2 {
		t.Fatalf("TopDishes[0] = %+v, want 番茄炒蛋 x2", report.TopDishes[0])
	}
	if len(report.TasteShares) == 0 || report.TasteShares[0].Name != "酸甜" || report.TasteShares[0].Count != 2 {
		t.Fatalf("TasteShares[0] = %+v, want 酸甜 x2 (番茄炒蛋x2；冬阴功是酸辣)", report.TasteShares[0])
	}
	if report.CategoryShares[0].Name != "家常菜" || report.CategoryShares[0].Count != 3 {
		t.Fatalf("CategoryShares[0] = %+v, want 家常菜 x3", report.CategoryShares[0])
	}
	if report.MoodShares[0].Name != "yum" || report.MoodShares[0].Count != 2 {
		t.Fatalf("MoodShares[0] = %+v, want yum x2", report.MoodShares[0])
	}
}
