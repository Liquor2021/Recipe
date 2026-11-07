package handlers

import (
	"fmt"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestCancelledPlanRetainsShoppingSnapshot(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.ShoppingItemCategory{}); err != nil {
		t.Fatal(err)
	}
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `[{"name":"番茄","amount":"200克"},{"name":"鸡蛋","amount":"2个"}]`}
	db.Create(&dish)
	record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: services.TodayDate()})
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(record.ID)}}
	var items []models.ShoppingCheck
	db.Order("id").Find(&items)
	if len(items) != 2 {
		t.Fatalf("expected two ingredients, got %+v", items)
	}
	db.Model(&items[0]).Updates(map[string]any{"checked": true, "stocked": true})
	db.Model(&items[1]).Update("checked", true)
	batch := models.InventoryBatch{ItemName: "番茄", Quantity: "1000克", InStock: true}
	db.Create(&batch)
	w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"status": "cancelled"}, params...)
	if w.Code != 200 {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}
	list, err := services.BuildShoppingList([]string{record.MealDate})
	if err != nil || len(list) != 0 {
		t.Fatalf("cancelled ingredients should be hidden: %+v %v", list, err)
	}
	// 在同一天勾选其他菜的食材、以及过期页面的入库请求，不能触碰隐藏的快照。
	for _, name := range []string{"番茄", "鸡蛋"} {
		if err := services.ToggleShoppingCheck(name, false); err != nil {
			t.Fatal(err)
		}
	}
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "鸡蛋", Quantity: "2个"}}); err != nil || added != 0 {
		t.Fatalf("cancelled request created inventory: %d %v", added, err)
	}
	var hidden []models.ShoppingCheck
	db.Unscoped().Order("id").Find(&hidden)
	if len(hidden) != 2 || !hidden[0].DeletedAt.Valid || !hidden[0].Checked || !hidden[0].Stocked || !hidden[1].Checked || hidden[1].Stocked {
		t.Fatalf("hidden shopping state changed: %+v", hidden)
	}
	// 恢复应沿用当时的菜谱快照，即使菜谱已被编辑；份量仍按原量计算。
	db.Model(&dish).Update("ingredients", `[{"name":"番茄","amount":"999克"}]`)
	w = serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"status": "planned", "portion_scale": 3}, params...)
	if w.Code != 200 {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	var restored []models.ShoppingCheck
	db.Order("id").Find(&restored)
	if len(restored) != 2 || restored[0].ID != items[0].ID || restored[1].ID != items[1].ID || restored[0].ItemAmount != "600克" || restored[1].ItemAmount != "6个" || restored[0].BaseAmount != "200克" || !restored[0].Checked || !restored[0].Stocked || !restored[1].Checked {
		t.Fatalf("restore lost snapshot: %+v", restored)
	}
	var inventory []models.InventoryBatch
	db.Find(&inventory)
	if len(inventory) != 1 || inventory[0].ID != batch.ID || inventory[0].Quantity != "1000克" {
		t.Fatalf("cancel/restore changed real inventory: %+v", inventory)
	}
	// 真正删除取消记录必须清理隐藏需求，不能留下以后错误复活的行。
	serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"status": "cancelled"}, params...)
	w = serveJSON(t, DeleteRecord, "DELETE", "/records/1", nil, params...)
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	var remaining int64
	db.Unscoped().Model(&models.ShoppingCheck{}).Count(&remaining)
	if remaining != 0 {
		t.Fatalf("deleted record retained %d hidden shopping rows", remaining)
	}
}

func TestReschedulePlanPreservesIdentityAndShoppingState(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "清炒番茄", Ingredients: `[{"name":"番茄","amount":"200克"}]`}
	db.Create(&dish)
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: yesterday})
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(record.ID)}}
	var item models.ShoppingCheck
	db.First(&item)
	db.Model(&item).Updates(map[string]any{"checked": true, "stocked": true})
	w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"meal_date": tomorrow, "meal_type": "dinner", "portion_scale": 2}, params...)
	if w.Code != 200 {
		t.Fatalf("reschedule: %d %s", w.Code, w.Body.String())
	}
	db.First(&record, record.ID)
	db.First(&item, item.ID)
	if record.MealDate != tomorrow || record.MealType != "dinner" || record.PortionScale != 2 || item.MealDate != tomorrow || item.MealType != "dinner" || item.ItemAmount != "400克" || item.BaseAmount != "200克" || !item.Checked || !item.Stocked {
		t.Fatalf("reschedule lost identity/state: record=%+v item=%+v", record, item)
	}
	// 目标餐次已经安排同菜时，不能覆盖、合并或部分移动购物条目。
	testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: tomorrow})
	w = serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"meal_type": "lunch", "portion_scale": 4}, params...)
	if w.Code != 400 {
		t.Fatalf("duplicate slot: %d %s", w.Code, w.Body.String())
	}
	db.First(&record, record.ID)
	db.First(&item, item.ID)
	if record.MealType != "dinner" || record.PortionScale != 2 || item.MealType != "dinner" || item.ItemAmount != "400克" {
		t.Fatalf("conflict changed original plan: record=%+v item=%+v", record, item)
	}
	if err := db.Exec("CREATE TRIGGER block_shopping_move BEFORE UPDATE OF meal_date ON shopping_checks BEGIN SELECT RAISE(ABORT, 'blocked'); END").Error; err != nil {
		t.Fatal(err)
	}
	w = serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"meal_date": time.Now().AddDate(0, 0, 2).Format("2006-01-02")}, params...)
	if w.Code != 500 {
		t.Fatalf("shopping failure: %d %s", w.Code, w.Body.String())
	}
	db.First(&record, record.ID)
	if record.MealDate != tomorrow {
		t.Fatal("shopping move failure did not roll back record date")
	}
}

func TestRescheduleRejectsInvalidDatesAndTransitions(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "清炒番茄", Ingredients: `[{"name":"番茄","amount":"200克"}]`}
	db.Create(&dish)
	record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: services.TodayDate()})
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(record.ID)}}
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	for _, body := range []map[string]any{
		{"meal_date": "2026-02-30"}, {"meal_date": ""}, {"meal_type": "breakfast"},
		{"meal_date": time.Now().AddDate(0, 0, -1).Format("2006-01-02")},
		{"meal_date": tomorrow, "status": "completed"}, {"meal_date": tomorrow, "status": "cancelled"},
	} {
		w := serveJSON(t, UpdateRecord, "PUT", "/records/1", body, params...)
		if w.Code != 400 {
			t.Fatalf("invalid update %+v: %d %s", body, w.Code, w.Body.String())
		}
	}
	for _, status := range []string{models.MealCancelled, models.MealCompleted} {
		db.Model(&record).Update("status", status)
		w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"meal_date": tomorrow, "status": "planned"}, params...)
		if w.Code != 400 {
			t.Fatalf("%s cannot move or bypass transition: %d %s", status, w.Code, w.Body.String())
		}
	}
	db.Model(&record).Update("inventory_applied", true)
	w := serveJSON(t, DeleteRecord, "DELETE", "/records/1", nil, params...)
	if w.Code != 400 {
		t.Fatalf("applied inventory record must retain undo entry: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"portion_scale": 2}, params...)
	if w.Code != 400 {
		t.Fatalf("applied inventory portion must not change: %d %s", w.Code, w.Body.String())
	}
}
