package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"ninimenu/internal/models"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type toggledDishResponse struct {
	Name        string
	Enabled     bool
	Ingredients json.RawMessage
	Steps       json.RawMessage
}

func toggleDishForTest(t *testing.T, id uint) toggledDishResponse {
	t.Helper()
	w := serveJSON(t, ToggleDish, "PUT", "/api/dishes/toggle", nil, gin.Param{Key: "id", Value: fmt.Sprint(id)})
	var response struct{ Data toggledDishResponse }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatalf("toggle failed: %d %s", w.Code, w.Body.String())
	}
	return response.Data
}

func TestDishTogglePreservesRecipeEdits(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "旧菜名", Enabled: true, Ingredients: `[{"name":"番茄","amount":"2个"}]`, Steps: `[{"text":"旧做法"}]`}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	changed := map[string]any{"name": "新菜名", "ingredients": `[{"name":"番茄","amount":"4个"}]`, "steps": `[{"text":"新做法"}]`}
	// 在启停写入前插入一笔已完成的菜谱编辑，复现旧读取后被其它请求修改的交错。
	injected := false
	if err := db.Callback().Update().Before("gorm:update").Register("test:toggle_concurrent_edit", func(tx *gorm.DB) {
		if tx.Statement.Table == "dishes" && !injected {
			injected = true
			if err := tx.Session(&gorm.Session{NewDB: true}).Model(&models.Dish{}).Where("id = ?", dish.ID).Updates(changed).Error; err != nil {
				tx.AddError(err)
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Callback().Update().Remove("test:toggle_concurrent_edit") })
	result := toggleDishForTest(t, dish.ID)
	if !injected || result.Enabled || result.Name != changed["name"] || string(result.Ingredients) != changed["ingredients"] || string(result.Steps) != changed["steps"] {
		t.Fatalf("toggle must preserve recipe contents: %+v", result)
	}
	var saved models.Dish
	if err := db.First(&saved, dish.ID).Error; err != nil || saved.Name != result.Name || saved.Ingredients != string(result.Ingredients) || saved.Steps != string(result.Steps) || saved.Enabled {
		t.Fatalf("stored recipe must retain the concurrent edit: %+v %v", saved, err)
	}
}

func TestDishToggleConcurrentRequestsEachFlipOnce(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "并发启停", Enabled: true}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	var wg sync.WaitGroup
	responses := make(chan bool, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			responses <- toggleDishForTest(t, dish.ID).Enabled
		}()
	}
	wg.Wait()
	close(responses)
	enabled := 0
	for state := range responses {
		if state {
			enabled++
		}
	}
	var final models.Dish
	if err := db.First(&final, dish.ID).Error; err != nil {
		t.Fatal(err)
	}
	if enabled != 1 || !final.Enabled {
		t.Fatalf("two successful toggles must flip once each: enabled responses=%d final=%v", enabled, final.Enabled)
	}
}

func TestDishToggleMissingAndReadFailure(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	w := serveJSON(t, ToggleDish, "PUT", "/api/dishes/999/toggle", nil, gin.Param{Key: "id", Value: "999"})
	if w.Code != 404 {
		t.Fatalf("missing dish status=%d", w.Code)
	}
	dish := models.Dish{Name: "读取失败", Enabled: true}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().Before("gorm:query").Register("test:toggle_read_failure", func(tx *gorm.DB) {
		if _, ok := tx.Statement.Dest.(*models.Dish); ok {
			tx.AddError(errors.New("injected read failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	w = serveJSON(t, ToggleDish, "PUT", "/api/dishes/toggle", nil, gin.Param{Key: "id", Value: fmt.Sprint(dish.ID)})
	db.Callback().Query().Remove("test:toggle_read_failure")
	if w.Code != 500 {
		t.Fatalf("read failure must fail the whole toggle: %d %s", w.Code, w.Body.String())
	}
	var unchanged models.Dish
	if err := db.First(&unchanged, dish.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !unchanged.Enabled {
		t.Fatal("read failure must roll back the enabled change")
	}
}
