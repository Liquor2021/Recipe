package handlers

import (
	"errors"
	"net/http/httptest"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestShoppingInventoryHandlerRejectsUnseenBatches(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.ShoppingItemCategory{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&models.ShoppingCheck{MealDate: services.TodayDate(), MealType: "extra", ItemName: "番茄"}).Error; err != nil {
		t.Fatal(err)
	}
	call := func(inStock bool, version string) *httptest.ResponseRecorder {
		return serveJSON(t, ToggleHomeInventoryHandler, "POST", "/shopping-list/inventory", map[string]any{"item_name": "番茄", "in_stock": inStock, "inventory_version": version})
	}
	if w := call(true, ""); w.Code != 200 {
		t.Fatalf("adding keeps its existing contract: %d %s", w.Code, w.Body.String())
	}
	currentVersion := func() string {
		t.Helper()
		list, err := services.BuildShoppingList(services.ShoppingListDates())
		if err != nil || len(list) != 1 || len(list[0].Items) != 1 {
			t.Fatalf("list: %+v %v", list, err)
		}
		return list[0].Items[0].InventoryVersion
	}
	version := currentVersion()
	if w := call(false, ""); w.Code != 409 {
		t.Fatalf("legacy destructive request must conflict: %d %s", w.Code, w.Body.String())
	}
	if err := db.Create(&models.InventoryBatch{ItemName: "西红柿", Quantity: "8个", ExpiryDate: time.Now().AddDate(0, 0, 3).Format("2006-01-02")}).Error; err != nil {
		t.Fatal(err)
	}
	if w := call(false, version); w.Code != 409 || !strings.Contains(w.Body.String(), "库存已变化") {
		t.Fatalf("unseen batch must conflict with recovery message: %d %s", w.Code, w.Body.String())
	}
	var count int64
	if err := db.Model(&models.InventoryBatch{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("stale request removed batches: %d %v", count, err)
	}
	if w := call(false, currentVersion()); w.Code != 200 {
		t.Fatalf("new confirmation should succeed: %d %s", w.Code, w.Body.String())
	}
	if err := db.Model(&models.InventoryBatch{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("fresh request did not remove confirmed batches: %d %v", count, err)
	}
}

func TestShoppingSupplementHandlerReportsRecipeReadFailure(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `[{"name":"番茄","amount":"2个"}]`, Seasonings: "[]"}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	const callback = "test:fail_handler_supplement_recipe_read"
	failReads := true
	if err := db.Callback().Query().Before("gorm:query").Register(callback, func(tx *gorm.DB) {
		if failReads && tx.Statement.Table == "dishes" {
			tx.AddError(errors.New("injected private database error"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Callback().Query().Remove(callback) })
	body := map[string]any{"dish_id": dish.ID, "dish_name": dish.Name, "items": []map[string]string{{"name": "番茄"}}}
	w := serveJSON(t, AddShoppingItemsHandler, "POST", "/shopping-list/items", body)
	if w.Code != 500 || !strings.Contains(w.Body.String(), "加入买菜清单失败") || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("DB error must return generic failure: %d %s", w.Code, w.Body.String())
	}
	var count int64
	if err := db.Model(&models.ShoppingCheck{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("failed handler must not create quantity-less items: %d %v", count, err)
	}
	failReads = false
	w = serveJSON(t, AddShoppingItemsHandler, "POST", "/shopping-list/items", body)
	if w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
}
