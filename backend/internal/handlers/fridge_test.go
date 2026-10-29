package handlers

import (
	"encoding/json"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
)

func TestConsumeFridgeBatchesValidation(t *testing.T) {
	setupHandlerTestDB(t, &models.InventoryBatch{})
	tomato := models.InventoryBatch{ItemName: "番茄", Quantity: "2个", InStock: true}
	egg := models.InventoryBatch{ItemName: "鸡蛋", Quantity: "10个", InStock: true}
	database.DB.Create(&tomato)
	database.DB.Create(&egg)

	bad := []struct {
		note string
		body map[string]any
	}{
		{"什么都没选", map[string]any{}},
		{"同一批既移出又改数量", map[string]any{"batch_ids": []uint{egg.ID}, "remaining": []map[string]any{{"batch_id": egg.ID, "quantity": "7个"}}}},
		{"剩余数量为空", map[string]any{"remaining": []map[string]any{{"batch_id": egg.ID, "quantity": "  "}}}},
		{"批次 id 为 0", map[string]any{"batch_ids": []uint{0}}},
	}
	for _, tt := range bad {
		if w := serveJSON(t, ConsumeFridgeBatches, "POST", "/api/fridge/consume", tt.body); w.Code != 400 {
			t.Fatalf("[%s] 应返回 400, got %d %s", tt.note, w.Code, w.Body.String())
		}
	}

	w := serveJSON(t, ConsumeFridgeBatches, "POST", "/api/fridge/consume", map[string]any{
		"batch_ids": []uint{tomato.ID},
		"remaining": []map[string]any{{"batch_id": egg.ID, "quantity": "7个"}},
	})
	var resp struct {
		Data struct {
			Removed int64 `json:"removed"`
			Updated int64 `json:"updated"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || w.Code != 200 || resp.Data.Removed != 1 || resp.Data.Updated != 1 {
		t.Fatalf("应移出 1 批、更新 1 批, got %d %s", w.Code, w.Body.String())
	}
	var stored models.InventoryBatch
	database.DB.First(&stored, egg.ID)
	if stored.Quantity != "7个" {
		t.Fatalf("鸡蛋数量应为 7个, got %q", stored.Quantity)
	}
}
