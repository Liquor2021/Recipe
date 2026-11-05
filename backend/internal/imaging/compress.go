package imaging

import (
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"

	imgproc "github.com/disintegration/imaging"
	_ "golang.org/x/image/webp"
)

func ProcessUpload(srcPath, dstDir, baseName string, maxDim, quality int) (string, error) {
	img, err := imgproc.Open(srcPath, imgproc.AutoOrientation(true))
	if err != nil {
		return "", err
	}

	b := img.Bounds()
	if b.Dx() > maxDim || b.Dy() > maxDim {
		img = imgproc.Fit(img, maxDim, maxDim, imgproc.Lanczos)
	}

	dstPath := filepath.Join(dstDir, baseName+".jpg")
	if err := writeJPEG(dstPath, img, quality); err != nil {
		return "", err
	}
	return dstPath, nil
}

// 列表缩略图：短边缩到 ThumbShortSide（列表里最大的图约 175×120 CSS 像素，2 倍屏够用），
// 长边最多 thumbMaxLongSide（极端长图不至于太大）
const (
	ThumbShortSide   = 400
	thumbMaxLongSide = 1200
	ThumbQuality     = 80
)

// ErrThumbNotNeeded 原图本来就不比缩略图大，直接用原图
var ErrThumbNotNeeded = errors.New("原图已经够小，不需要缩略图")

// MakeThumbnail 从 srcPath 生成列表用的 JPG 缩略图写到 dstPath（先写临时文件再改名，
// 并发请求不会读到写了一半的文件）。原图短边不超过 ThumbShortSide 时返回 ErrThumbNotNeeded
func MakeThumbnail(srcPath, dstPath string) error {
	if cfg, err := readConfig(srcPath); err == nil && min(cfg.Width, cfg.Height) <= ThumbShortSide {
		return ErrThumbNotNeeded
	}
	img, err := imgproc.Open(srcPath, imgproc.AutoOrientation(true))
	if err != nil {
		return err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	short := min(w, h)
	if short <= ThumbShortSide {
		return ErrThumbNotNeeded
	}
	scale := float64(ThumbShortSide) / float64(short)
	if long := max(w, h); float64(long)*scale > thumbMaxLongSide {
		scale = float64(thumbMaxLongSide) / float64(long)
	}
	tw, th := max(1, int(float64(w)*scale+0.5)), max(1, int(float64(h)*scale+0.5))
	img = imgproc.Resize(img, tw, th, imgproc.Lanczos)
	if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
		return err
	}
	return writeJPEG(dstPath, img, ThumbQuality)
}

// readConfig 只读图片头拿宽高（不解码整张图）
func readConfig(path string) (image.Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return image.Config{}, err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	return cfg, err
}

// writeJPEG 透明部分垫白底后编码成 JPG；先写同目录的临时文件再改名
func writeJPEG(dstPath string, img image.Image, quality int) error {
	b := img.Bounds()
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(rgba, rgba.Bounds(), image.White, image.Point{}, draw.Src)
	draw.Draw(rgba, rgba.Bounds(), img, b.Min, draw.Over)

	tmp, err := os.CreateTemp(filepath.Dir(dstPath), ".tmp-*.jpg")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if err := jpeg.Encode(tmp, rgba, &jpeg.Options{Quality: quality}); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, dstPath); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
