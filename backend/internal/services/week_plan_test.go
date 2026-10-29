package services

import (
	"encoding/json"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
	"time"
)

// setupWeekPlanTestDB 周菜单/推荐相关单测的临时库，并清掉包级周菜单缓存
func setupWeekPlanTestDB(t *testing.T) {
	t.Helper()
	setupTestDB(t, &models.Dish{}, &models.Setting{}, &models.InventoryBatch{}, &models.MealRecord{})
	resetWeekPlanCache := func() {
		weekPlanMu.Lock()
		cachedRecord = nil
		weekPlanMu.Unlock()
	}
	resetWeekPlanCache()
	t.Cleanup(resetWeekPlanCache)
}

// seedPlanDishes 6 道清淡菜（id 1-6）+ 4 道辣菜（id 7-10），午晚餐通用
func seedPlanDishes(t *testing.T) {
	t.Helper()
	for i := 1; i <= 10; i++ {
		d := models.Dish{ID: uint(i), Name: "清淡菜", Taste: "清淡", MealType: "all", Enabled: true, Ingredients: `[{"name":"青菜","amount":"1把"}]`}
		if i > 6 {
			d.Name, d.Taste = "辣菜", "香辣"
		}
		if err := database.DB.Create(&d).Error; err != nil {
			t.Fatalf("写入菜品失败: %v", err)
		}
	}
}

func setStrictSpicyDislike(t *testing.T) {
	t.Helper()
	seedSetting(t, "family_members", `[{"name":"妈妈","dislikes":["辣"]}]`)
	seedSetting(t, "family_dislike_mode", "strict")
}

func planDishIDs(p *WeekPlan) []uint {
	var ids []uint
	for _, d := range p.Days {
		for _, x := range d.Lunch {
			ids = append(ids, x.ID)
		}
		for _, x := range d.Dinner {
			ids = append(ids, x.ID)
		}
	}
	return ids
}

func planHas(p *WeekPlan, id uint) bool {
	for _, x := range planDishIDs(p) {
		if x == id {
			return true
		}
	}
	return false
}

