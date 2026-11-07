package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func TestFridgeUpdateRequiresCurrentVersion(t *testing.T) {
	setupHandlerTestDB(t, &models.InventoryBatch{})
	batch := models.InventoryBatch{ItemName: "番茄", InStock: true, Quantity: "500克"}
	database.DB.Create(&batch)
	version := services.ExpectedConsumptionBatch{BatchID: batch.ID, Quantity: batch.Quantity, UpdatedAt: batch.UpdatedAt}
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(batch.ID)}}
	body := map[string]any{"quantity": "400克", "expiry_date": "2030-01-01"}
	if w := serveJSON(t, UpdateFridgeBatch, "PUT", "/fridge/batch/1", body, params...); w.Code != 409 {
		t.Fatalf("missing version should conflict: %d %s", w.Code, w.Body.String())
	}
	body["expected_batch"] = version
	if w := serveJSON(t, UpdateFridgeBatch, "PUT", "/fridge/batch/1", body, params...); w.Code != 200 {
		t.Fatalf("fresh edit failed: %d %s", w.Code, w.Body.String())
	}
	body["quantity"] = "500克"
	if w := serveJSON(t, UpdateFridgeBatch, "PUT", "/fridge/batch/1", body, params...); w.Code != 409 {
		t.Fatalf("stale version should conflict: %d %s", w.Code, w.Body.String())
	}
	if w := serveJSON(t, ConsumeFridgeBatches, "POST", "/fridge/consume", map[string]any{"batch_ids": []uint{batch.ID}}); w.Code != 409 {
		t.Fatalf("legacy endpoint bypassed version check: %d %s", w.Code, w.Body.String())
	}
	var latest models.InventoryBatch
	database.DB.First(&latest, batch.ID)
	if latest.Quantity != "400克" {
		t.Fatalf("conflict overwrote latest inventory: %+v", latest)
	}
}

func TestClearExpiredFridgeReturnsRemovedAndSkipped(t *testing.T) {
	setupHandlerTestDB(t, &models.InventoryBatch{})
	batches := []models.InventoryBatch{{ItemName: "番茄", InStock: true, ExpiryDate: "2000-01-01"}, {ItemName: "鸡蛋", InStock: true, ExpiryDate: "2099-01-01"}}
	database.DB.Create(&batches)
	w := serveJSON(t, ClearExpiredFridge, "POST", "/fridge/clear-expired", map[string]any{"batch_ids": []uint{batches[0].ID, batches[1].ID, 9999}})
	var response struct {
		Data services.ClearExpiredInventoryResult `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 || response.Data.Removed != 1 || response.Data.Skipped != 2 {
		t.Fatalf("wrong cleanup response: %d %s err=%v", w.Code, w.Body.String(), err)
	}
	for _, ids := range [][]uint{nil, {0}, {1, 1}} {
		if w := serveJSON(t, ClearExpiredFridge, "POST", "/fridge/clear-expired", map[string]any{"batch_ids": ids}); w.Code != 400 {
			t.Fatalf("invalid selection accepted: %v %d %s", ids, w.Code, w.Body.String())
		}
	}
}

func TestFridgeReadFailuresReturnServerErrors(t *testing.T) {
	for _, table := range []string{"home_inventory", "dishes", "settings"} {
		t.Run(table, func(t *testing.T) {
			db := setupHandlerTestDB(t, &models.InventoryBatch{}, &models.Dish{}, &models.Setting{})
			if err := db.Callback().Query().Before("gorm:query").Register("test:fail_fridge_read", func(tx *gorm.DB) {
				if tx.Statement.Table == table {
					tx.AddError(errors.New("read unavailable"))
				}
			}); err != nil {
				t.Fatal(err)
			}
			if w := serveJSON(t, GetFridgeRecipes, "GET", "/fridge/recipes", nil); w.Code != 500 {
				t.Fatalf("recommendation read failure hidden: %d %s", w.Code, w.Body.String())
			}
			if table == "home_inventory" {
				for _, handler := range []gin.HandlerFunc{GetFridge, GetUrgentInventory} {
					if w := serveJSON(t, handler, "GET", "/fridge", nil); w.Code != 500 {
						t.Fatalf("inventory read failure hidden: %d %s", w.Code, w.Body.String())
					}
				}
				if w := serveJSON(t, ClearExpiredFridge, "POST", "/fridge/clear-expired", map[string]any{"batch_ids": []uint{1}}); w.Code != 500 {
					t.Fatalf("cleanup read failure hidden: %d %s", w.Code, w.Body.String())
				}
			}
		})
	}
}
