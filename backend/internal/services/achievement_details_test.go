package services

import (
	"ninimenu/internal/achievements"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
	"time"
)

func setupAchievementDetailsTest(t *testing.T) {
	cancelQueuedAutoAchievementSync()
	setupTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.DayRating{}, &models.ShoppingItemCategory{}, &models.Favorite{}, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.AchievementEvent{}, &models.Achievement{}, &models.UserAchievement{})
	defaults := achievements.DefaultAchievements()
	if err := database.DB.Create(&defaults).Error; err != nil {
		t.Fatal(err)
	}
	achievementSyncMu.Lock()
	achievementSourceIDs = map[uint]bool{}
	achievementSyncMu.Unlock()
	t.Cleanup(cancelQueuedAutoAchievementSync)
}

func TestAchievementProgressCoversCatalogAndUsesDishUnits(t *testing.T) {
	progress := measureAchievementProgress(achievementSnapshot{totalRecords: 10, distinctDishes: map[uint]bool{1: true}, mealCounts: map[string]int{"lunch": 5}, longestDateStreak: 2})
	for _, a := range achievements.DefaultAchievements() {
		p, ok := progress[a.Code]
		if !ok || p.Target <= 0 || p.Unit == "" {
			t.Errorf("成就缺少有效进度: %s %+v", a.Code, p)
		}
	}
	if p := progress["record_100"]; p.Current != 10 || p.Target != 100 || p.Unit != "道" {
		t.Fatal(p)
	}
	if p := progress["distinct_3"]; p.Current != 1 {
		t.Fatalf("重复做同道菜不能增加尝鲜进度: %+v", p)
	}
	if p := progress["lunch_5"]; p.Current != 5 || p.Unit != "道" {
		t.Fatalf("午餐成就现有规则按菜品记录数计量，不能显示为顿: %+v", p)
	}
	if evaluateAchievementCodes(achievementSnapshot{totalRecords: 9})["record_10"] {
		t.Fatal("未达到阈值提前解锁")
	}
}

func TestAchievementEstimateNeedsRecentDaysAndApplicableGoal(t *testing.T) {
	p := AchievementProgress{Current: 10, Target: 100, Series: "下厨记录"}
	s := achievementSnapshot{recentRecords: 10, recentDays: 4}
	if e := estimateAchievement(p, s); e == nil || e.Days != 126 || e.WindowDays != 14 {
		t.Fatal(e)
	}
	s.recentDays = 1
	if estimateAchievement(p, s) != nil {
		t.Fatal("一天补录不能外推节奏")
	}
	s.recentDays = 4
	p.Series = "连续开饭"
	if estimateAchievement(p, s) != nil {
		t.Fatal("连续天数不能按菜品数预测")
	}
}

func TestAchievementSourceIsPersistedOnlyAtVerifiedUnlock(t *testing.T) {
	setupAchievementDetailsTest(t)
	now := time.Now()
	record := models.MealRecord{DishID: 1, DishName: "蒜蓉西兰花", MealDate: TodayDate(), MealType: "lunch", Status: models.MealCompleted, CreatedAt: now}
	if err := database.DB.Create(&record).Error; err != nil {
		t.Fatal(err)
	}
	QueueAutoAchievementSync(record.ID)
	SyncAutoAchievements()
	var a models.Achievement
	database.DB.Where("code = ?", "first_pick").First(&a)
	detail, err := GetAchievementDetails(a)
	if err != nil {
		t.Fatal(err)
	}
	if !detail.IsUnlocked || detail.Source == nil || detail.Source.RecordID != record.ID || detail.Source.DishName != record.DishName || !detail.Source.Available {
		t.Fatalf("没有保存真实解锁来源: %+v", detail)
	}
	if len(detail.Series) != 7 {
		t.Fatalf("做菜系列应有7枚: %+v", detail.Series)
	}
	var legacy models.Achievement
	database.DB.Where("code = ?", "record_3").First(&legacy)
	database.DB.Create(&models.UserAchievement{AchievementID: legacy.ID, UnlockedAt: now})
	old, err := GetAchievementDetails(legacy)
	if err != nil || old.Source != nil {
		t.Fatalf("不能用最近菜品伪造历史出处: %+v %v", old, err)
	}
	database.DB.Model(&record).Update("status", models.MealPlanned)
	changed, err := GetAchievementDetails(a)
	if err != nil || !changed.IsUnlocked || changed.Source == nil || changed.Source.Available || changed.Source.DishName != "蒜蓉西兰花" || changed.Progress.Current != 0 {
		t.Fatalf("撤销后保留历史解锁和出处，但不能显示原记录可用: %+v %v", changed, err)
	}
}

func TestAchievementAmbiguousBatchHasNoInventedSource(t *testing.T) {
	setupAchievementDetailsTest(t)
	records := []models.MealRecord{
		{DishID: 1, DishName: "菜一", MealDate: TodayDate(), MealType: "lunch", Status: models.MealCompleted},
		{DishID: 2, DishName: "菜二", MealDate: TodayDate(), MealType: "lunch", Status: models.MealCompleted},
	}
	database.DB.Create(&records)
	QueueAutoAchievementSync(records[0].ID, records[1].ID)
	SyncAutoAchievements()
	var award models.UserAchievement
	database.DB.First(&award)
	if award.ID == 0 || award.SourceRecordID != 0 {
		t.Fatalf("合并多个完成事件不能硬指定一顿为来源: %+v", award)
	}
}

func TestAchievementDetailsDoesNotTurnReadFailureIntoZero(t *testing.T) {
	setupAchievementDetailsTest(t)
	var a models.Achievement
	database.DB.Where("code = ?", "record_100").First(&a)
	database.DB.Migrator().DropTable(&models.MealRecord{})
	if _, err := GetAchievementDetails(a); err == nil {
		t.Fatal("读取失败不能显示为零进度")
	}
}
