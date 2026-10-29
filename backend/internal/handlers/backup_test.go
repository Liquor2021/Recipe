package handlers

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestDownloadBackupReturnsUsableDatabase(t *testing.T) {
	setupHandlerTestDB(t, &models.MealRecord{})
	database.DB.Create(&models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: "2026-10-28"})

	w := serveJSON(t, DownloadBackup, "GET", "/api/admin/backup/download", nil)
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Disposition"), "ninimenu-") {
		t.Fatalf("应返回数据库文件下载, got %d %v", w.Code, w.Header())
	}
	// 下载内容是完整可用的 SQLite 数据库
	path := filepath.Join(t.TempDir(), "downloaded.db")
	if err := os.WriteFile(path, w.Body.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	}()
	var n int64
	db.Model(&models.MealRecord{}).Count(&n)
	if n != 1 {
		t.Fatalf("下载的备份里应有 1 条记录, got %d", n)
	}
}
