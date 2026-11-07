package services

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestUpdateInventoryBatchRejectsStaleAndMissingVersions(t *testing.T) {
	for _, change := range []string{"quantity", "expiry_date"} {
		t.Run(change, func(t *testing.T) {
			setupTestDB(t, &models.InventoryBatch{})
			batch := consumptionTestBatch(t, "番茄", "500克")
			expected := expectedConsumptionBatches(batch)[0]
			value := "300克"
			if change == "expiry_date" {
				value = "2031-01-01"
			}
			if err := database.DB.Model(&batch).Update(change, value).Error; err != nil {
				t.Fatal(err)
			}
			if found, err := UpdateInventoryBatch(batch.ID, "500克", "2032-01-01", expected); found || !errors.Is(err, ErrInventoryChanged) {
				t.Fatalf("stale edit accepted: found=%v err=%v", found, err)
			}
			if found, err := UpdateInventoryBatch(batch.ID, "500克", "2032-01-01", ExpectedConsumptionBatch{}); found || !errors.Is(err, ErrInventoryVersion) {
				t.Fatalf("unversioned edit accepted: found=%v err=%v", found, err)
			}
			latest := loadConsumptionBatch(t, batch.ID)
			if (change == "quantity" && latest.Quantity != value) || (change == "expiry_date" && latest.ExpiryDate != value) {
				t.Fatalf("stale edit changed inventory: %+v", latest)
			}
			// 客户端显式读取最新版本后可正常重新编辑。
			if found, err := UpdateInventoryBatch(batch.ID, "200克", "2032-01-01", expectedConsumptionBatches(latest)[0]); !found || err != nil {
				t.Fatalf("fresh edit failed: found=%v err=%v", found, err)
			}
		})
	}
}

func TestUpdateInventoryBatchChecksVersionAtWrite(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	batch := consumptionTestBatch(t, "番茄", "500克")
	expected := expectedConsumptionBatches(batch)[0]
	changed := false
	if err := database.DB.Callback().Update().Before("gorm:update").Register("test:change_inventory_before_cas", func(tx *gorm.DB) {
		if changed || tx.Statement.Table != "home_inventory" {
			return
		}
		changed = true
		tx.AddError(tx.Exec("UPDATE home_inventory SET quantity = ? WHERE id = ?", "300克", batch.ID).Error)
	}); err != nil {
		t.Fatal(err)
	}
	if found, err := UpdateInventoryBatch(batch.ID, "500克", "2032-01-01", expected); found || !errors.Is(err, ErrInventoryChanged) {
		t.Fatalf("concurrent change was overwritten: found=%v err=%v", found, err)
	}
	if got := loadConsumptionBatch(t, batch.ID); got.Quantity != "300克" {
		t.Fatalf("latest quantity lost: %+v", got)
	}
}

func TestClearExpiredInventoryRechecksDatesAndSelectedScope(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	today := time.Now()
	batches := []models.InventoryBatch{
		{ItemName: "仍过期", InStock: true, ExpiryDate: today.AddDate(0, 0, -2).Format("2006-01-02")},
		{ItemName: "已改保质期", InStock: true, ExpiryDate: today.AddDate(0, 0, 2).Format("2006-01-02")},
		{ItemName: "今天到期", InStock: true, ExpiryDate: TodayDate()},
		{ItemName: "没有日期", InStock: true},
		{ItemName: "坏日期", InStock: true, ExpiryDate: "2000-99-99"},
		{ItemName: "筛选范围外", InStock: true, ExpiryDate: "2000-01-01"},
	}
	if err := database.DB.Create(&batches).Error; err != nil {
		t.Fatal(err)
	}
	ids := []uint{batches[0].ID, batches[1].ID, batches[2].ID, batches[3].ID, batches[4].ID, 9999}
	result, err := ClearExpiredInventory(ids)
	if err != nil || result.Removed != 1 || result.Skipped != 5 {
		t.Fatalf("unexpected cleanup: %+v err=%v", result, err)
	}
	var left []models.InventoryBatch
	if err := database.DB.Find(&left).Error; err != nil || len(left) != 5 {
		t.Fatalf("cleanup crossed selected scope: %+v err=%v", left, err)
	}
	for _, ids := range [][]uint{nil, {0}, {batches[1].ID, batches[1].ID}} {
		if _, err := ClearExpiredInventory(ids); err == nil {
			t.Fatalf("invalid selection accepted: %v", ids)
		}
	}
}

