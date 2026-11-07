package services

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"

	"gorm.io/gorm"
)

func TestUpdateInventoryBatchPreservesMetadataAndClearsEmptyValues(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	batch := models.InventoryBatch{ItemName: "番茄", InStock: true, Quantity: "1000克", ExpiryDate: "2030-01-01"}
	if err := database.DB.Create(&batch).Error; err != nil {
		t.Fatal(err)
	}
	for _, input := range []struct{ quantity, expiry, wantQuantity, wantExpiry string }{
		{" 600克 ", " 2030-01-02 ", "600克", "2030-01-02"},
		{" ", " ", "", ""},
	} {
		found, err := UpdateInventoryBatch(batch.ID, input.quantity, input.expiry, expectedConsumptionBatches(batch)[0])
		if err != nil || !found {
			t.Fatalf("existing update failed: found=%v err=%v", found, err)
		}
		var got models.InventoryBatch
		if err := database.DB.First(&got, batch.ID).Error; err != nil {
			t.Fatal(err)
		}
		if got.Quantity != input.wantQuantity || got.ExpiryDate != input.wantExpiry || got.ItemName != batch.ItemName || !got.InStock || !got.CreatedAt.Equal(batch.CreatedAt) {
			t.Fatalf("wrong updated batch: %+v", got)
		}
		batch = got
	}
	missing := expectedConsumptionBatches(batch)[0]
	missing.BatchID += 100
	if found, err := UpdateInventoryBatch(missing.BatchID, "2个", "", missing); !errors.Is(err, ErrInventoryChanged) || found {
		t.Fatalf("missing batch should stay missing: found=%v err=%v", found, err)
	}
}

func TestUpdateInventoryBatchDoesNotRecreateConcurrentlyRemovedBatch(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	batch := models.InventoryBatch{ItemName: "番茄", InStock: true, Quantity: "1000克"}
	if err := database.DB.Create(&batch).Error; err != nil {
		t.Fatal(err)
	}
	// 在 SQL UPDATE 前移走该批次，模拟编辑读取后另一操作整批扣减。
	// 旧版 Save 会在更新 0 行后重新 INSERT；条件 Updates 必须返回不存在。
	removed := false
	if err := database.DB.Callback().Update().Before("gorm:update").Register("test:remove_batch_before_update", func(tx *gorm.DB) {
		if removed || tx.Statement.Table != "home_inventory" {
			return
		}
		removed = true
		tx.AddError(tx.Session(&gorm.Session{NewDB: true}).Delete(&models.InventoryBatch{}, batch.ID).Error)
	}); err != nil {
		t.Fatal(err)
	}
	found, err := UpdateInventoryBatch(batch.ID, "600克", "", expectedConsumptionBatches(batch)[0])
	if !errors.Is(err, ErrInventoryChanged) || found || !removed {
		t.Fatalf("removed batch should not update: found=%v removed=%v err=%v", found, removed, err)
	}
	var count int64
	if err := database.DB.Model(&models.InventoryBatch{}).Where("id = ?", batch.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("editing recreated a batch that had already been removed")
	}
}
