package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"strings"
	"time"

	"gorm.io/gorm"
)

// ConsumptionInputError 表示需要用户调整输入或处理库存冲突，而非服务故障。
type ConsumptionInputError struct{ Message string }

func (e *ConsumptionInputError) Error() string { return e.Message }

func consumptionInputError(message string) error {
	return &ConsumptionInputError{Message: message}
}

type inventorySnapshot struct {
	Before models.InventoryBatch  `json:"before"`
	After  *models.InventoryBatch `json:"after"`
}

type RecordConsumptionItem struct {
	BatchID        uint   `json:"batch_id"`
	ItemName       string `json:"item_name"`
	BeforeQuantity string `json:"before_quantity"`
	AfterQuantity  string `json:"after_quantity"`
	Removed        bool   `json:"removed"`
}

type RecordConsumptionEntry struct {
	ID         uint                    `json:"id"`
	RecordID   uint                    `json:"record_id"`
	Status     string                  `json:"status"`
	CreatedAt  time.Time               `json:"created_at"`
	RevertedAt *time.Time              `json:"reverted_at,omitempty"`
	Items      []RecordConsumptionItem `json:"items"`
}

type RecordConsumptionHistory struct {
	Applied bool                     `json:"applied"`
	Entries []RecordConsumptionEntry `json:"entries"`
}

type RecordConsumptionResult struct {
	Removed int64 `json:"removed"`
	Updated int64 `json:"updated"`
	Applied bool  `json:"applied"`
}

// ExpectedConsumptionBatch 是用户打开扣减弹层时看到的批次版本。
// 提交时检查版本，避免另一顿或另一台设备更新后的库存被旧剩余量覆盖。
type ExpectedConsumptionBatch struct {
	BatchID   uint      `json:"batch_id"`
	Quantity  string    `json:"quantity"`
	UpdatedAt time.Time `json:"updated_at"`
}

func GetRecordConsumptionHistory(recordID uint) (RecordConsumptionHistory, error) {
	history := RecordConsumptionHistory{Entries: []RecordConsumptionEntry{}}
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		var record models.MealRecord
		if err := tx.First(&record, recordID).Error; err != nil {
			return err
		}
		history.Applied = record.InventoryApplied
		var receipts []models.RecordConsumption
		if err := tx.Where("record_id = ?", recordID).Order("id DESC").Find(&receipts).Error; err != nil {
			return err
		}
		for _, receipt := range receipts {
			var snapshots []inventorySnapshot
			if err := json.Unmarshal([]byte(receipt.Snapshots), &snapshots); err != nil {
				return fmt.Errorf("读取库存快照失败: %w", err)
			}
			entry := RecordConsumptionEntry{ID: receipt.ID, RecordID: receipt.RecordID, Status: receipt.Status,
				CreatedAt: receipt.CreatedAt, RevertedAt: receipt.RevertedAt, Items: []RecordConsumptionItem{}}
			for _, snapshot := range snapshots {
				item := RecordConsumptionItem{BatchID: snapshot.Before.ID, ItemName: snapshot.Before.ItemName,
					BeforeQuantity: snapshot.Before.Quantity, Removed: snapshot.After == nil}
				if snapshot.After != nil {
					item.AfterQuantity = snapshot.After.Quantity
				}
				entry.Items = append(entry.Items, item)
			}
			history.Entries = append(history.Entries, entry)
		}
		return nil
	})
	return history, err
}

