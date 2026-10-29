package main

import (
	"fmt"
	"ninimenu/internal/config"
	"ninimenu/internal/database"
	"ninimenu/internal/routes"
	"strings"

	"github.com/gin-gonic/gin"
)

func main() {
	config.Load()

	if err := database.Init(); err != nil {
		panic(fmt.Sprintf("数据库初始化失败: %v", err))
	}
	database.StartAutoBackup(config.C.DBBackupDir, config.C.DBBackupKeep)
	if names := config.C.InsecureDefaults(); len(names) > 0 {
		fmt.Printf("[安全提醒] %s 仍是默认值，部署到局域网或公网前请在 .env 里改掉（默认值只适合本机试用）\n", strings.Join(names, "、"))
	}

	r := gin.Default()
	routes.Setup(r)

	fmt.Printf("NiniMenu 启动成功！访问 http://localhost:%s\n", config.C.Port)
	if err := r.Run(":" + config.C.Port); err != nil {
		panic(fmt.Sprintf("启动失败: %v", err))
	}
}
