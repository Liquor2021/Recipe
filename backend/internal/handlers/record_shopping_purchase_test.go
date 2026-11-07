package handlers

import (
	"fmt"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestShoppingPurchaseSnapshotsSurvivePlanChanges(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.ShoppingItemCategory{}); err != nil {
		t.Fatal(err)
	}
	dish := models.Dish{Name: "番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	db.Create(&dish)
	today := services.TodayDate()
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: today})
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(record.ID)}}
	var row models.ShoppingCheck
	db.First(&row)
	// 模拟升级前已经买好并入库、尚无用量快照的记录。
	db.Model(&row).Updates(map[string]any{"checked": true, "stocked": true})
	db.Create(&models.InventoryBatch{ItemName: "番茄", Quantity: "2个", InStock: true})
	update := func(body map[string]any) {
		t.Helper()
		w := serveJSON(t, UpdateRecord, "PUT", "/records/1", body, params...)
		if w.Code != 200 {
			t.Fatalf("update %+v: %d %s", body, w.Code, w.Body.String())
		}
	}
	getItem := func() services.ShoppingItem {
		t.Helper()
		list, err := services.BuildShoppingList([]string{today, tomorrow})
		if err != nil || len(list) != 1 || len(list[0].Items) != 1 {
			t.Fatalf("shopping list: %+v %v", list, err)
		}
		return list[0].Items[0]
	}
	update(map[string]any{"portion_scale": 3})
	if item := getItem(); item.Amount != "6个" || item.PendingAmount != "4个" || item.StockInAmount != "" || !item.NeedsBuy {
		t.Fatalf("portion increase must only request extra 4: %+v", item)
	}
	db.First(&row, row.ID)
	if row.PurchasedAmount == nil || *row.PurchasedAmount != "2个" || row.StockedAmount == nil || *row.StockedAmount != "2个" {
		t.Fatalf("legacy purchase snapshot was enlarged: %+v", row)
	}
	update(map[string]any{"portion_scale": 0.5})
	if item := getItem(); !item.Checked || !item.Stocked || item.NeedsBuy || item.StockInAmount != "" {
		t.Fatalf("smaller plan should not delete previous purchase or restock: %+v", item)
	}
	update(map[string]any{"portion_scale": 2})
	if item := getItem(); item.PendingAmount != "2个" || !item.NeedsBuy {
		t.Fatalf("resized plan must compare original bought amount: %+v", item)
	}
	if err := services.ToggleShoppingCheck("番茄", true); err != nil {
		t.Fatal(err)
	}
	update(map[string]any{"meal_date": tomorrow, "meal_type": "dinner"})
	if item := getItem(); !item.Checked || item.StockInAmount != "2个" || item.PendingAmount != "" {
		t.Fatalf("rescheduling must preserve bought and stocked quantities: %+v", item)
	}
	update(map[string]any{"status": "cancelled"})
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 0 {
		t.Fatalf("cancelled plan cannot stock inventory: %d %v", added, err)
	}
	update(map[string]any{"status": "planned"})
	if item := getItem(); item.StockInAmount != "2个" || !item.Checked {
		t.Fatalf("restoring must retain only unstocked purchased amount: %+v", item)
	}
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 1 {
		t.Fatalf("stock restored extra: %d %v", added, err)
	}
	var batches []models.InventoryBatch
	db.Order("id").Find(&batches)
	if len(batches) != 2 || batches[0].Quantity != "2个" || batches[1].Quantity != "2个" {
		t.Fatalf("only newly purchased 2 may be added: %+v", batches)
	}
}

func TestShoppingExtraPurchaseFollowsRescheduledPlanOnce(t *testing.T) {
	for _, mode := range []string{"buy-before-plan", "buy-after-plan", "legacy-linked-rows", "legacy-stocked"} {
		t.Run(mode, func(t *testing.T) {
			db := setupRecordLifecycleDB(t)
			db.AutoMigrate(&models.ShoppingItemCategory{})
			dish := models.Dish{Name: "番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
			db.Create(&dish)
			today := services.TodayDate()
			tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
			addExtra := func() {
				t.Helper()
				if n, err := services.AddShoppingListItems([]services.ShoppingItem{{Name: "番茄", Amount: "2个"}}, dish.ID, dish.Name, today); err != nil || n != 1 {
					t.Fatalf("add extra: %d %v", n, err)
				}
			}
			legacy := mode == "legacy-linked-rows" || mode == "legacy-stocked"
			if !legacy {
				addExtra()
			}
			if mode == "buy-before-plan" {
				if err := services.ToggleShoppingCheck("番茄", true); err != nil {
					t.Fatal(err)
				}
			}
			record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: today})
			if legacy {
				// 模拟升级前补料和计划尚未归并，采购只记在补料行。
				db.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: dish.ID, ItemName: "番茄", ItemAmount: "2个", Checked: true, Stocked: mode == "legacy-stocked"})
			} else if mode == "buy-after-plan" {
				if err := services.ToggleShoppingCheck("番茄", true); err != nil {
					t.Fatal(err)
				}
			}
			// 同日另一道菜的独立补料不能被归并掉。
			db.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: dish.ID + 100, ItemName: "洋葱", ItemAmount: "1个"})
			w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"meal_date": tomorrow}, gin.Param{Key: "id", Value: fmt.Sprint(record.ID)})
			if w.Code != 200 {
				t.Fatalf("reschedule: %d %s", w.Code, w.Body.String())
			}
			list, err := services.BuildShoppingList([]string{today, tomorrow})
			if err != nil {
				t.Fatal(err)
			}
			items := map[string]services.ShoppingItem{}
			for _, cat := range list {
				for _, item := range cat.Items {
					items[item.Name] = item
				}
			}
			wantStockIn := "2个"
			wantAdded := 1
			if mode == "legacy-stocked" {
				wantStockIn, wantAdded = "", 0
			}
			if item := items["番茄"]; item.Amount != "2个" || item.PendingAmount != "" || item.StockInAmount != wantStockIn || !item.Checked {
				t.Fatalf("one extra purchase became two after moving: %+v", item)
			}
			if item := items["洋葱"]; item.Amount != "1个" || !item.Removable || !item.NeedsBuy {
				t.Fatalf("independent extra was changed: %+v", item)
			}
			if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != wantAdded {
				t.Fatalf("stock purchase once: %d %v", added, err)
			}
			var batches []models.InventoryBatch
			db.Find(&batches)
			if len(batches) != wantAdded || (wantAdded == 1 && batches[0].Quantity != "2个") {
				t.Fatalf("single 2-item purchase was duplicated: %+v", batches)
			}
		})
	}
}

