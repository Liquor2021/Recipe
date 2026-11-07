package services

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
)

func TestShoppingNewDemandKeepsPurchasedAndStockedQuantities(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	first := models.ShoppingCheck{MealDate: today, MealType: "lunch", DishID: 1, ItemName: "番茄", ItemAmount: "2个"}
	database.DB.Create(&first)
	if err := ToggleShoppingCheck("番茄", true); err != nil {
		t.Fatal(err)
	}
	second := models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 2, ItemName: "番茄", ItemAmount: "2个"}
	database.DB.Create(&second)
	item := shoppingItemsByName(t, today)["番茄"]
	if item.Amount != "4个" || item.Checked || item.PendingAmount != "2个" || item.StockInAmount != "2个" || !item.NeedsBuy {
		t.Fatalf("old purchase hid new demand: %+v", item)
	}
	// 老页面发来的总量4个不能把未买的第二份也放入冰箱。
	if added, err := StockInShoppingItems([]StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 1 {
		t.Fatalf("stock first purchase: %d %v", added, err)
	}
	item = shoppingItemsByName(t, today)["番茄"]
	if !item.InStock || !item.NeedsBuy || item.PendingAmount != "2个" || item.StockInAmount != "" || item.Stocked {
		t.Fatalf("old inventory hid pending demand: %+v", item)
	}
	database.DB.First(&second, second.ID)
	if second.Checked || second.Stocked || second.PurchasedAmount != nil {
		t.Fatalf("unbought demand was changed by stock-in: %+v", second)
	}
	if err := ToggleShoppingCheck("番茄", true); err != nil {
		t.Fatal(err)
	}
	item = shoppingItemsByName(t, today)["番茄"]
	if !item.Checked || item.NeedsBuy || item.PendingAmount != "" || item.StockInAmount != "2个" {
		t.Fatalf("new purchase should stock only its own 2: %+v", item)
	}
	if added, err := StockInShoppingItems([]StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 1 {
		t.Fatalf("stock second purchase: %d %v", added, err)
	}
	if added, err := StockInShoppingItems([]StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 0 {
		t.Fatalf("repeat stock-in must be idempotent: %d %v", added, err)
	}
	var batches []models.InventoryBatch
	database.DB.Order("id").Find(&batches)
	if len(batches) != 2 || batches[0].Quantity != "2个" || batches[1].Quantity != "2个" {
		t.Fatalf("inventory must contain two separate purchases of 2: %+v", batches)
	}
}

func TestShoppingUncheckPreservesAlreadyStockedPart(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	bought, stocked := "6个", "2个"
	row := models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 1, ItemName: "番茄", ItemAmount: "6个", Checked: true, Stocked: true, PurchasedAmount: &bought, StockedAmount: &stocked}
	database.DB.Create(&row)
	if err := ToggleShoppingCheck("番茄", false); err != nil {
		t.Fatal(err)
	}
	item := shoppingItemsByName(t, today)["番茄"]
	if item.PendingAmount != "4个" || item.StockInAmount != "" || item.Checked || !item.NeedsBuy {
		t.Fatalf("uncheck must keep 2 already stocked and reopen remaining 4: %+v", item)
	}
	if added, err := StockInShoppingItems([]StockInItem{{ItemName: "番茄", Quantity: "6个"}}); err != nil || added != 0 {
		t.Fatalf("uncheck must not restock old purchase: %d %v", added, err)
	}
}

func TestShoppingExtraPurchaseCoversOnlyOneLinkedMeal(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	for _, row := range []models.ShoppingCheck{
		{MealDate: today, MealType: "extra", DishID: 1, ItemName: "牛肉", ItemAmount: "500g", Checked: true, Stocked: true},
		{MealDate: today, MealType: "lunch", DishID: 1, ItemName: "牛肉", ItemAmount: "500g"},
		{MealDate: today, MealType: "dinner", DishID: 1, ItemName: "牛肉", ItemAmount: "500g"},
	} {
		database.DB.Create(&row)
	}
	item := shoppingItemsByName(t, today)["牛肉"]
	if item.Amount != "1000g" || item.PendingAmount != "500g" || item.StockInAmount != "" {
		t.Fatalf("one extra purchase cannot cover both lunch and dinner: %+v", item)
	}
	if err := ToggleShoppingCheck("牛肉", true); err != nil {
		t.Fatal(err)
	}
	if added, err := StockInShoppingItems([]StockInItem{{ItemName: "牛肉", Quantity: "1000g"}}); err != nil || added != 1 {
		t.Fatalf("stock only newly purchased dinner: %d %v", added, err)
	}
	var batch models.InventoryBatch
	database.DB.First(&batch)
	if batch.Quantity != "500g" {
		t.Fatalf("extra and linked purchase were double-counted: %+v", batch)
	}
}

func TestShoppingUnknownAmountAndDifferentUnitsRemainVisible(t *testing.T) {
	for _, tc := range []struct{ current, previous, pending string }{
		{"2个", "500克", "2个"}, {"一袋", "半袋", "一袋"}, {"适量", "适量", ""}, {"", "", ""}, {"2个", "6个", ""}, {"3.5个", "2个", "1.5个"},
	} {
		t.Run(tc.current+"-"+tc.previous, func(t *testing.T) {
			amount, pending := outstandingShoppingAmount(tc.current, &tc.previous)
			if amount != tc.pending || pending != (tc.pending != "") {
				t.Fatalf("outstanding(%q, %q) = %q/%v", tc.current, tc.previous, amount, pending)
			}
		})
	}
}

func TestShoppingInventoryWithoutPriorPurchaseKeepsHomeStockBehavior(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "lunch", DishID: 1, ItemName: "番茄", ItemAmount: "2个"})
	database.DB.Create(&models.InventoryBatch{ItemName: "番茄", InStock: true, Quantity: "3个"})
	item := shoppingItemsByName(t, today)["番茄"]
	if !item.InStock || item.NeedsBuy || item.Checked || item.StockInAmount != "" {
		t.Fatalf("existing home stock should keep original explicit inventory behavior: %+v", item)
	}
}
