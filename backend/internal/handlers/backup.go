package handlers

import (
	"ninimenu/internal/config"
	"ninimenu/internal/database"
	"ninimenu/internal/utils"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
)

// ListBackups 后台查看自动备份情况
func ListBackups(c *gin.Context) {
	files, err := database.ListBackups(config.C.DBBackupDir)
	if err != nil {
		utils.InternalError(c, "读取备份目录失败")
		return
	}
	utils.Success(c, gin.H{"keep": config.C.DBBackupKeep, "dir": config.C.DBBackupDir, "files": files})
}

// DownloadBackup 现做一份完整的数据库副本供下载（不含上传的图片）
func DownloadBackup(c *gin.Context) {
	tmpDir, err := os.MkdirTemp("", "ninimenu-export-")
	if err != nil {
		utils.InternalError(c, "导出失败")
		return
	}
	defer os.RemoveAll(tmpDir)
	path := filepath.Join(tmpDir, "export.db")
	if err := database.SnapshotTo(database.DB, path); err != nil {
		utils.InternalError(c, "导出失败")
		return
	}
	c.FileAttachment(path, "ninimenu-"+time.Now().Format("2006-01-02-150405")+".db")
}