func TestClearExpiredInventoryDoesNotDeleteDateChangedBeforeDelete(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	batch := consumptionTestBatch(t, "番茄", "500克")
	database.DB.Model(&batch).Update("expiry_date", "2000-01-01")
	changed := false
	if err := database.DB.Callback().Delete().Before("gorm:delete").Register("test:correct_expiry_before_delete", func(tx *gorm.DB) {
		if changed || tx.Statement.Table != "home_inventory" {
			return
		}
		changed = true
		tx.AddError(tx.Exec("UPDATE home_inventory SET expiry_date = ? WHERE id = ?", "2099-01-01", batch.ID).Error)
	}); err != nil {
		t.Fatal(err)
	}
	result, err := ClearExpiredInventory([]uint{batch.ID})
	if err != nil || result.Removed != 0 || result.Skipped != 1 {
		t.Fatalf("changed expiry must be skipped: %+v err=%v", result, err)
	}
	if got := loadConsumptionBatch(t, batch.ID); got.ExpiryDate != "2099-01-01" {
		t.Fatalf("corrected batch lost: %+v", got)
	}
}

func TestClearExpiredInventoryRollsBackOnFailure(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	batches := []models.InventoryBatch{{ItemName: "番茄", InStock: true, ExpiryDate: "2000-01-01"}, {ItemName: "鸡蛋", InStock: true, ExpiryDate: "2000-01-01"}}
	database.DB.Create(&batches)
	deletes := 0
	if err := database.DB.Callback().Delete().Before("gorm:delete").Register("test:fail_second_inventory_delete", func(tx *gorm.DB) {
		if tx.Statement.Table == "home_inventory" {
			deletes++
			if deletes == 2 {
				tx.AddError(errors.New("injected write failure"))
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	result, err := ClearExpiredInventory([]uint{batches[0].ID, batches[1].ID})
	if err == nil || result != (ClearExpiredInventoryResult{}) {
		t.Fatalf("partial cleanup reported success: %+v err=%v", result, err)
	}
	var count int64
	database.DB.Model(&models.InventoryBatch{}).Count(&count)
	if count != 2 {
		t.Fatalf("transaction did not roll back: left=%d", count)
	}
}

func TestConsumeInventoryStaleVersionRollsBackAllChanges(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	first := consumptionTestBatch(t, "鸡蛋", "10个")
	second := consumptionTestBatch(t, "番茄", "500克")
	versions := expectedConsumptionBatches(first, second)
	database.DB.Model(&second).Update("quantity", "300克")
	remaining := []BatchRemaining{{BatchID: second.ID, Quantity: "200克"}}
	removed, updated, err := ConsumeInventory([]uint{first.ID}, remaining, versions)
	if !errors.Is(err, ErrInventoryChanged) || removed != 0 || updated != 0 {
		t.Fatalf("stale transaction accepted: removed=%d updated=%d err=%v", removed, updated, err)
	}
	if got := loadConsumptionBatch(t, first.ID); got.Quantity != "10个" {
		t.Fatalf("first deletion not rolled back: %+v", got)
	}
	if got := loadConsumptionBatch(t, second.ID); got.Quantity != "300克" {
		t.Fatalf("stale remaining overwrote stock: %+v", got)
	}
	if _, _, err := ConsumeInventory([]uint{first.ID}, nil, nil); !errors.Is(err, ErrInventoryVersion) {
		t.Fatalf("legacy unversioned consumption accepted: %v", err)
	}
}

func TestFridgeReadsPropagateDatabaseFailures(t *testing.T) {
	for _, table := range []string{"home_inventory", "dishes", "settings"} {
		t.Run(table, func(t *testing.T) {
			setupTestDB(t, &models.InventoryBatch{}, &models.Dish{}, &models.Setting{})
			failure := errors.New("injected read failure")
			if err := database.DB.Callback().Query().Before("gorm:query").Register("test:fail_fridge_read", func(tx *gorm.DB) {
				if tx.Statement.Table == table {
					tx.AddError(failure)
				}
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := MatchFridgeRecipes(12); !errors.Is(err, failure) {
				t.Fatalf("recipe read failure hidden: %v", err)
			}
			if table == "home_inventory" {
				if _, err := ListInventoryBatches(); !errors.Is(err, failure) {
					t.Fatalf("inventory read failure hidden: %v", err)
				}
				if _, err := UrgentInventoryItems(); !errors.Is(err, failure) {
					t.Fatalf("urgent read failure hidden: %v", err)
				}
				if _, err := ClearExpiredInventory([]uint{1}); !errors.Is(err, failure) {
					t.Fatalf("cleanup read failure hidden: %v", err)
				}
			}
		})
	}
}
