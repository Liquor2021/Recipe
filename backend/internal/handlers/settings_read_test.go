package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"ninimenu/internal/models"
	"testing"

	"gorm.io/gorm"
)

func TestSettingsReadFailureDoesNotReturnEmptySettings(t *testing.T) {
	db := setupHandlerTestDB(t, &models.Setting{})
	if err := db.Create(&models.Setting{Key: "family_members", Value: `[{"name":"妈妈","dislikes":["猪肉"]}]`}).Error; err != nil {
		t.Fatal(err)
	}
	failRead := true
	if err := db.Callback().Query().Before("gorm:query").Register("test:settings_read_error", func(tx *gorm.DB) {
		if failRead && tx.Statement.Table == "settings" {
			tx.AddError(errors.New("private database error"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	w := serveJSON(t, GetSettings, http.MethodGet, "/api/settings", nil)
	var failed struct {
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &failed); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusInternalServerError || failed.Message != "读取设置失败" || string(failed.Data) != "null" {
		t.Fatalf("query failure must be an error without empty settings: %d %s", w.Code, w.Body.String())
	}
	failRead = false
	w = serveJSON(t, GetSettings, http.MethodGet, "/api/settings", nil)
	var success struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &success); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || string(success.Data["family_members"]) != `[{"name":"妈妈","dislikes":["猪肉"]}]` {
		t.Fatalf("retry must retain saved members: %d %s", w.Code, w.Body.String())
	}
}
