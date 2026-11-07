package services

import (
	"errors"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
)

func currentInventoryVersion(t *testing.T, name string) string {
	t.Helper()
	snapshots, err := availableInventorySnapshots(database.DB, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return snapshots[ingredients.Normalize(name)].Version
}

func TestShoppingInventoryVersionMatchesVisibleAliasBatches(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	for _, name := range []string{"番茄", "西红柿"} {
		if err := database.DB.Create(&models.ShoppingCheck{MealDate: TodayDate(), MealType: "lunch", DishID: 1, ItemName: name}).Error; err != nil {
			t.Fatal(err)
		}
		if err := database.DB.Create(&models.InventoryBatch{ItemName: name, Quantity: "2个", ExpiryDate: dateFromNow(3)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	items := shoppingItemsByName(t, ShoppingListDates()...)
	version := currentInventoryVersion(t, "番茄")
	for _, name := range []string{"番茄", "西红柿"} {
		if items[name].StockBatches != 2 || len(version) != 64 || items[name].InventoryVersion != version {
			t.Fatalf("displayed count and alias version must describe the same batches: %+v", items[name])
		}
	}
	// Other ingredients and expired batches are outside the displayed removal scope.
	for _, batch := range []models.InventoryBatch{{ItemName: "鸡蛋", Quantity: "10个"}, {ItemName: "番茄", ExpiryDate: dateFromNow(-1)}} {
		if err := database.DB.Create(&batch).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := ToggleHomeInventory("西红柿", false, version); err != nil {
		t.Fatal(err)
	}
	var left []models.InventoryBatch
	if err := database.DB.Order("id").Find(&left).Error; err != nil || len(left) != 2 || left[0].ItemName != "鸡蛋" || left[1].ExpiryDate != dateFromNow(-1) {
		t.Fatalf("only confirmed available batches may be removed: %+v, %v", left, err)
	}
}

func TestShoppingInventoryRemovalRejectsChangedSnapshot(t *testing.T) {
	for _, change := range []string{"missing", "added", "quantity", "expiry", "expired", "removed", "changed-back", "cross-day"} {
		t.Run(change, func(t *testing.T) {
			setupTestDB(t, &models.InventoryBatch{})
			batch := models.InventoryBatch{ItemName: "番茄", Quantity: "2个", ExpiryDate: dateFromNow(3)}
			if err := database.DB.Create(&batch).Error; err != nil {
				t.Fatal(err)
			}
			version := currentInventoryVersion(t, "番茄")
			var err error
			switch change {
			case "missing":
				version = ""
			case "added":
				err = database.DB.Create(&models.InventoryBatch{ItemName: "西红柿", Quantity: "8个", ExpiryDate: dateFromNow(5)}).Error
			case "quantity":
				err = database.DB.Model(&batch).Update("quantity", "10个").Error
			case "expiry":
				err = database.DB.Model(&batch).Update("expiry_date", dateFromNow(7)).Error
			case "expired":
				err = database.DB.Model(&batch).Update("expiry_date", dateFromNow(-1)).Error
			case "removed":
				err = database.DB.Delete(&batch).Error
			case "changed-back":
				err = database.DB.Model(&batch).Updates(map[string]any{"quantity": "2个", "updated_at": batch.UpdatedAt.Add(time.Second)}).Error
			case "cross-day":
				var snapshots map[string]availableInventorySnapshot
				snapshots, err = availableInventorySnapshots(database.DB, time.Now().AddDate(0, 0, -1))
				version = snapshots["番茄"].Version
			}
			if err != nil {
				t.Fatal(err)
			}
			var before []models.InventoryBatch
			if err := database.DB.Order("id").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			if err := ToggleHomeInventory("番茄", false, version); !errors.Is(err, ErrShoppingInventoryChanged) {
				t.Fatalf("changed snapshot must be rejected, got %v", err)
			}
			var after []models.InventoryBatch
			if err := database.DB.Order("id").Find(&after).Error; err != nil || fmt.Sprint(before) != fmt.Sprint(after) {
				t.Fatalf("rejected request changed inventory: before=%+v after=%+v err=%v", before, after, err)
			}
		})
	}
}

func TestShoppingInventoryRemovalFailureRollsBackAndRetryWorks(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	for i := 0; i < 2; i++ {
		if err := CreateInventoryBatch("番茄", "2个", ""); err != nil {
			t.Fatal(err)
		}
	}
	version := currentInventoryVersion(t, "番茄")
	if err := database.DB.Exec("CREATE TRIGGER fail_inventory_delete BEFORE DELETE ON home_inventory WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'test delete failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := ToggleHomeInventory("番茄", false, version); err == nil {
		t.Fatal("delete failure must be reported")
	}
	var left int64
	if err := database.DB.Model(&models.InventoryBatch{}).Count(&left).Error; err != nil || left != 2 || currentInventoryVersion(t, "番茄") != version {
		t.Fatalf("failed delete must leave both batches unchanged: %d %v", left, err)
	}
	if err := database.DB.Exec("DROP TRIGGER fail_inventory_delete").Error; err != nil {
		t.Fatal(err)
	}
	if err := ToggleHomeInventory("番茄", false, version); err != nil {
		t.Fatal(err)
	}
	if err := ToggleHomeInventory("番茄", false, version); !errors.Is(err, ErrShoppingInventoryChanged) {
		t.Fatalf("old confirmation cannot be reused after deletion: %v", err)
	}
}

func TestShoppingInventoryConcurrentRemovalHasOnlyOneWinner(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	if err := ToggleHomeInventory("番茄", true, ""); err != nil {
		t.Fatal(err)
	}
	version := currentInventoryVersion(t, "番茄")
	var wg sync.WaitGroup
	results := make(chan error, 4)
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- ToggleHomeInventory("番茄", false, version) }()
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
		t.Fatalf("only one request can confirm the same snapshot, got %d", succeeded)
	}
}

func TestShoppingSupplementRecipeReadFailureDoesNotCreateEmptyAmounts(t *testing.T) {
	setupTestDB(t, &models.Dish{}, &models.ShoppingCheck{})
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"}]`, Seasonings: "[]"}
	if err := database.DB.Create(&dish).Error; err != nil {
		t.Fatal(err)
	}
	const callback = "test:fail_supplement_recipe_read"
	failReads := true
	if err := database.DB.Callback().Query().Before("gorm:query").Register(callback, func(tx *gorm.DB) {
		if failReads && tx.Statement.Table == "dishes" {
			tx.AddError(errors.New("injected recipe read failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.DB.Callback().Query().Remove(callback) })
	items := []ShoppingItem{{Name: "鸡蛋", Amount: "4个"}, {Name: "西红柿"}}
	if added, err := AddShoppingListItems(items, dish.ID, dish.Name, TodayDate()); err == nil || added != 0 {
		t.Fatalf("failed recipe read must fail the entire supplement: %d %v", added, err)
	}
	var count int64
	if err := database.DB.Model(&models.ShoppingCheck{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("failure created partial or empty-amount rows: %d %v", count, err)
	}
	failReads = false
	if added, err := AddShoppingListItems(items, dish.ID, dish.Name, TodayDate()); err != nil || added != 2 {
		t.Fatalf("retry after recovery failed: %d %v", added, err)
	}
	var rows []models.ShoppingCheck
	if err := database.DB.Order("id").Find(&rows).Error; err != nil || len(rows) != 2 || rows[0].ItemAmount != "4个" || rows[1].ItemAmount != "2个" {
		t.Fatalf("retry must preserve explicit amounts and restore recipe alias amounts: %+v %v", rows, err)
	}
}
