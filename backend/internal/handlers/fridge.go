package handlers

import (
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
	if !services.CreateInventoryBatch(req.ItemName, req.Quantity, req.ExpiryDate) {
		utils.BadRequest(c, "请输入食材名称")
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
	if !services.UpdateInventoryBatch(uint(id), req.Quantity, req.ExpiryDate) {
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
	if !services.RemoveInventoryBatch(uint(id)) {
		utils.NotFound(c, "批次不存在")
		return
	}
	utils.SuccessMsg(c, "已移出冰箱")
}

func RemoveFridge(c *gin.Context) {
	itemName := c.Param("itemName")
	if itemName == "" {
		utils.BadRequest(c, "参数无效")
		return
	}
	services.RemoveInventoryItem(itemName)
	utils.SuccessMsg(c, "已移出冰箱")
}

func GetFridgeRecipes(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "12"))
	utils.Success(c, services.MatchFridgeRecipes(limit))
}

func GetUrgentInventory(c *gin.Context) {
	utils.Success(c, services.UrgentInventoryItems())
}
