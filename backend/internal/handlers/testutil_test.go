package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"ninimenu/internal/database"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupHandlerTestDB 临时文件 SQLite 并迁移给定模型，同时替换包级 database.DB。
// 注意：会触发 QueueAutoAchievementSync 的处理器不要在这里直接测——300ms 后的
// 异步同步会在测试清理关库之后访问 database.DB。
func setupHandlerTestDB(t *testing.T, models ...any) *gorm.DB {
	t.Helper()
	old := database.DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "handler-test.db")), &gorm.Config{})
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	if err := db.AutoMigrate(models...); err != nil {
		t.Fatalf("迁移测试表失败: %v", err)
	}
	database.DB = db
	t.Cleanup(func() {
		database.DB = old
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
	return db
}

// serveJSON 直接调用处理器（不经过路由与鉴权中间件），返回响应
func serveJSON(t *testing.T, handler gin.HandlerFunc, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(method, target, reader)
	c.Request.Header.Set("Content-Type", "application/json")
	handler(c)
	return w
}
