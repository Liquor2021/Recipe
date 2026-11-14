package imaging

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func uploadFixture(t *testing.T, format string) []byte {
	t.Helper()
	if format == "webp" {
		// A self-contained 1×1 WebP fixture; no seed images or external files are used.
		data, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	img := image.NewNRGBA(image.Rect(0, 0, 16, 12))
	if format == "jpg" {
		for y := 0; y < 12; y++ {
			for x := 0; x < 16; x++ {
				img.SetNRGBA(x, y, color.NRGBA{R: 200, G: 50, B: 20, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	var err error
	if format == "png" {
		err = png.Encode(&buf, img)
	} else {
		err = jpeg.Encode(&buf, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestProcessUploadRejectsUndecodableImages(t *testing.T) {
	for _, format := range []string{"jpg", "png", "webp"} {
		valid := uploadFixture(t, format)
		for name, data := range map[string][]byte{
			"empty":     nil,
			"text":      []byte("not an image"),
			"truncated": valid[:len(valid)/2],
		} {
			t.Run(format+"/"+name, func(t *testing.T) {
				root := t.TempDir()
				src, dst := filepath.Join(root, "input."+format), filepath.Join(root, "output")
				if err := os.WriteFile(src, data, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(dst, 0700); err != nil {
					t.Fatal(err)
				}
				path, err := ProcessUpload(src, dst, "result", 8, 85)
				if path != "" || !errors.Is(err, ErrInvalidImage) || errors.Is(err, ErrImageProcessing) {
					t.Fatalf("path=%q err=%v; want invalid image without fallback eligibility", path, err)
				}
				entries, err := os.ReadDir(dst)
				if err != nil || len(entries) != 0 {
					t.Fatalf("invalid input left output files: %v, %v", entries, err)
				}
			})
		}
	}
}

func TestProcessUploadRejectsImageWithReadableHeader(t *testing.T) {
	data := uploadFixture(t, "png")
	data = data[:len(data)-12] // Keep all image data, but remove the required IEND chunk.
	if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
		t.Fatalf("fixture must have a readable image header: %v", err)
	}
	root := t.TempDir()
	src := filepath.Join(root, "incomplete.png")
	if err := os.WriteFile(src, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ProcessUpload(src, root, "result", 8, 85); !errors.Is(err, ErrInvalidImage) {
		t.Fatalf("a readable header must not bypass full decode validation: %v", err)
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 1 {
		t.Fatalf("invalid image must not produce any artifacts: %v, %v", entries, err)
	}
}

func TestProcessUploadValidFormatsAndTransparency(t *testing.T) {
	for _, format := range []string{"jpg", "png", "webp"} {
		t.Run(format, func(t *testing.T) {
			root := t.TempDir()
			src := filepath.Join(root, "input."+format)
			if err := os.WriteFile(src, uploadFixture(t, format), 0600); err != nil {
				t.Fatal(err)
			}
			path, err := ProcessUpload(src, root, "result", 8, 85)
			if err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(path)
			if err != nil || len(data) == 0 {
				t.Fatalf("missing output: %v", err)
			}
			img, err := jpeg.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if img.Bounds().Empty() || img.Bounds().Dx() > 8 || img.Bounds().Dy() > 8 {
				t.Fatalf("unexpected dimensions: %v", img.Bounds())
			}
			if format == "png" {
				r, g, b, _ := img.At(0, 0).RGBA()
				if r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
					t.Fatalf("transparent pixels must remain white: %d,%d,%d", r>>8, g>>8, b>>8)
				}
			}
		})
	}
}

func TestProcessUploadWriteFailureAllowsOriginalAndCleansTemp(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "input.png")
	if err := os.WriteFile(src, uploadFixture(t, "png"), 0600); err != nil {
		t.Fatal(err)
	}
	// A directory at the final filename makes the final rename fail on every OS.
	if err := os.Mkdir(filepath.Join(root, "result.jpg"), 0700); err != nil {
		t.Fatal(err)
	}
	path, err := ProcessUpload(src, root, "result", 8, 85)
	if path != "" || !errors.Is(err, ErrImageProcessing) || errors.Is(err, ErrInvalidImage) {
		t.Fatalf("path=%q err=%v; want a processing failure for a valid original", path, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatalf("write failure must remove temporary output: %v, %v", entries, err)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		t.Fatalf("original must remain usable for fallback: %v", err)
	}
}

func TestProcessUploadValidatesBeforeAllowingFallback(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "input.png")
	if _, err := ProcessUpload(src, root, "result", 8, 85); err == nil || errors.Is(err, ErrImageProcessing) {
		t.Fatalf("missing input must not allow fallback: %v", err)
	}
	if err := os.WriteFile(src, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ProcessUpload(src, root, "result", 0, 85); !errors.Is(err, ErrInvalidImage) {
		t.Fatalf("invalid input must be rejected even with broken compression settings: %v", err)
	}
	if err := os.WriteFile(src, uploadFixture(t, "png"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ProcessUpload(src, root, "result", 0, 85); !errors.Is(err, ErrImageProcessing) {
		t.Fatalf("valid input may fall back when compression settings fail: %v", err)
	}
}

func TestProcessUploadChecksPixelBudgetBeforeDecode(t *testing.T) {
	for _, dimensions := range [][2]uint32{{10000, 10000}, {1, 40000001}, {40000001, 1}, {8000, 5000}} {
		t.Run(fmt.Sprintf("%dx%d", dimensions[0], dimensions[1]), func(t *testing.T) {
			data := make([]byte, 33)
			copy(data, "\x89PNG\r\n\x1a\n")
			binary.BigEndian.PutUint32(data[8:12], 13)
			copy(data[12:16], "IHDR")
			binary.BigEndian.PutUint32(data[16:20], dimensions[0])
			binary.BigEndian.PutUint32(data[20:24], dimensions[1])
			data[24], data[25] = 8, 2
			binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
			if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			src := filepath.Join(root, "header.png")
			if err := os.WriteFile(src, data, 0600); err != nil {
				t.Fatal(err)
			}
			_, err := ProcessUpload(src, root, "result", 8, 85)
			if uint64(dimensions[0])*uint64(dimensions[1]) > MaxUploadPixels {
				if !errors.Is(err, ErrImageTooLarge) || errors.Is(err, ErrImageProcessing) {
					t.Fatalf("oversized header must be rejected before decode/fallback: %v", err)
				}
			} else if !errors.Is(err, ErrInvalidImage) {
				t.Fatalf("exact pixel budget must proceed to full image validation: %v", err)
			}
			if entries, err := os.ReadDir(root); err != nil || len(entries) != 1 {
				t.Fatalf("rejected header left output artifacts: %v %v", entries, err)
			}
		})
	}
}