// ApplyRecordConsumption 把扣减与用餐记录关联并原子保存。
// 先条件更新用餐记录，SQLite 在读取批次前取得写锁，重复提交不会再次修改库存。
func ApplyRecordConsumption(recordID uint, removeIDs []uint, remaining []BatchRemaining, expected []ExpectedConsumptionBatch) (RecordConsumptionResult, error) {
	result := RecordConsumptionResult{}
	total := len(removeIDs) + len(remaining)
	if total == 0 || total > 100 {
		return result, consumptionInputError("请选择要更新的批次（一次最多 100 批）")
	}
	seen := make(map[uint]bool, total)
	ids := make([]uint, 0, total)
	quantities := make(map[uint]string, len(remaining))
	for _, id := range removeIDs {
		if id == 0 || seen[id] {
			return result, consumptionInputError("批次参数重复或无效")
		}
		seen[id] = true
		ids = append(ids, id)
	}
	for _, item := range remaining {
		quantity := strings.TrimSpace(item.Quantity)
		if item.BatchID == 0 || seen[item.BatchID] {
			return result, consumptionInputError("批次参数重复或无效")
		}
		if quantity == "" || len([]rune(quantity)) > 50 {
			return result, consumptionInputError("请填写剩余数量（最多 50 字）")
		}
		seen[item.BatchID] = true
		ids = append(ids, item.BatchID)
		quantities[item.BatchID] = quantity
	}
	versions := make(map[uint]ExpectedConsumptionBatch, total)
	for _, version := range expected {
		if !seen[version.BatchID] || version.UpdatedAt.IsZero() {
			return result, consumptionInputError("库存版本信息不完整，请刷新后重新选择")
		}
		if _, duplicate := versions[version.BatchID]; duplicate {
			return result, consumptionInputError("库存版本信息重复，请刷新后重新选择")
		}
		versions[version.BatchID] = version
	}
	if len(versions) != total {
		return result, consumptionInputError("库存版本信息不完整，请刷新后重新选择")
	}
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		claim := tx.Model(&models.MealRecord{}).
			Where("id = ? AND status = ? AND meal_date <= ? AND inventory_applied = ?", recordID, models.MealCompleted, TodayDate(), false).
			Update("inventory_applied", true)
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 {
			var record models.MealRecord
			if err := tx.First(&record, recordID).Error; err != nil {
				return err
			}
			if record.InventoryApplied {
				return consumptionInputError("这顿已经扣过库存，请先查看或撤销扣减记录")
			}
			return consumptionInputError("只有已吃过的用餐记录才能扣减库存")
		}
		var batches []models.InventoryBatch
		if err := tx.Where("id IN ? AND in_stock = ?", ids, true).Find(&batches).Error; err != nil {
			return err
		}
		if len(batches) != total {
			return consumptionInputError("部分库存已被移出，请刷新后重新选择")
		}
		for _, batch := range batches {
			version := versions[batch.ID]
			if batch.Quantity != version.Quantity || !batch.UpdatedAt.Equal(version.UpdatedAt) {
				return consumptionInputError("库存已变动，请刷新后重新选择")
			}
		}
		snapshots := make([]inventorySnapshot, 0, total)
		for _, batch := range batches {
			snapshot := inventorySnapshot{Before: batch}
			if quantity, partial := quantities[batch.ID]; partial {
				if err := tx.Model(&models.InventoryBatch{}).Where("id = ?", batch.ID).Update("quantity", quantity).Error; err != nil {
					return err
				}
				var after models.InventoryBatch
				if err := tx.First(&after, batch.ID).Error; err != nil {
					return err
				}
				snapshot.After = &after
				result.Updated++
			} else {
				if err := tx.Delete(&batch).Error; err != nil {
					return err
				}
				result.Removed++
			}
			snapshots = append(snapshots, snapshot)
		}
		raw, err := json.Marshal(snapshots)
		if err != nil {
			return err
		}
		receipt := models.RecordConsumption{RecordID: recordID, ActiveRecordID: &recordID,
			Status: models.ConsumptionApplied, Snapshots: string(raw)}
		if err := tx.Create(&receipt).Error; err != nil {
			return err
		}
		result.Applied = true
		return nil
	})
	if err != nil {
		return RecordConsumptionResult{}, err
	}
	return result, nil
}

func sameInventorySnapshot(a, b models.InventoryBatch) bool {
	return a.ID == b.ID && a.ItemName == b.ItemName && a.InStock == b.InStock &&
		a.Quantity == b.Quantity && a.ExpiryDate == b.ExpiryDate &&
		a.CreatedAt.Equal(b.CreatedAt) && a.UpdatedAt.Equal(b.UpdatedAt)
}

