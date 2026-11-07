package handlers

import (
	"fmt"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRecordConsumptionEndpoints(t *testing.T) {
	db := setupHandlerTestDB(t, &models.MealRecord{}, &models.InventoryBatch{}, &models.RecordConsumption{})
	record := models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: services.TodayDate(), Status: models.MealCompleted}
	db.Create(&record)
	batch := models.InventoryBatch{ItemName: "番茄", InStock: true, Quantity: "1000克"}
	db.Create(&batch)
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(record.ID)}}
	body := map[string]any{"batch_ids": []uint{batch.ID}}
	w := serveJSON(t, ApplyRecordConsumption, "POST", "/api/records/1/consumption", body, params...)
	if w.Code != 400 {
		t.Fatalf("missing version should be rejected: %d %s", w.Code, w.Body.String())
	}
	body["expected_batches"] = []services.ExpectedConsumptionBatch{{BatchID: batch.ID, Quantity: batch.Quantity, UpdatedAt: batch.UpdatedAt}}
	w = serveJSON(t, ApplyRecordConsumption, "POST", "/api/records/1/consumption", body, params...)
	if w.Code != 200 {
		t.Fatalf("valid consume failed: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, ApplyRecordConsumption, "POST", "/api/records/1/consumption", body, params...)
	if w.Code != 400 {
		t.Fatalf("duplicate should be rejected: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, GetRecordConsumption, "GET", "/api/records/1/consumption", nil, params...)
	if w.Code != 200 {
		t.Fatalf("history failed: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, UndoRecordConsumption, "POST", "/api/records/1/consumption/undo", nil, params...)
	if w.Code != 400 {
		t.Fatalf("missing undo identity should be rejected: %d %s", w.Code, w.Body.String())
	}
	history, err := services.GetRecordConsumptionHistory(record.ID)
	if err != nil || len(history.Entries) != 1 {
		t.Fatalf("missing history: %+v %v", history, err)
	}
	w = serveJSON(t, UndoRecordConsumption, "POST", "/api/records/1/consumption/undo", map[string]any{"entry_id": history.Entries[0].ID}, params...)
	if w.Code != 200 {
		t.Fatalf("undo failed: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, GetRecordConsumption, "GET", "/api/records/999/consumption", nil, gin.Param{Key: "id", Value: "999"})
	if w.Code != 404 {
		t.Fatalf("missing record should be 404: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, GetRecordConsumption, "GET", "/api/records/no/consumption", nil, gin.Param{Key: "id", Value: "no"})
	if w.Code != 400 {
		t.Fatalf("invalid id should be 400: %d %s", w.Code, w.Body.String())
	}
}
