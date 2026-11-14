package handlers

import (
	"net/http"
	"ninimenu/internal/config"
	"ninimenu/internal/middleware"
	"ninimenu/internal/utils"

	"github.com/gin-gonic/gin"
)

type LoginRequest struct {
	Password string `json:"password" binding:"required"`
}

func AppLogin(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<10)
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "密码不能为空")
		return
	}

	if !middleware.VerifyPassword(c, middleware.AppPasswordScope, req.Password, config.C.AppPassword, true) {
		return
	}

	utils.Success(c, gin.H{"verified": true})
}

func Login(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<10)
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "密码不能为空")
		return
	}

	if !middleware.VerifyPassword(c, middleware.AdminPasswordScope, req.Password, config.C.AdminPassword, true) {
		return
	}

	token, err := middleware.GenerateToken()
	if err != nil {
		utils.InternalError(c, "生成Token失败")
		return
	}

	utils.Success(c, gin.H{"token": token})
}
