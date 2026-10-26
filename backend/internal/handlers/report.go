package handlers

import (
	"ninimenu/internal/services"
	"ninimenu/internal/utils"

	"github.com/gin-gonic/gin"
)

func GetReport(c *gin.Context) {
	utils.Success(c, services.GetDietReport(c.DefaultQuery("range", "week")))
}
