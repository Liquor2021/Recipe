package handlers

import (
	"ninimenu/internal/services"
	"ninimenu/internal/utils"

	"github.com/gin-gonic/gin"
)

func GetReport(c *gin.Context) {
	report, err := services.GetDietReport(c.DefaultQuery("range", "week"))
	if err != nil {
		utils.InternalError(c, "读取饮食报告失败")
		return
	}
	utils.Success(c, report)
}
