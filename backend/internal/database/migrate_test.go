package database

import (
	"ninimenu/internal/config"
	"ninimenu/internal/models"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// createLegacyMealRecordsDB 建一个"旧版本"库：meal_records 表里有 3 条同菜同餐同日的重复记录
// （各自带不同的评分/备注/照片/心情）+ 1 条正常记录；withPlainIndex 模拟早期版本已建好的同名普通索引
func createLegacyMealRecordsDB(t *testing.T, withPlainIndex bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		// 单行 DDL：与 GORM 建表生成的格式一致（GORM 的 SQLite 迁移器会解析这段 DDL，换行缩进会干扰解析）
		`CREATE TABLE meal_records (id integer PRIMARY KEY AUTOINCREMENT, dish_id integer NOT NULL, dish_name text NOT NULL, meal_type text NOT NULL, meal_date text NOT NULL, rating integer DEFAULT 0, remark text, mood text, photo text, created_at datetime)`,
		`INSERT INTO meal_records (dish_id, dish_name, meal_type, meal_date, rating, remark, mood, photo) VALUES
			(1, '番茄炒蛋', 'lunch', '2026-10-01', 0, '第一次做', '', ''),
			(1, '番茄炒蛋', 'lunch', '2026-10-01', 4, '', 'yum', '/uploads/a.jpg'),
			(1, '番茄炒蛋', 'lunch', '2026-10-01', 2, '有点咸', 'ok', '/uploads/b.jpg'),
			(2, '红烧排骨', 'dinner', '2026-10-01', 5, '', '', '')`,
	}
	if withPlainIndex {
		stmts = append(stmts, `CREATE INDEX idx_meal_records_unique_day ON meal_records(dish_id, meal_type, meal_date)`)
	}
	for _, s := range stmts {
		if err := db.Exec(s).Error; err != nil {
			t.Fatal(err)
		}
	}
	sqlDB, _ := db.DB()
	sqlDB.Close()
	return path
}

// runInit 用指定库文件跑一遍真实启动流程 Init()
func runInit(t *testing.T, path string) {
	t.Helper()
	old := config.C.DBPath
	config.C.DBPath = path
	t.Cleanup(func() {
		config.C.DBPath = old
		if DB != nil {
			if sqlDB, err := DB.DB(); err == nil {
				sqlDB.Close()
			}
			DB = nil
		}
	})
	if err := Init(); err != nil {
		t.Fatalf("旧库升级启动失败: %v", err)
	}
}

func assertMergedLegacyRecords(t *testing.T, db *gorm.DB) {
	t.Helper()
	unique, err := indexIsUnique(db, "meal_records", mealRecordUniqueIndex)
	if err != nil || !unique {
		t.Fatalf("升级后应为唯一索引, unique=%v err=%v", unique, err)
	}
	var records []models.MealRecord
	db.Order("id ASC").Find(&records)
	if len(records) != 2 {
		t.Fatalf("3 条重复应合并为 1 条，共剩 2 条, got %d", len(records))
	}
	keeper := records[0]
	// 最早一条为准：评分/照片/心情补空缺（取第一条非空），不同备注拼接保留
	if keeper.ID != 1 || keeper.Rating != 4 || keeper.Photo != "/uploads/a.jpg" || keeper.Mood != "yum" || keeper.Remark != "第一次做；有点咸" {
		t.Fatalf("合并结果不符: %+v", keeper)
	}
	var backedUp int64
	db.Raw("SELECT count(*) FROM meal_records_dedup_backup").Scan(&backedUp)
	if backedUp != 3 {
		t.Fatalf("涉及重复的 3 条原始行都应备份, got %d", backedUp)
	}
	dup := models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: "2026-10-01"}
	if err := db.Create(&dup).Error; err == nil {
		t.Fatalf("唯一索引应拦截新的重复记录")
	}
}

func TestInitUpgradesLegacyDuplicatesWithoutIndex(t *testing.T) {
	// DeepSeek 复现场景：旧库没有同名索引 + 有重复记录。过去 AutoMigrate 抢先建唯一索引直接启动失败
	runInit(t, createLegacyMealRecordsDB(t, false))
	assertMergedLegacyRecords(t, DB)
}

func TestInitUpgradesLegacyDuplicatesWithPlainIndex(t *testing.T) {
	runInit(t, createLegacyMealRecordsDB(t, true))
	assertMergedLegacyRecords(t, DB)
}

func openMigratedLegacyDB(t *testing.T, withPlainIndex bool) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(createLegacyMealRecordsDB(t, withPlainIndex)), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
	// 与 Init 相同的顺序：先 AutoMigrate（只会建普通索引），再升级唯一索引
	if err := db.AutoMigrate(&models.MealRecord{}); err != nil {
		t.Fatalf("AutoMigrate 不应因重复数据失败: %v", err)
	}
	return db
}

func TestMigrateMealRecordUniqueIndexRollsBackOnFailure(t *testing.T) {
	db := openMigratedLegacyDB(t, true)
	// 让合并中的删除步骤失败：整个事务（备份、合并、删除、建索引）必须一起回滚
	if err := db.Exec(`CREATE TRIGGER block_delete BEFORE DELETE ON meal_records BEGIN SELECT RAISE(ABORT, 'blocked'); END`).Error; err != nil {
		t.Fatal(err)
	}
	migrateMealRecordUniqueIndex(db)

	if unique, _ := indexIsUnique(db, "meal_records", mealRecordUniqueIndex); unique {
		t.Fatalf("失败时不应留下唯一索引")
	}
	var plainIndex int64
	db.Raw("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?", mealRecordUniqueIndex).Scan(&plainIndex)
	if plainIndex != 1 {
		t.Fatalf("失败回滚后原普通索引应保留")
	}
	var records []models.MealRecord
	db.Order("id ASC").Find(&records)
	if len(records) != 4 || records[0].Remark != "第一次做" || records[0].Rating != 0 {
		t.Fatalf("失败回滚后数据应原样保留, got %+v", records)
	}
	var backupTables int64
	db.Raw("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'meal_records_dedup_backup'").Scan(&backupTables)
	if backupTables != 0 {
		t.Fatalf("备份表也应随事务回滚")
	}
}

func TestMigrateMealRecordUniqueIndexIdempotent(t *testing.T) {
	db := openMigratedLegacyDB(t, false)
	migrateMealRecordUniqueIndex(db)
	migrateMealRecordUniqueIndex(db) // 第二次：已是唯一索引，直接跳过

	var backedUp int64
	db.Raw("SELECT count(*) FROM meal_records_dedup_backup").Scan(&backedUp)
	if backedUp != 3 {
		t.Fatalf("重复执行不应再次备份, got %d", backedUp)
	}
	var n int64
	db.Model(&models.MealRecord{}).Count(&n)
	if n != 2 {
		t.Fatalf("重复执行不应改变数据, got %d", n)
	}
}

func TestMigrateMealRecordUniqueIndexFreshDB(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "fresh.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&models.MealRecord{}); err != nil {
		t.Fatal(err)
	}
	migrateMealRecordUniqueIndex(db)
	if unique, err := indexIsUnique(db, "meal_records", mealRecordUniqueIndex); err != nil || !unique {
		t.Fatalf("新库也应得到唯一索引, unique=%v err=%v", unique, err)
	}
	var backupTables int64
	db.Raw("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'meal_records_dedup_backup'").Scan(&backupTables)
	if backupTables != 0 {
		t.Fatalf("没有重复数据时不应创建备份表")
	}
}