// UndoRecordConsumption 必须在调用方事务内运行；校验全部快照后才恢复，
// 后续消费或手工修改过的批次不能被旧记录覆盖。重复撤销不会重复补回库存。
func UndoRecordConsumption(tx *gorm.DB, recordID uint, expectedEntryID *uint) error {
	if expectedEntryID != nil && *expectedEntryID == 0 {
		return consumptionInputError("请选择有效的库存扣减记录")
	}
	claim := tx.Model(&models.MealRecord{}).Where("id = ? AND inventory_applied = ?", recordID, true).
		Update("inventory_applied", false)
	if claim.Error != nil {
		return claim.Error
	}
	if claim.RowsAffected == 0 {
		var record models.MealRecord
		if err := tx.First(&record, recordID).Error; err != nil {
			return err
		}
		if expectedEntryID == nil {
			return nil
		}
		// 仅对同一条已经撤销的记录接受重试，不能把任意过期确认当成新的撤销。
		var previous models.RecordConsumption
		if err := tx.Where("id = ? AND record_id = ? AND status = ?", *expectedEntryID, recordID, models.ConsumptionReverted).First(&previous).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return consumptionInputError("库存扣减记录已变动，请刷新后重新确认")
			}
			return err
		}
		return nil
	}
	var receipt models.RecordConsumption
	if err := tx.Where("active_record_id = ?", recordID).First(&receipt).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return consumptionInputError("没有找到这顿的扣减快照，请在冰箱中核对库存")
		}
		return err
	}
	if expectedEntryID == nil || receipt.ID != *expectedEntryID {
		return consumptionInputError("库存扣减记录已变动，请刷新后重新确认")
	}
	var snapshots []inventorySnapshot
	if err := json.Unmarshal([]byte(receipt.Snapshots), &snapshots); err != nil {
		return err
	}
	if len(snapshots) == 0 {
		return consumptionInputError("这顿的库存快照不完整，暂时无法撤销")
	}
	for _, snapshot := range snapshots {
		var current models.InventoryBatch
		err := tx.First(&current, snapshot.Before.ID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		matches := snapshot.After == nil && errors.Is(err, gorm.ErrRecordNotFound)
		if snapshot.After != nil && err == nil {
			matches = sameInventorySnapshot(current, *snapshot.After)
		}
		if !matches {
			return consumptionInputError(fmt.Sprintf("%s 的库存之后已有变动，请先撤销后续扣减或在冰箱中核对，暂不能撤销这次扣减", snapshot.Before.ItemName))
		}
	}
	for _, snapshot := range snapshots {
		before := snapshot.Before
		if snapshot.After == nil {
			if err := tx.Create(&before).Error; err != nil {
				return err
			}
		} else {
			// 精确恢复时间戳，让同批次按相反顺序撤销多顿消费时仍可匹配前一份快照。
			if err := tx.Model(&models.InventoryBatch{}).Where("id = ?", before.ID).UpdateColumns(map[string]any{
				"item_name": before.ItemName, "in_stock": before.InStock, "quantity": before.Quantity,
				"expiry_date": before.ExpiryDate, "created_at": before.CreatedAt, "updated_at": before.UpdatedAt,
			}).Error; err != nil {
				return err
			}
		}
	}
	return tx.Model(&receipt).Updates(map[string]any{"active_record_id": nil, "status": models.ConsumptionReverted, "reverted_at": time.Now()}).Error
}

func RevertRecordConsumption(recordID, entryID uint) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		return UndoRecordConsumption(tx, recordID, &entryID)
	})
}

// RevertMealCompletion 撤销误记时，库存恢复和用餐状态回退在一个事务中完成。
func RevertMealCompletion(recordID uint, expectedEntryID *uint) (models.MealRecord, error) {
	var record models.MealRecord
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		// 条件写入同时取得 SQLite 写锁，防止另一请求在状态读取后补扣库存。
		lock := tx.Model(&models.MealRecord{}).Where("id = ? AND status = ?", recordID, models.MealCompleted).
			UpdateColumn("status", models.MealCompleted)
		if lock.Error != nil {
			return lock.Error
		}
		if err := tx.First(&record, recordID).Error; err != nil {
			return err
		}
		if record.Status == models.MealPlanned && !record.InventoryApplied {
			return UndoRecordConsumption(tx, recordID, expectedEntryID)
		}
		if record.Status != models.MealCompleted {
			return consumptionInputError("只有已吃的记录可以撤销完成")
		}
		if err := UndoRecordConsumption(tx, recordID, expectedEntryID); err != nil {
			return err
		}
		if err := tx.Model(&record).Updates(map[string]any{
			"status": models.MealPlanned, "rating": 0, "mood": "", "photo": "", "inventory_applied": false,
		}).Error; err != nil {
			return err
		}
		return tx.First(&record, recordID).Error
	})
	return record, err
}
