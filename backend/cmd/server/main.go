package main

import (
	"fmt"
	"ninimenu/internal/config"
	"ninimenu/internal/database"
	"ninimenu/internal/routes"

	"github.com/gin-gonic/gin"
)

func main() {
	config.Load()

	if err := database.Init(); err != nil {
		panic(fmt.Sprintf("数据库初始化失败: %v", err))
	}
	database.StartAutoBackup(config.C.DBBackupDir, config.C.DBBackupKeep)

	r := gin.Default()
	routes.Setup(r)

	fmt.Printf("NiniMenu 启动成功！访问 http://localhost:%s\n", config.C.Port)
	if err := r.Run(":" + config.C.Port); err != nil {
		panic(fmt.Sprintf("启动失败: %v", err))
	}
}