func TestShoppingExtraDoesNotMovePurchaseToAnotherMealOnCancel(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	db.AutoMigrate(&models.ShoppingItemCategory{})
	dish := models.Dish{Name: "番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	db.Create(&dish)
	today := services.TodayDate()
	if _, err := services.AddShoppingListItems([]services.ShoppingItem{{Name: "番茄", Amount: "2个"}}, dish.ID, dish.Name, today); err != nil {
		t.Fatal(err)
	}
	if err := services.ToggleShoppingCheck("番茄", true); err != nil {
		t.Fatal(err)
	}
	lunch := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: today})
	testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "dinner", MealDate: today})
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(lunch.ID)}}
	if w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"status": "cancelled"}, params...); w.Code != 200 {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "2个"}}); err != nil || added != 0 {
		t.Fatalf("cancelled lunch purchase was wrongly assigned to dinner: %d %v", added, err)
	}
	if err := services.ToggleShoppingCheck("番茄", true); err != nil {
		t.Fatal(err)
	}
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "2个"}}); err != nil || added != 1 {
		t.Fatalf("stock dinner: %d %v", added, err)
	}
	if w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"status": "planned"}, params...); w.Code != 200 {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	list, err := services.BuildShoppingList([]string{today})
	if err != nil || len(list) != 1 || len(list[0].Items) != 1 || list[0].Items[0].Amount != "4个" || list[0].Items[0].StockInAmount != "2个" || list[0].Items[0].PendingAmount != "" {
		t.Fatalf("restoring lunch must retain its distinct unstocked purchase: %+v %v", list, err)
	}
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 1 {
		t.Fatalf("stock restored lunch: %d %v", added, err)
	}
	if added, err := services.StockInShoppingItems([]services.StockInItem{{ItemName: "番茄", Quantity: "4个"}}); err != nil || added != 0 {
		t.Fatalf("repeated stock cannot duplicate either meal: %d %v", added, err)
	}
	var batches []models.InventoryBatch
	db.Find(&batches)
	if len(batches) != 2 || batches[0].Quantity != "2个" || batches[1].Quantity != "2个" {
		t.Fatalf("two purchases must result in 2+2, not a shared credit: %+v", batches)
	}
}

func TestShoppingExtraAdoptionRollsBackWithReschedule(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	dish := models.Dish{Name: "番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	db.Create(&dish)
	today := services.TodayDate()
	record := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: today})
	extra := models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: dish.ID, ItemName: "番茄", ItemAmount: "2个", Checked: true}
	db.Create(&extra)
	if err := db.Exec("CREATE TRIGGER block_extra_adoption BEFORE DELETE ON shopping_checks WHEN OLD.meal_type = 'extra' BEGIN SELECT RAISE(ABORT, 'blocked'); END").Error; err != nil {
		t.Fatal(err)
	}
	w := serveJSON(t, UpdateRecord, "PUT", "/records/1", map[string]any{"meal_date": time.Now().AddDate(0, 0, 1).Format("2006-01-02")}, gin.Param{Key: "id", Value: fmt.Sprint(record.ID)})
	if w.Code != 500 {
		t.Fatalf("adoption failure should abort update: %d %s", w.Code, w.Body.String())
	}
	db.First(&record, record.ID)
	var rows []models.ShoppingCheck
	db.Order("id").Find(&rows)
	if record.MealDate != today || len(rows) != 2 || rows[0].Checked || rows[0].PurchasedAmount != nil || !rows[1].Checked {
		t.Fatalf("failed adoption partially moved or copied purchase: record=%+v rows=%+v", record, rows)
	}
}

func TestDeletingPlanDoesNotLeaveItsLegacyExtraPurchase(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	db.AutoMigrate(&models.ShoppingItemCategory{})
	dish := models.Dish{Name: "番茄", Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	db.Create(&dish)
	today := services.TodayDate()
	lunch := testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: today})
	testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealType: "dinner", MealDate: today})
	db.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: dish.ID, ItemName: "番茄", ItemAmount: "2个", Checked: true})
	w := serveJSON(t, DeleteRecord, "DELETE", "/records/1", nil, gin.Param{Key: "id", Value: fmt.Sprint(lunch.ID)})
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	list, err := services.BuildShoppingList([]string{today})
	if err != nil || len(list) != 1 || len(list[0].Items) != 1 || list[0].Items[0].Amount != "2个" || list[0].Items[0].PendingAmount != "2个" || list[0].Items[0].StockInAmount != "" {
		t.Fatalf("deleted lunch purchase leaked into dinner: %+v %v", list, err)
	}
}
