package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"ninimenu/internal/models"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func TestWeekPlanHandlersReturnGenericDatabaseErrors(t *testing.T) {
	for _, route := range []struct {
		name    string
		handler gin.HandlerFunc
		method  string
		body    any
		message string
	}{
		{"read", GetWeekPlan, http.MethodGet, nil, "读取周菜单失败"},
		{"regenerate", RegenerateWeekPlanHandler, http.MethodPost, nil, "重新生成失败，周菜单未保存"},
		{"swap", SwapWeekPlanDishHandler, http.MethodPost, map[string]any{"date": "2026-11-08", "meal_type": "lunch", "dish_id": 1}, "换菜失败"},
	} {
		t.Run(route.name, func(t *testing.T) {
			db := setupHandlerTestDB(t, &models.Setting{}, &models.AchievementEvent{})
			hit := false
			if err := db.Callback().Query().Before("gorm:query").Register("test:week_plan_settings_error", func(tx *gorm.DB) {
				if tx.Statement.Table == "settings" {
					hit = true
					tx.AddError(errors.New("private database path and error details"))
				}
			}); err != nil {
				t.Fatal(err)
			}
			w := serveJSON(t, route.handler, route.method, "/api/week-plan", route.body)
			var response struct {
				Code    int             `json:"code"`
				Message string          `json:"message"`
				Data    json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if !hit || w.Code != http.StatusInternalServerError || response.Code != 50000 || response.Message != route.message || string(response.Data) != "null" {
				t.Fatalf("database failure must not become success or expose details: %d %s", w.Code, w.Body.String())
			}
			var events int64
			if err := db.Model(&models.AchievementEvent{}).Count(&events).Error; err != nil || events != 0 {
				t.Fatalf("failed operation must not record a successful achievement event: events=%d err=%v", events, err)
			}
		})
	}
}
