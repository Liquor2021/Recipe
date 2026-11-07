package services

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
)

func TestStockInShoppingIgnoresHiddenAndAlreadyStockedItems(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{})
	today := dateFromNow(0)
	hidden := models.ShoppingCheck{MealDate: today, MealType: "lunch", DishID: 1, ItemName: "鸡蛋", Checked: true}
	active := models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 2, ItemName: "鸡蛋", Checked: true}
	unbought := models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 3, ItemName: "番茄"}
	database.DB.Create(&hidden)
	database.DB.Create(&active)
	database.DB.Create(&unbought)
	database.DB.Delete(&hidden)
	request := []StockInItem{{ItemName: "鸡蛋", Quantity: "2个"}, {ItemName: " 鸡蛋 ", Quantity: "2个"}, {ItemName: "番茄", Quantity: "200克"}}
	if added, err := StockInShoppingItems(request); err != nil || added != 1 {
		t.Fatalf("only one eligible item should be stocked once: %d %v", added, err)
	}
	if added, err := StockInShoppingItems(request); err != nil || added != 0 {
		t.Fatalf("repeat stock-in should be idempotent: %d %v", added, err)
	}
	var batches []models.InventoryBatch
	database.DB.Find(&batches)
	if len(batches) != 1 || batches[0].ItemName != "鸡蛋" || batches[0].Quantity != "2个" {
		t.Fatalf("unexpected inventory: %+v", batches)
	}
	database.DB.Unscoped().First(&hidden, hidden.ID)
	database.DB.First(&active, active.ID)
	if hidden.Stocked || !active.Stocked {
		t.Fatalf("hidden state was updated: hidden=%+v active=%+v", hidden, active)
	}
}
