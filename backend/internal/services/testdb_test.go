package services

import (
	"ninimenu/internal/database"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupTestDB 为单测准备独立的临时文件 SQLite 并迁移给定模型
// （内存库在连接池多连接下会各开一个空库，不可靠）
func setupTestDB(t *testing.T, models ...any) {
	t.Helper()
	old := database.DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "test.db")), &gorm.Config{})
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	if err := db.AutoMigrate(models...); err != nil {
		t.Fatalf("迁移测试表失败: %v", err)
	}
	database.DB = db
	t.Cleanup(func() {
		// 还原包级 database.DB，避免后续测试拿到这个已被关闭的临时连接
		database.DB = old
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
}
