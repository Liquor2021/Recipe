package handlers

import (
	"fmt"
	"net/url"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestShoppingStockInAndRemoveRejectMissingOrOldScope(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.ShoppingItemCategory{}); err != nil {
		t.Fatal(err)
	}
	amount := "2个"
	row := models.ShoppingCheck{ItemName: "番茄", ItemAmount: amount, MealDate: services.TodayDate(), MealType: "extra", Checked: true, PurchasedAmount: &amount}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	version := currentShoppingDemandVersion(t, row.ItemName)
	for _, oldVersion := range []string{"", version} {
		if oldVersion != "" {
			w := serveJSON(t, UpdateShoppingPlanSettings, "PUT", "/shopping-list/settings", map[string]int{"days": 7})
			if w.Code != 200 {
				t.Fatalf("change scope: %d %s", w.Code, w.Body.String())
			}
		}
		w := serveJSON(t, StockInShoppingItemsHandler, "POST", "/shopping-list/stock-in", map[string]any{"items": []map[string]string{{"item_name": row.ItemName, "quantity": amount, "demand_version": oldVersion}}})
		if w.Code != 409 {
			t.Fatalf("missing/old stock-in version: %d %s", w.Code, w.Body.String())
		}
		w = serveJSON(t, RemoveShoppingItemHandler, "DELETE", "/shopping-list/items/test?demand_version="+url.QueryEscape(oldVersion), nil, gin.Param{Key: "itemName", Value: row.ItemName})
		if w.Code != 409 {
			t.Fatalf("missing/old removal version: %d %s", w.Code, w.Body.String())
		}
	}
	var batches int64
	if err := db.Model(&models.InventoryBatch{}).Count(&batches).Error; err != nil || batches != 0 {
		t.Fatal("stale request created stock", batches, err)
	}
	var after models.ShoppingCheck
	if err := db.First(&after, row.ID).Error; err != nil || !after.Checked || after.Stocked || after.ItemAmount != amount {
		t.Fatal("stale request changed demand", after, err)
	}
}

func currentShoppingDemandVersion(t *testing.T, name string) string {
	t.Helper()
	list, err := services.BuildShoppingList(services.ShoppingListDates())
	if err != nil {
		t.Fatal(err)
	}
	for _, category := range list {
		for _, item := range category.Items {
			if item.Name == name {
				return item.DemandVersion
			}
		}
	}
	t.Fatalf("missing shopping item %q", name)
	return ""
}

func TestShoppingToggleRequiresCurrentDemandVersion(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.ShoppingItemCategory{}); err != nil {
		t.Fatal(err)
	}
	dish := models.Dish{Name: "番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	if err := db.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: services.TodayDate()})
	version := currentShoppingDemandVersion(t, "番茄")
	toggle := func(version string, checked bool) int {
		t.Helper()
		return serveJSON(t, ToggleShoppingCheckHandler, "POST", "/shopping-list/toggle", map[string]any{
			"item_name": "番茄", "meal_date": services.TodayDate(), "checked": checked, "demand_version": version,
		}).Code
	}
	if code := toggle("", true); code != 409 {
		t.Fatalf("old client without version must receive 409, got %d", code)
	}
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(record.ID)}}
	w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"portion_scale": 2}, params...)
	if w.Code != 200 {
		t.Fatalf("resize: %d %s", w.Code, w.Body.String())
	}
	if code := toggle(version, true); code != 409 {
		t.Fatalf("stale amount must receive 409, got %d", code)
	}
	var row models.ShoppingCheck
	if err := db.First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.Checked || row.PurchasedAmount != nil || row.ItemAmount != "4个" {
		t.Fatalf("stale mark must not buy the extra quantity: %+v", row)
	}
	if code := toggle(currentShoppingDemandVersion(t, "番茄"), true); code != 200 {
		t.Fatalf("fresh version must succeed, got %d", code)
	}
	if code := toggle(version, false); code != 409 {
		t.Fatalf("stale uncheck must not erase the new purchase, got %d", code)
	}
	if err := db.First(&row, row.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !row.Checked || row.PurchasedAmount == nil || *row.PurchasedAmount != "4个" {
		t.Fatalf("confirmed new purchase was overwritten: %+v", row)
	}
}
