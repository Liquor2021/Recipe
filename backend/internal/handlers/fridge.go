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
	BatchIDs []uint `json:"batch_ids" binding:"required,min=1,max=100"`
}

// ConsumeFridgeBatches 做完菜后一次扣掉多个批次（单条语句，要么全部生效要么都不生效）
func ConsumeFridgeBatches(c *gin.Context) {
	var req ConsumeFridgeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请选择要移出的批次")
		return
	}
	removed, err := services.ConsumeInventoryBatches(req.BatchIDs)
	if err != nil {
		utils.InternalError(c, "移出失败")
		return
	}
	utils.Success(c, gin.H{"removed": removed})
}

func GetFridgeRecipes(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "12"))
	utils.Success(c, services.MatchFridgeRecipes(limit))
}

func GetUrgentInventory(c *gin.Context) {
	utils.Success(c, services.UrgentInventoryItems())
}
