package handlers

import (
	"github.com/gin-gonic/gin"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strconv"
)

func GetShoppingPlanSettings(c *gin.Context) {
	days, err := services.ShoppingPlanDays(database.DB)
	if err != nil {
		utils.InternalError(c, "读取采购范围失败")
		return
	}
	utils.Success(c, gin.H{"days": days})
}

func UpdateShoppingPlanSettings(c *gin.Context) {
	var req struct {
		Days int `json:"days"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Days != 2 && req.Days != 7) {
		utils.BadRequest(c, "请选择今天和明天，或未来7天")
		return
	}
	setting := models.Setting{Key: "shopping_plan_days", Value: strconv.Itoa(req.Days)}
	if err := database.DB.Where("`key` = ?", setting.Key).Assign(setting).FirstOrCreate(&models.Setting{}).Error; err != nil {
		utils.InternalError(c, "保存采购范围失败")
		return
	}
	utils.Success(c, gin.H{"days": req.Days})
}
