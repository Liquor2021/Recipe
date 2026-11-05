package handlers

import (
	"errors"
	"net/http"
	"ninimenu/internal/config"
	imgproc "ninimenu/internal/imaging"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// thumbDirName 缩略图缓存目录（在上传目录下）。/thumbs/<路径> 对应 /uploads/<路径> 的列表缩略图
const thumbDirName = "_thumbs"

// thumbSlots 同时生成缩略图的上限：一张 1200px 原图解码后约 4MB，列表一屏几十张图并发请求时不至于吃满内存/CPU
var thumbSlots = make(chan struct{}, 2)

var thumbExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true}

// resolveUploadPath 把上传目录下的相对路径（URL 里的 / 分隔）解析成绝对路径；
// 越出上传目录或指向目录本身时 ok=false
func resolveUploadPath(rel string) (root, abs string, ok bool) {
	root, err := filepath.Abs(config.C.UploadDir)
	if err != nil {
		return "", "", false
	}
	abs, err = filepath.Abs(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", "", false
	}
	r, err := filepath.Rel(root, abs)
	if err != nil || r == "." || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) || filepath.IsAbs(r) {
		return "", "", false
	}
	return root, abs, true
}

// thumbPathFor 原图对应的缩略图缓存文件：保留原扩展名再加 .jpg（a.png 与 a.jpg 不会撞名）
func thumbPathFor(root, src string) string {
	r, _ := filepath.Rel(root, src)
	return filepath.Join(root, thumbDirName, r+".jpg")
}

// GetThumbnail 列表用缩略图：第一次请求时按原图生成并缓存，原图更新后自动重新生成。
// 原图已经够小或生成失败时直接返回原图，列表里永远有图可显示；原图不存在返回 404
func GetThumbnail(c *gin.Context) {
	rel := strings.TrimPrefix(c.Param("filepath"), "/")
	root, src, ok := resolveUploadPath(rel)
	if !ok || !thumbExts[strings.ToLower(filepath.Ext(src))] {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	// 不给缩略图再做缩略图（否则可以一层层套出无数文件）
	if r, _ := filepath.Rel(root, src); strings.SplitN(r, string(filepath.Separator), 2)[0] == thumbDirName {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	srcInfo, err := os.Stat(src)
	if err != nil || srcInfo.IsDir() {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}

	dst := thumbPathFor(root, src)
	fresh := func() bool {
		info, err := os.Stat(dst)
		return err == nil && !info.ModTime().Before(srcInfo.ModTime())
	}
	if !fresh() {
		thumbSlots <- struct{}{}
		// 排队期间可能已有别的请求生成好了
		if !fresh() {
			err = imgproc.MakeThumbnail(src, dst)
		}
		<-thumbSlots
		if err != nil {
			// 原图够小：长期缓存原图；生成失败：不让浏览器长期缓存，下次再试
			if errors.Is(err, imgproc.ErrThumbNotNeeded) {
				c.Header("Cache-Control", "public, max-age=86400")
			} else {
				c.Header("Cache-Control", "no-cache")
			}
			c.File(src)
			return
		}
	}
	c.Header("Cache-Control", "public, max-age=86400")
	c.File(dst)
}

// removeThumbnail 删除原图时一并删掉缓存的缩略图（没有就算了）
func removeThumbnail(root, src string) {
	_ = os.Remove(thumbPathFor(root, src))
}
