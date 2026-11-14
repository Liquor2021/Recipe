package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"ninimenu/internal/config"
	imgproc "ninimenu/internal/imaging"
	"ninimenu/internal/utils"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func randomSuffix() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(b[:])
}

func UploadImage(c *gin.Context) {
	// FormFile 会先解析整个 multipart；必须在解析前限制整份请求，而非只查已读入的单文件。
	requestLimit := config.C.MaxUploadSize + 64*1024
	if c.Request.ContentLength > requestLimit {
		utils.Error(c, http.StatusRequestEntityTooLarge, 41300, "上传请求过大，请缩小图片后重试")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, requestLimit)
	defer func() {
		if c.Request.MultipartForm != nil {
			_ = c.Request.MultipartForm.RemoveAll()
		}
	}()
	file, err := c.FormFile("image")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			utils.Error(c, http.StatusRequestEntityTooLarge, 41300, "上传请求过大，请缩小图片后重试")
			return
		}
		utils.BadRequest(c, "请选择图片")
		return
	}

	if file.Size > config.C.MaxUploadSize {
		maxMB := config.C.MaxUploadSize / 1024 / 1024
		utils.BadRequest(c, fmt.Sprintf("图片大小不能超过%dMB", maxMB))
		return
	}

	ext := strings.ToLower(filepath.Ext(file.Filename))
	allowedExts := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true}
	if !allowedExts[ext] {
		utils.BadRequest(c, "仅支持 jpg/png/webp 格式")
		return
	}

	mimeType := file.Header.Get("Content-Type")
	if mimeType != "" {
		mediaType, _, _ := mime.ParseMediaType(mimeType)
		if !strings.HasPrefix(mediaType, "image/") {
			utils.BadRequest(c, "文件类型不正确")
			return
		}
	}

	now := time.Now()
	dateDir := now.Format("2006/01/02")
	baseName := fmt.Sprintf("%d-%s", now.UnixMilli(), randomSuffix())

	uploadSubDir := filepath.Join(config.C.UploadDir, dateDir)
	if err := os.MkdirAll(uploadSubDir, 0755); err != nil {
		utils.InternalError(c, "创建上传目录失败")
		return
	}

	backupSubDir := filepath.Join(config.C.BackupDir, dateDir)
	if err := os.MkdirAll(backupSubDir, 0755); err != nil {
		utils.InternalError(c, "创建备份目录失败")
		return
	}

	backupPath := filepath.Join(backupSubDir, baseName+ext)
	keepBackup := false
	defer func() {
		if !keepBackup {
			// 包括保存中断的半文件、无法解码的输入和原图兜底失败。
			_ = os.Remove(backupPath)
		}
	}()
	if err := c.SaveUploadedFile(file, backupPath); err != nil {
		utils.InternalError(c, "保存原始图片失败")
		return
	}

	compressedPath, err := imgproc.ProcessUpload(
		backupPath, uploadSubDir, baseName,
		config.C.CompressMaxDim, config.C.JpegQuality,
	)
	if err != nil {
		if errors.Is(err, imgproc.ErrInvalidImage) {
			utils.BadRequest(c, "图片内容损坏或无法读取，请重新选择 jpg/png/webp 图片")
			return
		}
		if errors.Is(err, imgproc.ErrImageTooLarge) {
			utils.Error(c, http.StatusRequestEntityTooLarge, 41300, imgproc.ErrImageTooLarge.Error())
			return
		}
		if !errors.Is(err, imgproc.ErrImageProcessing) {
			utils.InternalError(c, "图片处理失败")
			return
		}
		// 只有完整解码过且仍然存在的非空原图，才允许作为压缩失败的兜底。
		info, statErr := os.Stat(backupPath)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			utils.InternalError(c, "图片处理失败")
			return
		}
		fallbackPath := filepath.Join(uploadSubDir, baseName+ext)
		if renameErr := os.Rename(backupPath, fallbackPath); renameErr != nil {
			utils.InternalError(c, "图片处理失败")
			return
		}
		keepBackup = true // 上传和备份目录相同时，原图已在最终位置，不能再清理。
		url := "/uploads/" + dateDir + "/" + baseName + ext
		utils.Success(c, gin.H{"url": url, "filename": baseName + ext})
		return
	}

	keepBackup = true
	filename := filepath.Base(compressedPath)
	url := "/uploads/" + dateDir + "/" + filename
	utils.Success(c, gin.H{"url": url, "filename": filename})
}

func DeleteImage(c *gin.Context) {
	var req struct {
		URL string `json:"url" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请提供图片URL")
		return
	}

	relURL := strings.TrimPrefix(req.URL, "/")
	if !strings.HasPrefix(relURL, "uploads/") {
		utils.BadRequest(c, "图片URL无效")
		return
	}

	uploadRoot, target, ok := resolveUploadPath(strings.TrimPrefix(relURL, "uploads/"))
	if !ok {
		utils.BadRequest(c, "图片URL无效")
		return
	}

	if _, err := os.Stat(target); err == nil {
		if err := os.Remove(target); err != nil {
			utils.InternalError(c, "删除失败")
			return
		}
	}
	removeThumbnail(uploadRoot, target)

	utils.SuccessMsg(c, "删除成功")
}
