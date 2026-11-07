package handlers

import (
	"encoding/json"
	"errors"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func confirmedConsumptionEntry(c *gin.Context, allowNone bool) (*uint, bool) {
	var req struct {
		EntryID json.RawMessage `json:"entry_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.EntryID) == 0 {
		utils.BadRequest(c, "请先读取库存扣减记录再确认撤销")
		return nil, false
	}
	var entryID *uint
	if err := json.Unmarshal(req.EntryID, &entryID); err != nil || (entryID == nil && !allowNone) || (entryID != nil && *entryID == 0) {
		utils.BadRequest(c, "库存扣减记录编号无效")
		return nil, false
	}
	return entryID, true
}

func consumptionRecordID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		utils.BadRequest(c, "记录编号无效")
		return 0, false
	}
	return uint(id), true
}

func recordConsumptionError(c *gin.Context, err error) {
	var inputError *services.ConsumptionInputError
	if errors.Is(err, gorm.ErrRecordNotFound) {
		utils.NotFound(c, "记录不存在")
	} else if errors.As(err, &inputError) {
		utils.BadRequest(c, inputError.Error())
	} else {
		utils.InternalError(c, "更新库存记录失败，请稍后重试")
	}
}

func GetRecordConsumption(c *gin.Context) {
	id, ok := consumptionRecordID(c)
	if !ok {
		return
	}
	history, err := services.GetRecordConsumptionHistory(id)
	if err != nil {
		recordConsumptionError(c, err)
		return
	}
	utils.Success(c, history)
}

func ApplyRecordConsumption(c *gin.Context) {
	id, ok := consumptionRecordID(c)
	if !ok {
		return
	}
	var req struct {
		BatchIDs        []uint                              `json:"batch_ids"`
		RemoveIDs       []uint                              `json:"remove_ids"`
		ExpectedBatches []services.ExpectedConsumptionBatch `json:"expected_batches"`
		Remaining       []struct {
			BatchID  uint   `json:"batch_id"`
			Quantity string `json:"quantity"`
		} `json:"remaining"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	remaining := make([]services.BatchRemaining, 0, len(req.Remaining))
	for _, item := range req.Remaining {
		remaining = append(remaining, services.BatchRemaining{BatchID: item.BatchID, Quantity: item.Quantity})
	}
	result, err := services.ApplyRecordConsumption(id, append(req.BatchIDs, req.RemoveIDs...), remaining, req.ExpectedBatches)
	if err != nil {
		recordConsumptionError(c, err)
		return
	}
	utils.Success(c, result)
}

func UndoRecordConsumption(c *gin.Context) {
	id, ok := consumptionRecordID(c)
	if !ok {
		return
	}
	entryID, ok := confirmedConsumptionEntry(c, false)
	if !ok {
		return
	}
	if err := services.RevertRecordConsumption(id, *entryID); err != nil {
		recordConsumptionError(c, err)
		return
	}
	utils.Success(c, gin.H{"applied": false})
}

func UndoMealCompletion(c *gin.Context) {
	id, ok := consumptionRecordID(c)
	if !ok {
		return
	}
	entryID, ok := confirmedConsumptionEntry(c, true)
	if !ok {
		return
	}
	record, err := services.RevertMealCompletion(id, entryID)
	if err != nil {
		recordConsumptionError(c, err)
		return
	}
	services.QueueAutoAchievementSync()
	utils.Success(c, record)
}
