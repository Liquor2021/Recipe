package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sort"
	"time"

	"gorm.io/gorm"
)

var ErrShoppingInventoryChanged = errors.New("库存已变化，请刷新后核对要移出的批次")

type availableInventorySnapshot struct {
	BatchIDs []uint
	Version  string
}

// 可用批次的计数和版本来自同一次读取。真别名共用同一快照；过期批次不在
// “家中有”的展示和删除范围内。日期也参与校验，跨日后需重新核对。
func availableInventorySnapshots(tx *gorm.DB, now time.Time) (map[string]availableInventorySnapshot, error) {
	var batches []models.InventoryBatch
	if err := tx.Where("in_stock = ?", true).Find(&batches).Error; err != nil {
		return nil, err
	}
	type batchSnapshot struct {
		ID         uint
		ItemName   string
		Quantity   string
		ExpiryDate string
		UpdatedAt  string
	}
	grouped := make(map[string][]batchSnapshot)
	for _, batch := range batches {
		if daysLeftFor(batch.ExpiryDate, now) < 0 {
			continue
		}
		name := ingredients.Normalize(batch.ItemName)
		grouped[name] = append(grouped[name], batchSnapshot{
			ID: batch.ID, ItemName: batch.ItemName, Quantity: batch.Quantity,
			ExpiryDate: batch.ExpiryDate, UpdatedAt: batch.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	result := make(map[string]availableInventorySnapshot, len(grouped))
	for name, rows := range grouped {
		sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
		ids := make([]uint, len(rows))
		for i, row := range rows {
			ids[i] = row.ID
		}
		data, _ := json.Marshal(struct {
			Schema string
			Name   string
			Date   string
			Rows   []batchSnapshot
		}{"available-inventory-v1", name, now.Format("2006-01-02"), rows})
		digest := sha256.Sum256(data)
		result[name] = availableInventorySnapshot{BatchIDs: ids, Version: hex.EncodeToString(digest[:])}
	}
	return result, nil
}
