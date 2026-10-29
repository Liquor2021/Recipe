package database

import (
	"ninimenu/internal/models"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func openTestDB(t *testing.T, path string) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
	return db
}

func TestDailyBackupCreatesSkipsAndPrunes(t *testing.T) {
	dir := t.TempDir()
	db := openTestDB(t, filepath.Join(dir, "live.db"))
	if err := db.AutoMigrate(&models.MealRecord{}); err != nil {
		t.Fatal(err)
	}
	db.Create(&models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: "2026-10-28"})
	backups := filepath.Join(dir, "backups")
	day := time.Date(2026, 10, 28, 9, 0, 0, 0, time.Local)

	path, err := DailyBackup(db, backups, 3, day)
	if err != nil || filepath.Base(path) != "ninimenu-2026-10-28.db" {
		t.Fatalf("应备份成今天的文件, got %q %v", path, err)
	}
	// 备份是完整可用的数据库（看完马上关掉：Windows 下打开着的文件删不掉，会影响后面的清理）
	copyDB, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	copyDB.Model(&models.MealRecord{}).Count(&n)
	if sqlDB, err := copyDB.DB(); err == nil {
		sqlDB.Close()
	}
	if n != 1 {
		t.Fatalf("备份里应有 1 条记录, got %d", n)
	}

	// 同一天再跑：不重复备份
	if again, err := DailyBackup(db, backups, 3, day.Add(5*time.Hour)); err != nil || again != "" {
		t.Fatalf("同一天不应重复备份, got %q %v", again, err)
	}

	// 连续 4 天：只保留最新 3 份
	for i := 1; i <= 3; i++ {
		if _, err := DailyBackup(db, backups, 3, day.AddDate(0, 0, i)); err != nil {
			t.Fatal(err)
		}
	}
	files, err := ListBackups(backups)
	if err != nil || len(files) != 3 || files[0].Name != "ninimenu-2026-10-31.db" || files[2].Name != "ninimenu-2026-10-29.db" {
		t.Fatalf("应只保留最新 3 份且最新在前, got %+v %v", files, err)
	}
	if _, err := os.Stat(filepath.Join(backups, "ninimenu-2026-10-28.db.tmp")); !os.IsNotExist(err) {
		t.Fatalf("不应留下临时文件")
	}
}

func TestListBackupsMissingDir(t *testing.T) {
	files, err := ListBackups(filepath.Join(t.TempDir(), "nope"))
	if err != nil || len(files) != 0 {
		t.Fatalf("目录不存在时应返回空列表, got %v %v", files, err)
	}
}
