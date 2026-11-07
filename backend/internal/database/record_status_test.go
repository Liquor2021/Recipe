package database

import (
	"ninimenu/internal/models"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestMealRecordStatusMigrationDoesNotCompletePlansOnRestart(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(createLegacyMealRecordsDB(t, false)), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.Exec("INSERT INTO meal_records (dish_id, dish_name, meal_type, meal_date) VALUES (3, '未来计划', 'lunch', '2026-10-02')").Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateMealRecordStatus(db, "2026-10-01"); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&models.MealRecord{}); err != nil {
		t.Fatal(err)
	}
	newPlan := models.MealRecord{DishID: 4, DishName: "新计划", MealType: "dinner", MealDate: "2026-10-01"}
	if err := db.Create(&newPlan).Error; err != nil {
		t.Fatal(err)
	}
	// 模拟几天后重启；旧未来计划、新的过期计划都必须继续保持待做。
	if err := migrateMealRecordStatus(db, "2026-10-05"); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&models.MealRecord{}); err != nil {
		t.Fatal(err)
	}
	var rows []models.MealRecord
	if err := db.Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 6 {
		t.Fatalf("记录数改变: %d", len(rows))
	}
	for _, r := range rows {
		want := models.MealCompleted
		if r.DishID >= 3 {
			want = models.MealPlanned
		}
		if r.Status != want || r.PortionScale != 1 {
			t.Fatalf("迁移/重启状态或原量错误: %+v, status want %s", r, want)
		}
	}
}

func TestMealRecordStatusMigrationRollsBackColumnOnFailure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(createLegacyMealRecordsDB(t, false)), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.Exec("CREATE TRIGGER block_state BEFORE UPDATE ON meal_records BEGIN SELECT RAISE(ABORT, 'blocked'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateMealRecordStatus(db, "2026-10-01"); err == nil {
		t.Fatal("回填失败必须返回错误")
	}
	if db.Migrator().HasColumn(&models.MealRecord{}, "status") {
		t.Fatal("回填失败也必须回滚新列，以便重启可重试")
	}
	if err := db.Exec("DROP TRIGGER block_state").Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateMealRecordStatus(db, "2026-10-01"); err != nil {
		t.Fatal(err)
	}
}
