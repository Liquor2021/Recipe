package services

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
	"time"
)

func TestDietReportAndAchievementsUseOnlyCompletedMeals(t *testing.T) {
	setupTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.DayRating{}, &models.ShoppingItemCategory{},
		&models.Favorite{}, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.AchievementEvent{})
	db := database.DB
	today := TodayDate()
	old := time.Now().AddDate(0, -2, 0).Format("2006-01-02")
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	for _, dish := range []models.Dish{
		{ID: 1, Name: "番茄炒蛋", Ingredients: `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"}]`, Category: "家常菜"},
		{ID: 2, Name: "红烧肉", Ingredients: `[{"name":"五花肉","amount":"500g"}]`, Category: "家常菜"},
	} {
		db.Create(&dish)
	}
	for _, record := range []models.MealRecord{
		{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: today, Status: models.MealCompleted},
		{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: old, Status: models.MealPlanned},
		{DishID: 2, DishName: "红烧肉", MealType: "dinner", MealDate: today, Status: models.MealCancelled},
		{DishID: 2, DishName: "红烧肉", MealType: "lunch", MealDate: today, Status: models.MealPlanned},
		{DishID: 2, DishName: "红烧肉", MealType: "lunch", MealDate: tomorrow, Status: models.MealCompleted},
	} {
		db.Create(&record)
	}
	db.Create(&models.DayRating{MealDate: today, HomeMood: "happy", Mood: "yum", Photos: `["/uploads/done.jpg"]`})
	db.Create(&models.DayRating{MealDate: old, HomeMood: "happy", Mood: "no", Photos: `["/uploads/plan.jpg"]`})
	db.Create(&models.DayRating{MealDate: tomorrow, HomeMood: "happy", Mood: "yum", Photos: `["/uploads/future.jpg"]`})
	report := GetDietReport("month")
	if report.TotalMeals != 1 || report.CookDays != 1 || report.NewDishRate != 100 || report.DistinctDishes != 1 {
		t.Fatalf("计划/取消/未来记录混入了报告或首次吃统计: %+v", report)
	}
	if report.Balance.MeatCount != 0 || report.Balance.VegCount != 1 {
		t.Fatalf("报告荤素只统计已完成: %+v", report.Balance)
	}
	snapshot := buildAchievementSnapshot()
	if snapshot.totalRecords != 1 || snapshot.photoCount != 1 || snapshot.photoDays != 1 || snapshot.dayRatingCount != 1 {
		t.Fatalf("成就快照混入计划或其照片/评价: %+v", snapshot)
	}
	if snapshot.homeMoodCounts["happy"] != 2 {
		t.Fatalf("首页心情不要求完成用餐，但不能提前计算未来心情: %+v", snapshot.homeMoodCounts)
	}
}

func TestRecommendationRecencyIgnoresCancelledPlans(t *testing.T) {
	setupTestDB(t, &models.MealRecord{})
	for i, status := range []string{models.MealPlanned, models.MealCompleted, models.MealCancelled} {
		database.DB.Create(&models.MealRecord{DishID: uint(i + 1), DishName: "菜", MealType: "dinner", MealDate: TodayDate(), Status: status})
	}
	recent := recentDishIDMap(3)
	if !recent[1] || !recent[2] || recent[3] {
		t.Fatalf("近期去重应保留计划/完成并排除取消: %v", recent)
	}
}
