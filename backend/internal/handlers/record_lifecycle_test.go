package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func setupRecordLifecycleDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := setupHandlerTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.ShoppingCheck{}, &models.DayRating{},
		&models.Achievement{}, &models.UserAchievement{}, &models.AchievementEvent{}, &models.Favorite{}, &models.InventoryBatch{})
	// 成功的处理器会排队同步成就，关库之前先取消定时器并等待同步完成。
	t.Cleanup(services.SyncAutoAchievements)
	if err := db.Exec("CREATE UNIQUE INDEX meal_record_test_unique ON meal_records(dish_id, meal_type, meal_date)").Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func testCreateMeal(t *testing.T, req CreateRecordRequest) models.MealRecord {
	t.Helper()
	if err := validateCreateRecord(&req); err != nil {
		t.Fatal(err)
	}
	r, err := createOrCompleteRecord(req)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRecordPortionAndCompletionLifecycle(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"}]`, Seasonings: `[{"name":"盐","amount":"少许"}]`}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	req := CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: time.Now().AddDate(0, 0, -1).Format("2006-01-02")}
	r := testCreateMeal(t, req)
	if r.Status != models.MealPlanned || r.PortionScale != 1 {
		t.Fatalf("新建默认必须是待做和原量: %+v", r)
	}
	var count int64
	db.Model(&models.MealRecord{}).Scopes(services.EatenRecords).Count(&count)
	if count != 0 {
		t.Fatal("昨天的计划不能自动算已吃")
	}
	var first models.ShoppingCheck
	db.Where("item_name = ?", "番茄").First(&first)
	db.Model(&first).Updates(map[string]any{"checked": true, "stocked": true})
	for _, scale := range []float64{1.67, 1, 2} {
		w := serveJSON(t, UpdateRecord, "PUT", "/api/records/1", map[string]any{"portion_scale": scale}, gin.Param{Key: "id", Value: fmt.Sprint(r.ID)})
		if w.Code != 200 {
			t.Fatalf("调整份量失败: %d %s", w.Code, w.Body.String())
		}
	}
	var changed models.ShoppingCheck
	db.First(&changed, first.ID)
	if changed.ItemAmount != "4个" || !changed.Checked || !changed.Stocked || changed.BaseAmount != "2个" {
		t.Fatalf("份量改变应保留勾选/入库和原量快照: %+v", changed)
	}
	var salt models.ShoppingCheck
	db.Where("item_name = ?", "盐").First(&salt)
	if salt.ItemAmount != "少许" {
		t.Fatal("文字用量不应乘份量")
	}
	req.Status = models.MealCompleted
	completed := testCreateMeal(t, req)
	if completed.ID != r.ID || completed.Status != models.MealCompleted || completed.PortionScale != 2 {
		t.Fatalf("完成应更新原计划并保留份量: %+v", completed)
	}
	if _, err := createOrCompleteRecord(req); !errors.Is(err, errDuplicateMealRecord) {
		t.Fatalf("重复完成应拒绝: %v", err)
	}
	db.Model(&models.MealRecord{}).Scopes(services.EatenRecords).Count(&count)
	if count != 1 {
		t.Fatalf("完成只算一次: %d", count)
	}
	db.Model(&models.ShoppingCheck{}).Count(&count)
	if count != 3 {
		t.Fatalf("完成不能重复生成购物项: %d", count)
	}
	w := serveJSON(t, UpdateRecord, "PUT", "/api/records/1", map[string]any{"status": "cancelled"}, gin.Param{Key: "id", Value: fmt.Sprint(r.ID)})
	if w.Code != 400 {
		t.Fatalf("已吃不能降回计划/取消: %d", w.Code)
	}
	w = serveJSON(t, GetRecord, "GET", "/api/records/1", nil, gin.Param{Key: "id", Value: fmt.Sprint(r.ID)})
	var resp struct {
		Data models.MealRecord `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Data.PortionScale != 2 || resp.Data.Status != models.MealCompleted {
		t.Fatalf("单条记录缺状态/份量: %s", w.Body.String())
	}
}

func TestCancelRestorePlanAndRollback(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "清炒番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	db.Create(&dish)
	scale := 2.0
	req := CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "dinner", MealDate: services.TodayDate(), PortionScale: &scale}
	r := testCreateMeal(t, req)
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(r.ID)}}
	if err := db.Exec("CREATE TRIGGER block_shopping_delete BEFORE DELETE ON shopping_checks BEGIN SELECT RAISE(ABORT, 'blocked'); END").Error; err != nil {
		t.Fatal(err)
	}
	w := serveJSON(t, UpdateRecord, "PUT", "/api/records/1", map[string]any{"status": "cancelled"}, params...)
	if w.Code != 500 {
		t.Fatalf("购物项失败应返回500: %d %s", w.Code, w.Body.String())
	}
	db.First(&r, r.ID)
	if r.Status != models.MealPlanned {
		t.Fatal("取消联动失败必须回滚记录状态")
	}
	db.Exec("DROP TRIGGER block_shopping_delete")
	w = serveJSON(t, UpdateRecord, "PUT", "/api/records/1", map[string]any{"status": "cancelled"}, params...)
	if w.Code != 200 {
		t.Fatalf("取消失败: %s", w.Body.String())
	}
	var count int64
	db.Model(&models.ShoppingCheck{}).Count(&count)
	if count != 0 {
		t.Fatal("取消后购物清单仍有菜品食材")
	}
	scale = 3
	restored := testCreateMeal(t, req)
	if restored.ID != r.ID || restored.Status != models.MealPlanned || restored.PortionScale != 3 {
		t.Fatalf("重新点菜应恢复原行: %+v", restored)
	}
	var item models.ShoppingCheck
	db.First(&item)
	if item.ItemAmount != "6个" {
		t.Fatalf("恢复计划应按所选份量生成购物项: %+v", item)
	}
}

func TestRecordInputValidationPreventsPartialBatch(t *testing.T) {
	setupHandlerTestDB(t, &models.MealRecord{})
	for _, override := range []map[string]any{
		{"status": "completed", "meal_date": time.Now().AddDate(0, 0, 1).Format("2006-01-02")},
		{"portion_scale": 0}, {"portion_scale": 9}, {"status": "unknown"}, {"meal_date": "2026-02-30"},
		{"rating": 4}, {"mood": "yum"}, {"photo": "/uploads/a.jpg"},
	} {
		body := map[string]any{"dish_id": 1, "dish_name": "菜", "meal_type": "lunch", "meal_date": services.TodayDate()}
		for k, v := range override {
			body[k] = v
		}
		w := serveJSON(t, CreateRecord, "POST", "/api/records", body)
		if w.Code != 400 {
			t.Fatalf("无效输入应拒绝: %+v -> %d %s", body, w.Code, w.Body.String())
		}
	}
	w := serveJSON(t, BatchCreateRecords, "POST", "/api/records/batch", map[string]any{"records": []map[string]any{
		{"dish_id": 1, "dish_name": "菜", "meal_type": "lunch", "meal_date": services.TodayDate()},
		{"dish_id": 2, "dish_name": "菜", "meal_type": "dinner", "meal_date": services.TodayDate(), "portion_scale": -1},
	}})
	if w.Code != 400 {
		t.Fatalf("整批无效应拒绝: %d %s", w.Code, w.Body.String())
	}
	var count int64
	database.DB.Model(&models.MealRecord{}).Count(&count)
	if count != 0 {
		t.Fatal("整批参数错误不应留下部分记录")
	}
}
