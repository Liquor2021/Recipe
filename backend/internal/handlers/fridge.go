package handlers

import (
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strconv"

	"github.com/gin-gonic/gin"
)

func GetFridge(c *gin.Context) {
	utils.Success(c, services.ListHomeInventoryItems())
}

type AddFridgeRequest struct {
	ItemName string `json:"item_name" binding:"required"`
}

func AddFridge(c *gin.Context) {
	var req AddFridgeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请输入食材名称")
		return
	}
	if !services.AddHomeInventoryItem(req.ItemName) {
		utils.BadRequest(c, "请输入食材名称")
		return
	}
	services.QueueAutoAchievementSync()
	utils.SuccessMsg(c, "已放入冰箱")
}

func RemoveFridge(c *gin.Context) {
	itemName := c.Param("itemName")
	if itemName == "" {
		utils.BadRequest(c, "参数无效")
		return
	}
	services.RemoveHomeInventoryItem(itemName)
	utils.SuccessMsg(c, "已移出冰箱")
}

func GetFridgeRecipes(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "12"))
	utils.Success(c, services.MatchFridgeRecipes(limit))
}
