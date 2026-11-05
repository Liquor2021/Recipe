package handlers

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http/httptest"
	"ninimenu/internal/config"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// useTempUploadDir 把上传目录换成临时目录（测试结束换回）
func useTempUploadDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := config.C.UploadDir
	config.C.UploadDir = dir
	t.Cleanup(func() { config.C.UploadDir = old })
	return dir
}

// writeTestImage 写一张 w×h 的渐变图；transparent 时写全透明 PNG
func writeTestImage(t *testing.T, path string, w, h int, transparent bool) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if transparent {
				a = 0
			}
			img.Set(x, y, color.NRGBA{R: uint8(x % 256), G: uint8(y % 256), B: 120, A: a})
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if filepath.Ext(path) == ".png" {
		err = png.Encode(f, img)
	} else {
		err = jpeg.Encode(f, img, &jpeg.Options{Quality: 90})
	}
	if err != nil {
		t.Fatal(err)
	}
}

func requestThumb(t *testing.T, rel string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("GET", "/thumbs/x", nil)
	c.Params = gin.Params{{Key: "filepath", Value: "/" + rel}}
	GetThumbnail(c)
	return w
}

func decodeSize(t *testing.T, body []byte) (int, int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("响应不是图片: %v", err)
	}
	return cfg.Width, cfg.Height
}

func TestGetThumbnailGeneratesCachesAndRefreshes(t *testing.T) {
	dir := useTempUploadDir(t)
	src := filepath.Join(dir, "2026", "11", "06", "a.jpg")
	writeTestImage(t, src, 1200, 800, false)

	w := requestThumb(t, "2026/11/06/a.jpg")
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if gw, gh := decodeSize(t, w.Body.Bytes()); gw != 600 || gh != 400 {
		t.Fatalf("缩略图 %dx%d, want 600x400（短边 400）", gw, gh)
	}
	cached := filepath.Join(dir, "_thumbs", "2026", "11", "06", "a.jpg.jpg")
	if _, err := os.Stat(cached); err != nil {
		t.Fatalf("缩略图应缓存到 %s: %v", cached, err)
	}
	if w.Body.Len() >= int(fileSize(t, src)) {
		t.Fatalf("缩略图 %d 字节，应比原图 %d 字节小", w.Body.Len(), fileSize(t, src))
	}

	// 原图换了（竖图）：缓存比原图旧就重新生成
	writeTestImage(t, src, 800, 1200, false)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(cached, old, old); err != nil {
		t.Fatal(err)
	}
	w = requestThumb(t, "2026/11/06/a.jpg")
	if gw, gh := decodeSize(t, w.Body.Bytes()); gw != 400 || gh != 600 {
		t.Fatalf("原图更新后应重新生成, got %dx%d want 400x600", gw, gh)
	}
}

func TestGetThumbnailSmallImageAndTransparency(t *testing.T) {
	dir := useTempUploadDir(t)
	// 原图本来就小：直接返回原图，不写缓存
	writeTestImage(t, filepath.Join(dir, "small.jpg"), 300, 200, false)
	w := requestThumb(t, "small.jpg")
	if gw, gh := decodeSize(t, w.Body.Bytes()); w.Code != 200 || gw != 300 || gh != 200 {
		t.Fatalf("小图应原样返回, got %d %dx%d", w.Code, gw, gh)
	}
	if _, err := os.Stat(filepath.Join(dir, "_thumbs", "small.jpg.jpg")); !os.IsNotExist(err) {
		t.Fatalf("小图不应写缓存, stat err = %v", err)
	}

	// 透明 PNG：缩略图是 JPG，透明处垫白底（不是黑底）
	writeTestImage(t, filepath.Join(dir, "clear.png"), 1000, 800, true)
	w = requestThumb(t, "clear.png")
	img, err := jpeg.Decode(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("透明 PNG 的缩略图应是 JPG: %v", err)
	}
	if r, g, b, _ := img.At(5, 5).RGBA(); r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
		t.Fatalf("透明处应是白底, got rgb(%d,%d,%d)", r>>8, g>>8, b>>8)
	}
}

func TestGetThumbnailRejectsBadPaths(t *testing.T) {
	dir := useTempUploadDir(t)
	writeTestImage(t, filepath.Join(dir, "a.jpg"), 1200, 800, false)
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.jpg"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	requestThumb(t, "a.jpg") // 先生成一张缓存，下面验证不能给缓存再做缩略图
	for _, rel := range []string{"../secret.jpg", "../../etc/passwd", "_thumbs/a.jpg.jpg", "a.txt", "missing.jpg", ""} {
		if w := requestThumb(t, rel); w.Code != 404 {
			t.Errorf("%q: status = %d, want 404", rel, w.Code)
		}
	}
}

func TestDeleteImageRemovesThumbnail(t *testing.T) {
	dir := useTempUploadDir(t)
	src := filepath.Join(dir, "2026", "a.jpg")
	writeTestImage(t, src, 1200, 800, false)
	requestThumb(t, "2026/a.jpg")
	cached := filepath.Join(dir, "_thumbs", "2026", "a.jpg.jpg")
	if _, err := os.Stat(cached); err != nil {
		t.Fatalf("前置：应先有缩略图缓存: %v", err)
	}

	w := serveJSON(t, DeleteImage, "DELETE", "/api/upload/image", map[string]string{"url": "/uploads/2026/a.jpg"})
	if w.Code != 200 {
		t.Fatalf("删除图片 status = %d, body %s", w.Code, w.Body.String())
	}
	for _, p := range []string{src, cached} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s 应已删除, stat err = %v", p, err)
		}
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}
