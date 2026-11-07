package services

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"reflect"
	"sync"
	"testing"
	"time"
)

func currentShoppingDemandVersion(t *testing.T, name string) string {
	t.Helper()
	var rows []models.ShoppingCheck
	dates := ShoppingListDates()
	if err := database.DB.Where("item_name = ? AND meal_date IN ?", name, dates).Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	return shoppingDemandVersions(dates, rows)[name]
}

func TestShoppingDemandVersionMatchesListAndPreservesOtherItems(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	for _, name := range []string{"番茄", "鸡蛋"} {
		if err := database.DB.Create(&models.ShoppingCheck{MealDate: TodayDate(), MealType: "lunch", DishID: 1, ItemName: name, ItemAmount: "2个"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	items := shoppingItemsByName(t, ShoppingListDates()...)
	tomatoVersion := items["番茄"].DemandVersion
	if tomatoVersion == "" || tomatoVersion != currentShoppingDemandVersion(t, "番茄") {
		t.Fatal("displayed demand version must match the write-side snapshot")
	}
	if err := ToggleShoppingCheck("鸡蛋", true, items["鸡蛋"].DemandVersion); err != nil {
		t.Fatal(err)
	}
	if err := ToggleShoppingCheck("番茄", true, tomatoVersion); err != nil {
		t.Fatalf("another ingredient must not invalidate this item: %v", err)
	}
	items = shoppingItemsByName(t, ShoppingListDates()...)
	if !items["番茄"].Checked || !items["鸡蛋"].Checked || items["番茄"].DemandVersion == tomatoVersion {
		t.Fatalf("purchases must remain independent and update the version: %+v", items)
	}
}

func TestShoppingToggleRejectsChangedDemandWithoutWriting(t *testing.T) {
	for _, kind := range []string{"missing", "added", "portion", "cancelled", "rescheduled", "replaced", "purchased", "stocked", "changed-back", "date-rollover"} {
		t.Run(kind, func(t *testing.T) {
			setupTestDB(t, &models.ShoppingCheck{})
			row := models.ShoppingCheck{MealDate: TodayDate(), MealType: "lunch", DishID: 1, ItemName: "番茄", ItemAmount: "2个"}
			if err := database.DB.Create(&row).Error; err != nil {
				t.Fatal(err)
			}
			version := currentShoppingDemandVersion(t, "番茄")
			var err error
			switch kind {
			case "missing":
				version = ""
			case "added":
				err = database.DB.Create(&models.ShoppingCheck{MealDate: TodayDate(), MealType: "dinner", DishID: 2, ItemName: "番茄", ItemAmount: "2个"}).Error
			case "portion":
				err = database.DB.Model(&row).Update("item_amount", "4个").Error
			case "cancelled":
				err = database.DB.Delete(&row).Error
			case "rescheduled":
				err = database.DB.Model(&row).Update("meal_type", "dinner").Error
			case "replaced":
				if err = database.DB.Unscoped().Delete(&row).Error; err == nil {
					err = database.DB.Create(&models.ShoppingCheck{MealDate: TodayDate(), MealType: "lunch", DishID: 2, ItemName: "番茄", ItemAmount: "2个"}).Error
				}
			case "purchased":
				err = database.DB.Model(&row).Updates(map[string]any{"checked": true, "purchased_amount": "2个"}).Error
			case "stocked":
				err = database.DB.Model(&row).Updates(map[string]any{"checked": true, "stocked": true, "purchased_amount": "2个", "stocked_amount": "2个"}).Error
			case "changed-back":
				err = database.DB.Model(&row).Update("updated_at", row.UpdatedAt.Add(time.Second)).Error
			case "date-rollover":
				// 昨天打开的清单也含今天同一行，行没变但今天+明天的范围已变。
				version = shoppingDemandVersions([]string{dateFromNow(-1), TodayDate()}, []models.ShoppingCheck{row})[row.ItemName]
			}
			if err != nil {
				t.Fatal(err)
			}
			var before, after []models.ShoppingCheck
			if err := database.DB.Unscoped().Order("id").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			// 旧“勾选”和旧“取消”都不能覆盖另一页面已经确认的采购。
			for _, checked := range []bool{true, false} {
				if err := ToggleShoppingCheck("番茄", checked, version); !errors.Is(err, ErrShoppingDemandChanged) {
					t.Fatalf("stale toggle %v must conflict: %v", checked, err)
				}
			}
			if err := database.DB.Unscoped().Order("id").Find(&after).Error; err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("stale request changed procurement: before=%+v after=%+v", before, after)
			}
		})
	}
}

func TestShoppingDemandVersionStableAcrossOrderAndHiddenRows(t *testing.T) {
	date := TodayDate()
	a := models.ShoppingCheck{ID: 1, MealDate: date, MealType: "lunch", DishID: 1, ItemName: "番茄", ItemAmount: "2个"}
	b := models.ShoppingCheck{ID: 2, MealDate: dateFromNow(1), MealType: "dinner", DishID: 2, ItemName: "番茄", ItemAmount: "3个"}
	hidden := models.ShoppingCheck{ID: 3, MealDate: date, ItemName: "番茄"}
	hidden.DeletedAt.Valid = true
	far := models.ShoppingCheck{ID: 4, MealDate: dateFromNow(5), ItemName: "番茄"}
	dates := ShoppingListDates()
	aVersion := shoppingDemandVersions(dates, []models.ShoppingCheck{a, b})["番茄"]
	bVersion := shoppingDemandVersions([]string{dates[1], dates[0]}, []models.ShoppingCheck{far, b, hidden, a})["番茄"]
	if aVersion == "" || aVersion != bVersion {
		t.Fatal("row order, date order and hidden/out-of-scope rows must not affect the visible version")
	}
}

func TestShoppingDemandConflictDoesNotAdoptLegacyExtras(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	rows := []models.ShoppingCheck{
		{MealDate: TodayDate(), MealType: "extra", DishID: 1, ItemName: "牛肉", ItemAmount: "500g", Checked: true, Stocked: true},
		{MealDate: TodayDate(), MealType: "lunch", DishID: 1, ItemName: "牛肉", ItemAmount: "500g"},
		{MealDate: TodayDate(), MealType: "dinner", DishID: 1, ItemName: "牛肉", ItemAmount: "500g"},
	}
	if err := database.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	version := shoppingItemsByName(t, ShoppingListDates()...)["牛肉"].DemandVersion
	if err := database.DB.Model(&rows[2]).Update("item_amount", "1000g").Error; err != nil {
		t.Fatal(err)
	}
	if err := ToggleShoppingCheck("牛肉", true, version); !errors.Is(err, ErrShoppingDemandChanged) {
		t.Fatalf("stale grouped demand must conflict: %v", err)
	}
	var extra models.ShoppingCheck
	if err := database.DB.First(&extra, rows[0].ID).Error; err != nil {
		t.Fatalf("conflict must not adopt/delete the extra row: %v", err)
	}
	current := shoppingItemsByName(t, ShoppingListDates()...)["牛肉"]
	if current.Amount != "1500g" || current.PendingAmount != "1000g" || current.StockInAmount != "" {
		t.Fatalf("old stocked extra must still cover only lunch: %+v", current)
	}
	if err := ToggleShoppingCheck("牛肉", true, current.DemandVersion); err != nil {
		t.Fatal(err)
	}
	current = shoppingItemsByName(t, ShoppingListDates()...)["牛肉"]
	if !current.Checked || current.StockInAmount != "1000g" {
		t.Fatalf("fresh confirmation must purchase only the outstanding dinner: %+v", current)
	}
	var count int64
	if err := database.DB.Where("meal_type = ?", "extra").Model(&models.ShoppingCheck{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("fresh confirmation must retain the existing adoption behavior: %d %v", count, err)
	}
}

func TestShoppingConcurrentRequestsCannotReuseDemandVersion(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{})
	if err := database.DB.Create(&models.ShoppingCheck{MealDate: TodayDate(), MealType: "lunch", DishID: 1, ItemName: "番茄", ItemAmount: "2个"}).Error; err != nil {
		t.Fatal(err)
	}
	version := currentShoppingDemandVersion(t, "番茄")
	var wg sync.WaitGroup
	results := make(chan error, 6)
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- ToggleShoppingCheck("番茄", true, version)
		}()
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("one version must commit at most once; got %d successful writes", succeeded)
	}
	var row models.ShoppingCheck
	if err := database.DB.First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if !row.Checked || row.PurchasedAmount == nil || *row.PurchasedAmount != "2个" {
		t.Fatalf("winning transaction must leave one purchase snapshot: %+v", row)
	}
}
