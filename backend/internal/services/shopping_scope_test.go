package services

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
)

func TestShoppingSevenDayScopeProtectsOldActions(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{})
	db := database.DB
	rows := []models.ShoppingCheck{
		{ItemName: "番茄", ItemAmount: "2个", MealDate: dateFromNow(0), MealType: "extra"},
		{ItemName: "番茄", ItemAmount: "3个", MealDate: dateFromNow(6), MealType: "extra"},
		{ItemName: "番茄", ItemAmount: "7个", MealDate: dateFromNow(7), MealType: "extra"},
	}
	if err := db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	two, err := ShoppingPlanDates(db)
	if err != nil || len(two) != 2 {
		t.Fatal(two, err)
	}
	old := shoppingDemandVersions(two, rows)["番茄"]
	if err := db.Create(&models.Setting{Key: "shopping_plan_days", Value: "7"}).Error; err != nil {
		t.Fatal(err)
	}
	seven, err := ShoppingPlanDates(db)
	if err != nil || len(seven) != 7 || seven[6] != dateFromNow(6) {
		t.Fatal(seven, err)
	}
	if err := ToggleShoppingCheck("番茄", true, old); !errors.Is(err, ErrShoppingDemandChanged) {
		t.Fatal("old checkbox accepted", err)
	}
	if _, err := StockInShoppingItems([]StockInItem{{ItemName: "番茄", DemandVersion: old}}); !errors.Is(err, ErrShoppingDemandChanged) {
		t.Fatal("old stock-in accepted", err)
	}
	if _, err := RemoveShoppingExtraItem("番茄", old); !errors.Is(err, ErrShoppingDemandChanged) {
		t.Fatal("old remove accepted", err)
	}
	version := shoppingDemandVersions(seven, rows)["番茄"]
	if err := ToggleShoppingCheck("番茄", true, version); err != nil {
		t.Fatal(err)
	}
	if err := db.Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if !rows[0].Checked || !rows[1].Checked || rows[2].Checked {
		t.Fatal("wrong purchase range", rows)
	}
	version = shoppingDemandVersions(seven, rows)["番茄"]
	if added, err := StockInShoppingItems([]StockInItem{{ItemName: "番茄", DemandVersion: version}}); err != nil || added != 1 {
		t.Fatal(added, err)
	}
	var batch models.InventoryBatch
	db.First(&batch)
	if batch.Quantity != "5个" {
		t.Fatal("incorrect seven-day stock amount", batch.Quantity)
	}
	db.Order("id").Find(&rows)
	version = shoppingDemandVersions(seven, rows)["番茄"]
	if removed, err := RemoveShoppingExtraItem("番茄", version); err != nil || removed != 2 {
		t.Fatal(removed, err)
	}
	var count int64
	db.Model(&models.ShoppingCheck{}).Count(&count)
	if count != 1 {
		t.Fatal("removed future out-of-range item")
	}
}

func TestShoppingScopeReadFailureNeverFallsBack(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{})
	if err := database.DB.Migrator().DropTable(&models.Setting{}); err != nil {
		t.Fatal(err)
	}
	if _, err := ShoppingPlanDates(database.DB); err == nil {
		t.Fatal("scope failure silently fell back")
	}
}
