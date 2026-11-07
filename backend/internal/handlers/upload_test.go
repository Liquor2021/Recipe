package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"mime/multipart"
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
