package handlers

import (
	"errors"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func GetFridge(c *gin.Context) {
	utils.Success(c, services.ListInventoryBatches())
}

type AddFridgeRequest struct {
	ItemName   string `json:"item_name" binding:"required"`
	Quantity   string `json:"quantity"`
	ExpiryDate string `json:"expiry_date"`
}

func validExpiryDate(s string) bool {
	if s == "" {
		return true
	}
	_, err := time.ParseInLocation("2006-01-02", s, time.Local)
	return err == nil
}

// AddFridge 新增一批食材：同一食材可以有多批
func AddFridge(c *gin.Context) {
	var req AddFridgeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请输入食材名称")
		return
	}
	req.ItemName = strings.TrimSpace(req.ItemName)
	req.ExpiryDate = strings.TrimSpace(req.ExpiryDate)
	if req.ItemName == "" {
		utils.BadRequest(c, "请输入食材名称")
		return
	}
	if !validExpiryDate(req.ExpiryDate) {
		utils.BadRequest(c, "保质期日期格式应为 YYYY-MM-DD")
		return
	}
	if err := services.CreateInventoryBatch(req.ItemName, req.Quantity, req.ExpiryDate); err != nil {
		if errors.Is(err, services.ErrEmptyItemName) {
			utils.BadRequest(c, "请输入食材名称")
			return
		}
		utils.InternalError(c, "放入冰箱失败")
		return
	}
	services.QueueAutoAchievementSync()
	utils.SuccessMsg(c, "已放入冰箱")
}

type UpdateFridgeBatchRequest struct {
	Quantity   string `json:"quantity"`
	ExpiryDate string `json:"expiry_date"`
}

// UpdateFridgeBatch 编辑某批次的质量字段
func UpdateFridgeBatch(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	var req UpdateFridgeBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	if !validExpiryDate(strings.TrimSpace(req.ExpiryDate)) {
		utils.BadRequest(c, "保质期日期格式应为 YYYY-MM-DD")
		return
	}
	found, err := services.UpdateInventoryBatch(uint(id), req.Quantity, req.ExpiryDate)
	if err != nil {
		utils.InternalError(c, "保存失败")
		return
	}
	if !found {
		utils.NotFound(c, "批次不存在")
		return
	}
	utils.SuccessMsg(c, "已更新")
}

// RemoveFridgeBatch 移出单批食材（扣库存先进先出用）
func RemoveFridgeBatch(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	removed, err := services.RemoveInventoryBatch(uint(id))
	if err != nil {
		utils.InternalError(c, "移出失败")
		return
	}
	if !removed {
		utils.NotFound(c, "批次不存在")
		return
	}
	utils.SuccessMsg(c, "已移出冰箱")
}

func RemoveFridge(c *gin.Context) {
	itemName := strings.TrimSpace(c.Param("itemName"))
	if itemName == "" {
		utils.BadRequest(c, "参数无效")
		return
	}
	if err := services.RemoveInventoryItem(itemName); err != nil {
		utils.InternalError(c, "移出失败")
		return
	}
	utils.SuccessMsg(c, "已移出冰箱")
}

// GetFridgeConsumption 某道菜做完后可扣减的库存批次（按菜谱主料精确/别名匹配）
func GetFridgeConsumption(c *gin.Context) {
	dishID, err := strconv.ParseUint(c.Query("dish_id"), 10, 64)
	if err != nil || dishID == 0 {
		utils.BadRequest(c, "参数无效")
		return
	}
	match, found, err := services.MatchDishConsumption(uint(dishID))
	if err != nil {
		utils.InternalError(c, "读取冰箱库存失败")
		return
	}
	if !found {
		utils.NotFound(c, "菜品不存在")
		return
	}
	utils.Success(c, match)
}

type ConsumeFridgeRequest struct {
	// BatchIDs 整批用完、移出冰箱的批次
	BatchIDs []uint `json:"batch_ids"`
	// Remaining 用了一部分、还剩一些的批次：只把数量改成剩余量
	Remaining []struct {
		BatchID  uint   `json:"batch_id"`
		Quantity string `json:"quantity"`
	} `json:"remaining"`
}

// ConsumeFridgeBatches 做完菜后更新冰箱：用完的批次移出、用了一部分的改成剩余量（同一事务）
func ConsumeFridgeBatches(c *gin.Context) {
	var req ConsumeFridgeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	total := len(req.BatchIDs) + len(req.Remaining)
	if total == 0 || total > 100 {
		utils.BadRequest(c, "请选择要更新的批次（一次最多 100 批）")
		return
	}
	seen := make(map[uint]bool, total)
	for _, id := range req.BatchIDs {
		if id == 0 || seen[id] {
			utils.BadRequest(c, "批次参数无效")
			return
		}
		seen[id] = true
	}
	remaining := make([]services.BatchRemaining, 0, len(req.Remaining))
	for _, r := range req.Remaining {
		qty := strings.TrimSpace(r.Quantity)
		if r.BatchID == 0 || seen[r.BatchID] {
			utils.BadRequest(c, "批次参数无效")
			return
		}
		if qty == "" || len([]rune(qty)) > 50 {
			utils.BadRequest(c, "请填写剩余数量")
			return
		}
		seen[r.BatchID] = true
		remaining = append(remaining, services.BatchRemaining{BatchID: r.BatchID, Quantity: qty})
	}
	removed, updated, err := services.ConsumeInventory(req.BatchIDs, remaining)
	if err != nil {
		utils.InternalError(c, "更新冰箱失败")
		return
	}
	utils.Success(c, gin.H{"removed": removed, "updated": updated})
}

func GetFridgeRecipes(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "12"))
	utils.Success(c, services.MatchFridgeRecipes(limit))
}

func GetUrgentInventory(c *gin.Context) {
	utils.Success(c, services.UrgentInventoryItems())
}
