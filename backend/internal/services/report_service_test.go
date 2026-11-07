package services

import (
	"encoding/json"
	"ninimenu/internal/database"
	"ninimenu/internal/dishes"
	"ninimenu/internal/models"
	"slices"
	"strings"
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

func TestPreviousPeriod(t *testing.T) {
	day := func(s string) time.Time {
		d, err := time.ParseInLocation("2006-01-02", s, time.Local)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	tests := []struct {
		note, rng, start, today string
		wantStart, wantEnd      string
	}{
		{"周三：对比上周一到周三", "week", "2026-10-26", "2026-10-28", "2026-10-19", "2026-10-21"},
		{"周日：对比整个上周", "week", "2026-10-26", "2026-11-01", "2026-10-19", "2026-10-25"},
		{"3 月 1 日：对比 2 月 1 日（不是 1 月 30 日）", "month", "2026-03-01", "2026-03-01", "2026-02-01", "2026-02-01"},
		{"10 月 31 日：对比整个 9 月，不与本期重叠", "month", "2026-10-01", "2026-10-31", "2026-09-01", "2026-09-30"},
		{"3 月 31 日：上月更短，截到 2 月末", "month", "2026-03-01", "2026-03-31", "2026-02-01", "2026-02-28"},
		{"闰年 2 月 29 日：对比 1 月前 29 天", "month", "2028-02-01", "2028-02-29", "2028-01-01", "2028-01-29"},
		{"1 月跨年：对比去年 12 月", "month", "2027-01-01", "2027-01-15", "2026-12-01", "2026-12-15"},
	}
	for _, tt := range tests {
		gotStart, gotEnd := previousPeriod(tt.rng, day(tt.start), day(tt.today))
		if gs, ge := gotStart.Format("2006-01-02"), gotEnd.Format("2006-01-02"); gs != tt.wantStart || ge != tt.wantEnd {
			t.Fatalf("[%s] previousPeriod = %s..%s, want %s..%s", tt.note, gs, ge, tt.wantStart, tt.wantEnd)
		}
	}
}

func TestBuildDietReport(t *testing.T) {
	start := time.Date(2026, 10, 19, 0, 0, 0, 0, time.Local) // 周一
	end := start.AddDate(0, 0, 6)
	rngStart, rngEnd := start.Format("2006-01-02"), end.Format("2006-01-02")

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
	if report.TotalMeals != 3 || report.LunchCount != 2 || report.DinnerCount != 1 {
		t.Fatalf("meals = %d/%d/%d, want 3/2/1 (同日晚饭两道菜算一顿)", report.TotalMeals, report.LunchCount, report.DinnerCount)
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

func TestGetDietReportCountsMealSlotsAndKeepsDishHistory(t *testing.T) {
	setupTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.DayRating{}, &models.ShoppingItemCategory{})
	db := database.DB
	dish := models.Dish{ID: 1, Name: "番茄炒蛋", Taste: "酸甜", Category: "家常菜", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	today := TodayDate()
	for _, record := range []models.MealRecord{
		{DishID: 1, DishName: dish.Name, MealDate: today, MealType: "lunch", Status: models.MealCompleted, Rating: 5},
		// 已删除菜谱仍保留吃过的事实，同餐多道菜也不会多算一顿。
		{DishID: 2, DishName: "已删除的午餐菜", MealDate: today, MealType: "lunch", Status: models.MealCompleted, Rating: 3},
		{DishID: 3, DishName: "已删除的晚餐菜", MealDate: today, MealType: "dinner", Status: models.MealCompleted},
		{DishID: 4, DishName: "未完成计划", MealDate: today, MealType: "lunch", Status: models.MealPlanned},
		{DishID: 5, DishName: "已取消计划", MealDate: today, MealType: "dinner", Status: models.MealCancelled},
		{DishID: 1, DishName: dish.Name, MealDate: time.Now().AddDate(0, 0, 1).Format("2006-01-02"), MealType: "lunch", Status: models.MealCompleted},
	} {
		if err := db.Create(&record).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, period := range []string{"week", "month"} {
		report, err := GetDietReport(period)
		if err != nil {
			t.Fatal(err)
		}
		if report.TotalMeals != 2 || report.LunchCount != 1 || report.DinnerCount != 1 || report.CookDays != 1 {
			t.Fatalf("%s: 应统计今日已吃的午餐和晚餐各一顿: %+v", period, report)
		}
		if report.DistinctDishes != 3 || len(report.TopDishes) != 3 || report.AvgRating != 4 {
			t.Fatalf("%s: 餐次去重不能改变菜品次数和评价统计: %+v", period, report)
		}
		if report.TopDishes[1].DishName != "已删除的午餐菜" || report.TopDishes[2].DishName != "已删除的晚餐菜" {
			t.Fatalf("%s: 已删菜谱应继续使用记录里的菜名: %+v", period, report.TopDishes)
		}
		// 无菜谱的记录无法判断荤素，继续沿用原来的“可识别菜谱”口径。
		if report.Balance.Meals != 1 || report.Balance.MealsWithVeg != 1 {
			t.Fatalf("%s: 荤素分析不应猜测已删菜谱的食材: %+v", period, report.Balance)
		}
	}
}

func TestBuildDietReportEmptyMeals(t *testing.T) {
	today := time.Date(2026, 11, 7, 0, 0, 0, 0, time.Local)
	report := buildDietReport("week", today, today, nil, nil, nil, 0, nil)
	if report.TotalMeals != 0 || report.LunchCount != 0 || report.DinnerCount != 0 || report.CookDays != 0 {
		t.Fatalf("空周期应显示零餐次: %+v", report)
	}
	if report.TopDishes == nil || report.TasteShares == nil || report.CategoryShares == nil {
		t.Fatalf("空报告仍应返回数组，供页面和分享图直接使用: %+v", report)
	}
}

func TestBuildDietBalance(t *testing.T) {
	dish := func(id uint, name string, ings ...string) models.Dish {
		parts := make([]string, 0, len(ings))
		for _, n := range ings {
			parts = append(parts, `{"name":"`+n+`","amount":"1份"}`)
		}
		return models.Dish{ID: id, Name: name, Ingredients: "[" + strings.Join(parts, ",") + "]"}
	}
	dishByID := map[uint]models.Dish{
		1: dish(1, "青椒肉丝", "瘦肉", "青椒", "小葱"), // 荤素搭配（葱不算一份蔬菜）
		2: dish(2, "红烧肉", "五花肉", "姜"),        // 只有荤
		3: dish(3, "辣子鸡", "鸡腿", "干辣椒", "花椒"), // 只有荤（干辣椒是调味）
		4: dish(4, "番茄炒蛋", "西红柿", "鸡蛋"),      // 素：鸡蛋不算荤，西红柿记成番茄
		5: dish(5, "香菇土豆片", "干香菇", "土豆片"),    // 素：干香菇=香菇、土豆片=土豆
		6: dish(6, "阳春面", "面条", "小葱"),        // 素（没有蔬菜）
		7: dish(7, "菜花蛇", "菜花蛇段"),            // 只有荤（名字带"菜"也是蛇肉）
	}
	rec := func(dishID uint, date, meal string) models.MealRecord {
		return models.MealRecord{DishID: dishID, MealDate: date, MealType: meal}
	}
	records := []models.MealRecord{
		rec(1, "2026-10-26", "lunch"), rec(4, "2026-10-26", "lunch"),
		rec(2, "2026-10-26", "dinner"), rec(3, "2026-10-26", "dinner"),
		rec(4, "2026-10-27", "lunch"), rec(5, "2026-10-27", "lunch"),
		rec(6, "2026-10-27", "dinner"),
		rec(99, "2026-10-28", "lunch"), // 菜已删除：不参与
		rec(7, "2026-10-28", "dinner"),
	}

	b := buildDietBalance(records, dishByID, nil)
	if b.MixedCount != 1 || b.MeatCount != 3 || b.VegCount != 4 {
		t.Fatalf("mixed/meat/veg = %d/%d/%d, want 1/3/4", b.MixedCount, b.MeatCount, b.VegCount)
	}
	if b.Meals != 5 || b.MealsWithVeg != 2 {
		t.Fatalf("meals = %d, with veg = %d, want 5 / 2 (只有已删菜的那顿不算)", b.Meals, b.MealsWithVeg)
	}
	want := []TasteShare{{"番茄", 2}, {"青椒", 1}, {"香菇", 1}, {"土豆", 1}}
	if len(b.Vegetables) != len(want) {
		t.Fatalf("vegetables = %+v, want %+v", b.Vegetables, want)
	}
	for i := range want {
		if b.Vegetables[i] != want[i] {
			t.Fatalf("vegetables[%d] = %+v, want %+v (all: %+v)", i, b.Vegetables[i], want[i], b.Vegetables)
		}
	}

	// 后台把"面条"改成蔬菜分类：归类跟着买菜清单的分类走
	b = buildDietBalance(records[6:7], dishByID, map[string]string{"面条": "蔬菜"})
	if b.MealsWithVeg != 1 || len(b.Vegetables) != 1 || b.Vegetables[0].Name != "面条" {
		t.Fatalf("分类改写应生效, got %+v", b)
	}

	// 没有记录：蔬菜列表是空数组不是 nil（JSON 里是 []）
	if b := buildDietBalance(nil, dishByID, nil); b.Vegetables == nil || b.Meals != 0 {
		t.Fatalf("空记录应返回零值和空列表, got %+v", b)
	}
}

func TestVegKindAndServing(t *testing.T) {
	kinds := map[string]string{
		"干香菇": "香菇", "长茄子": "茄子", "土豆片": "土豆", "嫩豆腐": "豆腐", "冻豆腐": "豆腐",
		"藕片": "莲藕", "二荆条": "二荆条", "西红柿": "番茄", "笋片": "笋片", // 去完只剩一个字就不去
	}
	for in, want := range kinds {
		if got := vegKind(in); got != want {
			t.Errorf("vegKind(%q) = %q, want %q", in, got, want)
		}
	}
	for name, want := range map[string]bool{"青椒": true, "豆腐": true, "香菜": false, "小米辣": false, "嫩姜": false, "小葱": false} {
		if got := isVegServing(name); got != want {
			t.Errorf("isVegServing(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestDietBalanceSeedIngredients(t *testing.T) {
	seedByName := make(map[string]models.Dish)
	for _, dish := range dishes.DefaultDishes() {
		seedByName[dish.Name] = dish
	}
	for _, tc := range []struct {
		name    string
		hasMeat bool
		veg     []string
	}{
		{"罐头鲮鱼油麦菜", true, []string{"油麦菜"}},
		{"豆豉鲮鱼油麦菜", true, []string{"油麦菜"}},
		{"黄辣丁豆腐汤", true, []string{"豆腐"}},
		{"排骨炖豆角", true, []string{"东北油豆角", "土豆"}},
		{"遵义羊肉粉", true, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dish, ok := seedByName[tc.name]
			if !ok {
				t.Fatalf("missing seed dish %q", tc.name)
			}
			info := classifyDishBalance(dish, nil)
			if info.hasMeat != tc.hasMeat || !slices.Equal(info.vegKinds, tc.veg) {
				t.Fatalf("balance = %+v, want meat=%v vegetables=%v", info, tc.hasMeat, tc.veg)
			}
		})
	}
}

func TestDietBalanceIngredientBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name      string
		hasMeat   bool
		hasVeg    bool
		overrides map[string]string
	}{
		{name: "香菜末"}, {name: "芫荽段"}, {name: "芜荽"}, {name: "芜荽末"},
		{name: "干辣椒段"}, {name: "干红辣椒碎"}, {name: "小米椒碎"},
		{name: "蒜泥"}, {name: "小葱段"}, {name: "大蒜片"},
		{name: "青椒丝", hasVeg: true}, {name: "洋葱丝", hasVeg: true},
		{name: "蒜苗段", hasVeg: true}, {name: "蒜苔", hasVeg: true},
		{name: "干香菇片", hasVeg: true}, {name: "油麦菜段", hasVeg: true},
		{name: "鸡蛋"}, {name: "豆腐", hasVeg: true},
		{name: "鸡精"}, {name: "猪油"}, {name: "鱼露"}, {name: "豆豉"},
		{name: "豆豉鲮鱼罐头", hasMeat: true},
		{name: "黄辣丁块", hasMeat: true},
		{name: "东北油豆角段", hasVeg: true},
		{name: "豆豉鲮鱼罐头", overrides: map[string]string{"豆豉鲮鱼罐头": "配料"}},
		{name: "油麦菜段", overrides: map[string]string{"油麦菜段": "其他"}},
		{name: "自种食材", hasVeg: true, overrides: map[string]string{"自种食材": "蔬菜"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal([]string{tc.name})
			if err != nil {
				t.Fatal(err)
			}
			info := classifyDishBalance(models.Dish{Ingredients: string(raw)}, tc.overrides)
			if info.hasMeat != tc.hasMeat || (len(info.vegKinds) > 0) != tc.hasVeg {
				t.Fatalf("balance = %+v, want meat=%v hasVeg=%v", info, tc.hasMeat, tc.hasVeg)
			}
		})
	}
}

func TestDietBalanceCondimentsDoNotCountAsVegetableMeal(t *testing.T) {
	dish := models.Dish{ID: 1, Ingredients: `["猪肉", "干辣椒段", "香菜末", "蒜泥"]`}
	b := buildDietBalance(
		[]models.MealRecord{{DishID: 1, MealDate: "2026-11-07", MealType: "dinner"}},
		map[uint]models.Dish{1: dish}, nil,
	)
	if b.MixedCount != 0 || b.MeatCount != 1 || b.VegCount != 0 || b.Meals != 1 || b.MealsWithVeg != 0 || len(b.Vegetables) != 0 {
		t.Fatalf("condiments should not count as a vegetable meal: %+v", b)
	}
}
