package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/jpeg"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"ninimenu/internal/config"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func setupImageUploadTest(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	uploads, backups := filepath.Join(root, "uploads"), filepath.Join(root, "backups")
	previous := config.C
	config.C.UploadDir = uploads
	config.C.BackupDir = backups
	config.C.MaxUploadSize = 5 * 1024 * 1024
	config.C.CompressMaxDim = 8
	config.C.JpegQuality = 85
	t.Cleanup(func() { config.C = previous })
	return uploads, backups
}

func serveImageUpload(t *testing.T, filename string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename="%s"`, filename))
	header.Set("Content-Type", "image/"+strings.TrimPrefix(filepath.Ext(filename), "."))
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest("POST", "/api/admin/upload/image", &body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	UploadImage(c)
	return response
}

func uploadedFiles(t *testing.T, root string) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) && path == root {
			return nil
		}
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func uploadTestData(t *testing.T, format string) []byte {
	t.Helper()
	if format == "webp" {
		data, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	path := filepath.Join(t.TempDir(), "original."+format)
	writeTestImage(t, path, 16, 12, format == "png")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestUploadImageRejectsDamagedFilesWithoutLeavingArtifacts(t *testing.T) {
	for _, format := range []string{"jpg", "png", "webp"} {
		valid := uploadTestData(t, format)
		for name, data := range map[string][]byte{
			"empty":     nil,
			"text":      []byte("this is not an image"),
			"truncated": valid[:len(valid)/2],
		} {
			t.Run(format+"/"+name, func(t *testing.T) {
				uploads, backups := setupImageUploadTest(t)
				response := serveImageUpload(t, "photo."+format, data)
				if response.Code != 400 || !strings.Contains(response.Body.String(), "图片内容损坏") {
					t.Fatalf("damaged image response=%d %s", response.Code, response.Body.String())
				}
				for _, root := range []string{uploads, backups} {
					if files := uploadedFiles(t, root); len(files) != 0 {
						t.Fatalf("failed upload left files: %v", files)
					}
				}
			})
		}
	}
}

func TestUploadImageValidFormatsAndBackup(t *testing.T) {
	for _, format := range []string{"jpg", "jpeg", "png", "webp"} {
		t.Run(format, func(t *testing.T) {
			uploads, backups := setupImageUploadTest(t)
			original := uploadTestData(t, format)
			response := serveImageUpload(t, "photo."+format, original)
			if response.Code != 200 {
				t.Fatalf("upload failed: %d %s", response.Code, response.Body.String())
			}
			var result struct {
				Data struct{ URL, Filename string }
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(uploads, filepath.FromSlash(strings.TrimPrefix(result.Data.URL, "/uploads/")))
			data, err := os.ReadFile(path)
			if err != nil || result.Data.Filename != filepath.Base(path) || !strings.HasSuffix(path, ".jpg") {
				t.Fatalf("invalid published image: %s, %v", response.Body.String(), err)
			}
			img, err := jpeg.Decode(bytes.NewReader(data))
			if err != nil || img.Bounds().Empty() || img.Bounds().Dx() > 8 || img.Bounds().Dy() > 8 {
				t.Fatalf("compressed image unusable: %v", err)
			}
			if format == "png" {
				r, g, b, _ := img.At(0, 0).RGBA()
				if r>>8 < 240 || g>>8 < 240 || b>>8 < 240 {
					t.Fatalf("transparent pixels must have a white background")
				}
			}
			if files := uploadedFiles(t, uploads); len(files) != 1 {
				t.Fatalf("unexpected upload artifacts: %v", files)
			}
			files := uploadedFiles(t, backups)
			if len(files) != 1 {
				t.Fatalf("expected one original backup: %v", files)
			}
			backup, err := os.ReadFile(files[0])
			if err != nil || !bytes.Equal(original, backup) {
				t.Fatalf("original backup changed: %v", err)
			}
		})
	}
}

func TestUploadImageFallsBackOnlyToValidNonemptyOriginal(t *testing.T) {
	for _, format := range []string{"jpg", "png", "webp"} {
		t.Run(format, func(t *testing.T) {
			uploads, backups := setupImageUploadTest(t)
			config.C.CompressMaxDim = 0 // Deterministic failure after the original is decoded.
			original := uploadTestData(t, format)
			response := serveImageUpload(t, "photo."+format, original)
			if response.Code != 200 {
				t.Fatalf("valid original should be retained: %d %s", response.Code, response.Body.String())
			}
			files := uploadedFiles(t, uploads)
			if len(files) != 1 || filepath.Ext(files[0]) != "."+format {
				t.Fatalf("expected one original image: %v", files)
			}
			data, err := os.ReadFile(files[0])
			if err != nil || len(data) == 0 || !bytes.Equal(data, original) {
				t.Fatalf("fallback original changed: %v", err)
			}
			if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
				t.Fatalf("fallback must be decodable: %v", err)
			}
			if files := uploadedFiles(t, backups); len(files) != 0 {
				t.Fatalf("fallback must not leave duplicate or temporary backups: %v", files)
			}
			response = serveImageUpload(t, "broken."+format, []byte("broken"))
			if response.Code != 400 || len(uploadedFiles(t, uploads)) != 1 || len(uploadedFiles(t, backups)) != 0 {
				t.Fatalf("compression failure must not allow damaged input: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestUploadImageFallbackSurvivesSharedUploadAndBackupDirectory(t *testing.T) {
	uploads, _ := setupImageUploadTest(t)
	config.C.BackupDir = uploads
	config.C.CompressMaxDim = 0
	original := uploadTestData(t, "png")
	response := serveImageUpload(t, "photo.png", original)
	if response.Code != 200 {
		t.Fatalf("fallback failed: %d %s", response.Code, response.Body.String())
	}
	files := uploadedFiles(t, uploads)
	if len(files) != 1 {
		t.Fatalf("successful fallback must survive deferred cleanup: %v", files)
	}
	data, err := os.ReadFile(files[0])
	if err != nil || !bytes.Equal(data, original) {
		t.Fatalf("published original changed or was removed: %v", err)
	}
}

func TestUploadImageCompressesJPEGWithSharedUploadAndBackupDirectory(t *testing.T) {
	uploads, _ := setupImageUploadTest(t)
	config.C.BackupDir = uploads
	original := uploadTestData(t, "jpg")
	response := serveImageUpload(t, "photo.jpg", original)
	if response.Code != 200 {
		t.Fatalf("JPEG upload failed: %d %s", response.Code, response.Body.String())
	}
	files := uploadedFiles(t, uploads)
	if len(files) != 1 {
		t.Fatalf("expected one compressed image without temporary files: %v", files)
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 8 || img.Bounds().Dy() != 6 {
		t.Fatalf("shared directories must still compress the original 16x12 JPEG, got %v", img.Bounds())
	}
	if bytes.Equal(data, original) {
		t.Fatal("JPEG must be compressed, not silently returned by the original-image fallback")
	}
}

type countedUploadBody struct {
	io.Reader
	read int64
}

func (b *countedUploadBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.read += int64(n)
	return n, err
}

func TestUploadImageLimitsEntireMultipartBeforeSaving(t *testing.T) {
	for _, extra := range []string{"field", "file"} {
		for _, knownLength := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/known-length=%t", extra, knownLength), func(t *testing.T) {
				uploads, backups := setupImageUploadTest(t)
				config.C.MaxUploadSize = 1024
				limit := config.C.MaxUploadSize + 64*1024
				var buf bytes.Buffer
				writer := multipart.NewWriter(&buf)
				part, err := writer.CreateFormFile("image", "photo.png")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = part.Write(uploadTestData(t, "png")); err != nil {
					t.Fatal(err)
				}
				if extra == "field" {
					part, err = writer.CreateFormField("unused")
				} else {
					part, err = writer.CreateFormFile("unused", "extra.png")
				}
				if err != nil {
					t.Fatal(err)
				}
				if _, err = io.Copy(part, strings.NewReader(strings.Repeat("x", int(limit)))); err != nil {
					t.Fatal(err)
				}
				if err = writer.Close(); err != nil {
					t.Fatal(err)
				}
				body := &countedUploadBody{Reader: bytes.NewReader(buf.Bytes())}
				response := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(response)
				c.Request = httptest.NewRequest(http.MethodPost, "/api/admin/upload/image", body)
				c.Request.Header.Set("Content-Type", writer.FormDataContentType())
				c.Request.ContentLength = -1
				if knownLength {
					c.Request.ContentLength = int64(buf.Len())
				}
				UploadImage(c)
				if response.Code != http.StatusRequestEntityTooLarge {
					t.Fatalf("oversized multipart response=%d %s", response.Code, response.Body.String())
				}
				if knownLength && body.read != 0 {
					t.Fatalf("known oversized body was read: %d", body.read)
				}
				if !knownLength && (body.read == 0 || body.read > limit+1) {
					t.Fatalf("stream read=%d; want 1..%d", body.read, limit+1)
				}
				for _, root := range []string{uploads, backups} {
					if files := uploadedFiles(t, root); len(files) != 0 {
						t.Fatalf("rejected upload left files: %v", files)
					}
				}
			})
		}
	}
}

func TestUploadImageKeepsSingleFileSizeLimit(t *testing.T) {
	uploads, backups := setupImageUploadTest(t)
	config.C.MaxUploadSize = 1024
	response := serveImageUpload(t, "photo.png", bytes.Repeat([]byte("x"), 1025))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "图片大小不能超过") {
		t.Fatalf("single-file limit response=%d %s", response.Code, response.Body.String())
	}
	for _, root := range []string{uploads, backups} {
		if files := uploadedFiles(t, root); len(files) != 0 {
			t.Fatalf("rejected upload left files: %v", files)
		}
	}
}

func TestUploadImageRejectsPixelBombWithoutArtifacts(t *testing.T) {
	uploads, backups := setupImageUploadTest(t)
	// Valid PNG IHDR/CRC, but no pixel data: DecodeConfig succeeds, full decode cannot.
	data := make([]byte, 33)
	copy(data, "\x89PNG\r\n\x1a\n")
	binary.BigEndian.PutUint32(data[8:12], 13)
	copy(data[12:16], "IHDR")
	binary.BigEndian.PutUint32(data[16:20], 10000)
	binary.BigEndian.PutUint32(data[20:24], 10000)
	data[24], data[25] = 8, 2
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	response := serveImageUpload(t, "photo.png", data)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "4000万像素") {
		t.Fatalf("pixel bomb response=%d %s", response.Code, response.Body.String())
	}
	for _, root := range []string{uploads, backups} {
		if files := uploadedFiles(t, root); len(files) != 0 {
			t.Fatalf("rejected upload left files: %v", files)
		}
	}
}
