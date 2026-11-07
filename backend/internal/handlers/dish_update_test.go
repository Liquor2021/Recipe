package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"ninimenu/internal/models"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type dishUpdateBody struct {
	io.Reader
	once       sync.Once
	beforeRead func()
}

func (r *dishUpdateBody) Read(p []byte) (int, error) {
	r.once.Do(r.beforeRead)
	return r.Reader.Read(p)
}

func updateDishAfterAction(t *testing.T, id uint, request CreateDishRequest, action func()) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("PUT", "/api/dishes/1", &dishUpdateBody{Reader: bytes.NewReader(data), beforeRead: action})
	c.Request.Header.Set("Content-Type", "application/json")
	c.Params = gin.Params{{Key: "id", Value: fmt.Sprint(id)}}
	UpdateDish(c)
	return w
}

func TestDishUpdatePreservesConcurrentToggleAndFavorite(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "旧菜名", Enabled: true, CreatedAt: time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	// 旧实现先读整行再解析请求；解析时完成其它请求，随后保存会写回旧状态。
	w := updateDishAfterAction(t, dish.ID, CreateDishRequest{Name: "新菜名", Ingredients: `[{"name":"番茄","amount":"2个"}]`}, func() {
		if result := toggleDishForTest(t, dish.ID); result.Enabled {
			t.Fatal("toggle must finish before recipe update")
		}
		favorite := serveJSON(t, AddFavorite, "POST", "/api/favorites/1", nil, gin.Param{Key: "dishId", Value: fmt.Sprint(dish.ID)})
		if favorite.Code != 200 {
			t.Fatalf("favorite must finish before recipe update: %s", favorite.Body.String())
		}
	})
	var response struct {
		Data struct {
			Name        string
			Enabled     bool
			Favorite    bool
			Ingredients json.RawMessage
		}
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatalf("recipe update failed: %d %s", w.Code, w.Body.String())
	}
	if response.Data.Name != "新菜名" || response.Data.Enabled || !response.Data.Favorite || string(response.Data.Ingredients) != `[{"name":"番茄","amount":"2个"}]` {
		t.Fatalf("response must include both recipe edit and completed status changes: %+v", response.Data)
	}
	var saved models.Dish
	if err := db.First(&saved, dish.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Name != "新菜名" || saved.Enabled || !saved.Favorite || !saved.CreatedAt.Equal(dish.CreatedAt) {
		t.Fatalf("recipe edit overwrote fields it does not own: %+v", saved)
	}
}

func TestDishUpdateKeepsFullReplacementWithEmptyValues(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "旧菜名", ImageURL: "/uploads/old.jpg", Images: `["/uploads/old.jpg"]`, VideoURL: "/uploads/old.mp4", Category: "旧分类", MealType: "dinner", Taste: "辣", Ingredients: `[{"name":"番茄"}]`, Seasonings: `[{"name":"盐"}]`, Steps: `[{"text":"旧做法"}]`, CookTime: 30, Difficulty: "hard", Remark: "旧备注", Tags: `["旧标签"]`, SortOrder: 12}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	w := serveJSON(t, UpdateDish, "PUT", "/api/dishes/1", CreateDishRequest{Name: "新菜名"}, gin.Param{Key: "id", Value: fmt.Sprint(dish.ID)})
	if w.Code != 200 {
		t.Fatalf("recipe replacement failed: %s", w.Body.String())
	}
	var saved models.Dish
	if err := db.First(&saved, dish.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Name != "新菜名" || saved.ImageURL != "" || saved.Images != "" || saved.VideoURL != "" || saved.Category != "" || saved.MealType != "" || saved.Taste != "" || saved.Ingredients != "" || saved.Seasonings != "" || saved.Steps != "" || saved.CookTime != 0 || saved.Difficulty != "" || saved.Remark != "" || saved.Tags != "" || saved.SortOrder != 0 {
		t.Fatalf("empty and zero values must still replace prior recipe fields: %+v", saved)
	}
}

func TestDishUpdateMissingDeletedAndReadFailure(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	w := serveJSON(t, UpdateDish, "PUT", "/api/dishes/999", CreateDishRequest{Name: "不存在"}, gin.Param{Key: "id", Value: "999"})
	if w.Code != 404 {
		t.Fatalf("missing dish status=%d", w.Code)
	}
	dish := models.Dish{Name: "删除前"}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	w = updateDishAfterAction(t, dish.ID, CreateDishRequest{Name: "删除后"}, func() {
		if err := db.Delete(&dish).Error; err != nil {
			t.Fatal(err)
		}
	})
	if w.Code != 404 {
		t.Fatalf("edit must not restore a concurrently deleted recipe: %d %s", w.Code, w.Body.String())
	}
	var deleted models.Dish
	if err := db.Unscoped().First(&deleted, dish.ID).Error; err != nil || !deleted.DeletedAt.Valid || deleted.Name != "删除前" {
		t.Fatalf("deleted recipe must remain unchanged: %+v %v", deleted, err)
	}
	dish = models.Dish{Name: "读取失败前"}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().Before("gorm:query").Register("test:update_dish_read_failure", func(tx *gorm.DB) {
		if _, ok := tx.Statement.Dest.(*models.Dish); ok {
			tx.AddError(errors.New("injected recipe read failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	w = serveJSON(t, UpdateDish, "PUT", "/api/dishes/1", CreateDishRequest{Name: "读取失败后"}, gin.Param{Key: "id", Value: fmt.Sprint(dish.ID)})
	db.Callback().Query().Remove("test:update_dish_read_failure")
	if w.Code != 500 {
		t.Fatalf("readback failure must fail the edit: %d %s", w.Code, w.Body.String())
	}
	var unchanged models.Dish
	if err := db.First(&unchanged, dish.ID).Error; err != nil || unchanged.Name != "读取失败前" {
		t.Fatalf("readback failure must roll back recipe changes: %+v %v", unchanged, err)
	}
}