// weekDates 本周一起 7 天的日期（与 getCurrentWeekKey 口径一致）
func weekDates() []string {
	now := time.Now()
	weekday := int(now.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	monday := now.AddDate(0, 0, 1-weekday)
	dates := make([]string, 7)
	for i := range dates {
		dates[i] = monday.AddDate(0, 0, i).Format("2006-01-02")
	}
	return dates
}

// seedWeekPlanRecord 直接写一份本周缓存：每天午餐 lunchID、晚餐 dinnerID
func seedWeekPlanRecord(t *testing.T, lunchID, dinnerID uint) {
	t.Helper()
	rec := weekPlanRecord{LunchCount: 1, DinnerCount: 1}
	for _, date := range weekDates() {
		rec.Days = append(rec.Days, weekPlanRecordDay{Date: date, DayName: "周", Lunch: []weekPlanRef{{ID: lunchID}}, Dinner: []weekPlanRef{{ID: dinnerID}}})
	}
	data, _ := json.Marshal(rec)
	if err := database.DB.Create(&models.Setting{Key: "week_plan_cache", Value: string(data)}).Error; err != nil {
		t.Fatalf("写入周菜单缓存失败: %v", err)
	}
}

func TestGenerateWeekPlanStrictExcludesDislikes(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	setStrictSpicyDislike(t)

	plan := GetCachedWeekPlan()
	if len(plan.Days) != 7 {
		t.Fatalf("应生成 7 天菜单, got %d", len(plan.Days))
	}
	for _, id := range planDishIDs(plan) {
		if id > 6 {
			t.Fatalf("strict 忌口辣，周菜单不应出现辣菜 id=%d, got %v", id, planDishIDs(plan))
		}
	}
}

func TestWeekPlanCacheSurvivesRestart(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	seedWeekPlanRecord(t, 3, 4)

	// 模拟进程重启：内存缓存为空，只能从 settings 读回
	plan := GetCachedWeekPlan()
	for _, d := range plan.Days {
		if len(d.Lunch) != 1 || d.Lunch[0].ID != 3 || len(d.Dinner) != 1 || d.Dinner[0].ID != 4 {
			t.Fatalf("重启后应读回已存的菜单（午 3 / 晚 4），而不是重新生成, got %v", planDishIDs(plan))
		}
	}
	// 读回的是最新菜品信息
	if plan.Days[0].Lunch[0].Name != "清淡菜" || plan.Days[0].Lunch[0].Ingredients == "" {
		t.Fatalf("应按 ID 回库取完整菜品, got %+v", plan.Days[0].Lunch[0])
	}
}

func TestWeekPlanCacheReadsLegacyFormat(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	// 旧版缓存：存的是完整菜品对象（ingredients 等是 JSON 数组），过去因此从未被读回过
	var d3, d4 models.Dish
	database.DB.First(&d3, 3)
	database.DB.First(&d4, 4)
	legacy := WeekPlan{}
	for _, date := range weekDates() {
		legacy.Days = append(legacy.Days, WeekDayPlan{Date: date, DayName: "周", Lunch: []models.Dish{d3}, Dinner: []models.Dish{d4}})
	}
	data, _ := json.Marshal(legacy)
	database.DB.Create(&models.Setting{Key: "week_plan_cache", Value: string(data)})

	plan := GetCachedWeekPlan()
	if len(plan.Days) != 7 || plan.Days[0].Lunch[0].ID != 3 || plan.Days[6].Dinner[0].ID != 4 {
		t.Fatalf("旧格式缓存应能读回, got %v", planDishIDs(plan))
	}
}

func TestWeekPlanLegacyFormatChecksDailyCounts(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	// 旧格式缓存没有 lunch_count/dinner_count 字段（每天午 1 晚 1）
	legacy := map[string]any{"days": []map[string]any{}}
	days := []map[string]any{}
	for _, date := range weekDates() {
		days = append(days, map[string]any{"date": date, "day_name": "周", "lunch": []map[string]any{{"id": 3}}, "dinner": []map[string]any{{"id": 4}}})
	}
	legacy["days"] = days
	data, _ := json.Marshal(legacy)
	database.DB.Create(&models.Setting{Key: "week_plan_cache", Value: string(data)})
	seedSetting(t, "lunch_dishes_per_day", "2")

	plan := GetCachedWeekPlan()
	if len(plan.Days) != 7 || len(plan.Days[0].Lunch) != 2 {
		t.Fatalf("旧格式缓存的每天道数与当前设置不符时应重排, got lunch=%d", len(plan.Days[0].Lunch))
	}
}

func TestGenerateWeekPlanAvoidModeDownweightsDislikes(t *testing.T) {
	setupWeekPlanTestDB(t)
	// 20 道清淡 + 20 道辣菜：均匀抽取时辣菜约占一半，温和降权后应明显变少但不为零
	for i := 1; i <= 40; i++ {
		d := models.Dish{ID: uint(i), Name: "清淡菜", Taste: "清淡", MealType: "all", Enabled: true}
		if i > 20 {
			d.Name, d.Taste = "辣菜", "香辣"
		}
		database.DB.Create(&d)
	}
	cfg := weekPlanConfig{lunchCount: 1, dinnerCount: 1, dislikes: familyDislikeConfig{tokens: map[string]bool{"辣": true}}}
	spicy, total := 0, 0
	for run := 0; run < 60; run++ {
		for _, id := range planDishIDs(generateWeekPlan(cfg)) {
			total++
			if id > 20 {
				spicy++
			}
		}
	}
	// 权重 1:3 不放回抽 14 道，期望辣菜约 21%；均匀抽取约 50%
	frac := float64(spicy) / float64(total)
	if total != 60*14 || frac > 0.35 || frac < 0.05 {
		t.Fatalf("avoid 周菜单辣菜占比应明显低于均匀抽取的 50%% 且不为零, got %.3f (%d/%d)", frac, spicy, total)
	}
}

func TestPickDishesStrictFilterBeforeRecency(t *testing.T) {
	setupWeekPlanTestDB(t)
	// A 是辣菜但最近没吃；B 合规但昨天刚吃过
	database.DB.Create(&models.Dish{ID: 1, Name: "辣子鸡", Taste: "香辣", MealType: "all", Enabled: true})
	database.DB.Create(&models.Dish{ID: 2, Name: "清炒时蔬", Taste: "清淡", MealType: "all", Enabled: true})
	database.DB.Create(&models.MealRecord{DishID: 2, DishName: "清炒时蔬", MealType: "dinner", MealDate: dateFromNow(-1)})
	setStrictSpicyDislike(t)

	dishes, err := PickDishes("lunch", 1, true)
	if err != nil || len(dishes) != 1 || dishes[0].ID != 2 {
		t.Fatalf("先按 strict 忌口过滤，再去掉最近吃过；去完为空应退回合规菜 B, got %v err=%v", namesOf(dishes), err)
	}
}

func TestWeekPlanRegeneratesWhenDishDisabled(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	seedWeekPlanRecord(t, 1, 2)
	database.DB.Model(&models.Dish{}).Where("id = ?", 1).Update("enabled", false)

	plan := GetCachedWeekPlan()
	if len(plan.Days) != 7 || planHas(plan, 1) {
		t.Fatalf("菜单里有菜被停用应重新生成且不含该菜, got %v", planDishIDs(plan))
	}
}

func TestWeekPlanRegeneratesWhenStrictDislikeAdded(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	seedWeekPlanRecord(t, 1, 8) // 晚餐是辣菜
	if p := GetCachedWeekPlan(); !planHas(p, 8) {
		t.Fatalf("未设忌口时缓存应原样有效, got %v", planDishIDs(p))
	}

	// 改成 strict 忌口辣：缓存里的辣菜必须让整份菜单失效重排
	setStrictSpicyDislike(t)
	plan := GetCachedWeekPlan()
	if len(plan.Days) != 7 {
		t.Fatalf("应重新生成 7 天, got %d", len(plan.Days))
	}
	for _, id := range planDishIDs(plan) {
		if id > 6 {
			t.Fatalf("切到 strict 后不应再出现辣菜 id=%d", id)
		}
	}
}

func TestWeekPlanRegeneratesWhenMealCountChanged(t *testing.T) {
	setupWeekPlanTestDB(t)
	seedPlanDishes(t)
	seedWeekPlanRecord(t, 1, 2)
	seedSetting(t, "lunch_dishes_per_day", "2")

	plan := GetCachedWeekPlan()
	if len(plan.Days) != 7 || len(plan.Days[0].Lunch) != 2 {
		t.Fatalf("午餐道数改为 2 后应重新生成, got lunch=%d", len(plan.Days[0].Lunch))
	}
	if cachedRecord == nil || cachedRecord.LunchCount != 2 {
		t.Fatalf("新缓存应记录生成时的道数, got %+v", cachedRecord)
	}
}

func TestWeekPlanStrictEmptyDoesNotFallBackToStale(t *testing.T) {
	setupWeekPlanTestDB(t)
	for i := 1; i <= 3; i++ {
		database.DB.Create(&models.Dish{ID: uint(i), Name: "辣菜", Taste: "麻辣", MealType: "all", Enabled: true})
	}
	seedWeekPlanRecord(t, 1, 2)
	if p := GetCachedWeekPlan(); len(p.Days) != 7 {
		t.Fatalf("前置：缓存应有效")
	}

	// 全部菜都命中 strict 忌口：宁可空菜单，也不能退回含忌口菜的旧缓存
	setStrictSpicyDislike(t)
	if p := GetCachedWeekPlan(); len(p.Days) != 0 {
		t.Fatalf("strict 全部过滤后应返回空菜单, got %v", planDishIDs(p))
	}
	if p := RegenerateWeekPlan(); len(p.Days) != 0 {
		t.Fatalf("手动重新生成也不能退回旧菜单, got %v", planDishIDs(p))
	}
}

func TestPreferNonDisliked(t *testing.T) {
	spicy := models.Dish{ID: 1, Name: "辣子鸡", Taste: "香辣"}
	plain := models.Dish{ID: 2, Name: "清炒时蔬", Taste: "清淡"}
	tokens := map[string]bool{"辣": true}

	for _, strict := range []bool{true, false} {
		got := preferNonDisliked([]models.Dish{spicy, plain}, familyDislikeConfig{tokens: tokens, strict: strict})
		if len(got) != 1 || got[0].ID != 2 {
			t.Fatalf("strict=%v：有非忌口菜时应只留非忌口菜, got %v", strict, namesOf(got))
		}
	}
	if got := preferNonDisliked([]models.Dish{spicy}, familyDislikeConfig{tokens: tokens, strict: true}); len(got) != 0 {
		t.Fatalf("strict 全部命中应返回空, got %v", namesOf(got))
	}
	if got := preferNonDisliked([]models.Dish{spicy}, familyDislikeConfig{tokens: tokens}); len(got) != 1 {
		t.Fatalf("avoid 全部命中应退回原候选（忌口不能把推荐清空）, got %v", namesOf(got))
	}
	if got := preferNonDisliked([]models.Dish{spicy, plain}, familyDislikeConfig{strict: true}); len(got) != 2 {
		t.Fatalf("未配置忌口不过滤, got %v", namesOf(got))
	}
}

func TestPickMoodDishesFiltersBeforeEmptyCheck(t *testing.T) {
	setupWeekPlanTestDB(t)
	// 心情"想吃辣"的池子里只有一道辣菜
	database.DB.Create(&models.Dish{ID: 1, Name: "辣子鸡", Taste: "辣", MealType: "all", Enabled: true})
	database.DB.Create(&models.Dish{ID: 2, Name: "清炒时蔬", Taste: "清淡", MealType: "all", Enabled: true})
	seedSetting(t, "family_members", `[{"name":"妈妈","dislikes":["辣"]}]`)

	// avoid：心情池全命中忌口时退回原候选，用户点名要辣就给辣
	dishes, scene := PickMoodDishes("spicy", 3)
	if len(dishes) != 1 || dishes[0].ID != 1 || scene != "lunch" {
		t.Fatalf("avoid 下应仍推荐辣菜, got %v scene=%q", namesOf(dishes), scene)
	}

	// strict：心情池被滤空后退回普通推荐（同样 strict 过滤），不能返回空数组当成功
	database.DB.Create(&models.Setting{Key: "family_dislike_mode", Value: "strict"})
	dishes, scene = PickMoodDishes("spicy", 3)
	if len(dishes) != 1 || dishes[0].ID != 2 || scene != "" {
		t.Fatalf("strict 下应退回普通推荐且不含辣菜, got %v scene=%q", namesOf(dishes), scene)
	}
}

func TestMatchFridgeRecipesStrictDislike(t *testing.T) {
	setupWeekPlanTestDB(t)
	database.DB.Create(&models.Dish{ID: 1, Name: "辣炒鸡蛋", Taste: "香辣", Enabled: true, Ingredients: `[{"name":"鸡蛋","amount":"3个"}]`})
	database.DB.Create(&models.Dish{ID: 2, Name: "蒸蛋", Taste: "清淡", Enabled: true, Ingredients: `[{"name":"鸡蛋","amount":"2个"}]`})
	database.DB.Create(&models.InventoryBatch{ItemName: "鸡蛋", InStock: true})
	seedSetting(t, "family_members", `[{"name":"妈妈","dislikes":["辣"]}]`)

	if got := MatchFridgeRecipes(12); len(got) != 2 {
		t.Fatalf("avoid 下清冰箱推荐不过滤, got %v", matchNames(got))
	}
	database.DB.Create(&models.Setting{Key: "family_dislike_mode", Value: "strict"})
	got := MatchFridgeRecipes(12)
	if len(got) != 1 || got[0].Dish.ID != 2 {
		t.Fatalf("strict 下清冰箱推荐不应出现忌口菜, got %v", matchNames(got))
	}
}
