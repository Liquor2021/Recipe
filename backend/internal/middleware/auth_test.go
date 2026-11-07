package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"ninimenu/internal/config"
	"ninimenu/internal/utils"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func TestAuthMiddlewareSeparatesCredentialFailures(t *testing.T) {
	oldConfig, oldMode := config.C, gin.Mode()
	t.Cleanup(func() { config.C = oldConfig; gin.SetMode(oldMode) })
	gin.SetMode(gin.TestMode)
	config.C = config.Config{AppPassword: "test-app-password", JWTSecret: "test-secret"}

	sign := func(expires time.Time) string {
		t.Helper()
		token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"role": "admin", "exp": expires.Unix(),
		}).SignedString([]byte(config.C.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
		return "Bearer " + token
	}
	validAdmin := sign(time.Now().Add(time.Hour))
	expiredAdmin := sign(time.Now().Add(-time.Hour))

	tests := []struct {
		name       string
		middleware gin.HandlerFunc
		admin      string
		app        string
		wantCode   int
	}{
		{"admin missing token despite valid app password", AuthMiddleware(), "", config.C.AppPassword, AdminAuthErrorCode},
		{"admin expired token despite valid app password", AuthMiddleware(), expiredAdmin, config.C.AppPassword, AdminAuthErrorCode},
		{"admin malformed authorization", AuthMiddleware(), "Basic invalid", config.C.AppPassword, AdminAuthErrorCode},
		{"admin valid token without app password", AuthMiddleware(), validAdmin, "", 0},
		{"app missing both credentials", AppAuthMiddleware(), "", "", AppAuthErrorCode},
		{"app incorrect password", AppAuthMiddleware(), "", "incorrect", AppAuthErrorCode},
		{"app expired admin and incorrect password", AppAuthMiddleware(), expiredAdmin, "incorrect", AppAuthErrorCode},
		{"app expired admin and valid app password", AppAuthMiddleware(), expiredAdmin, config.C.AppPassword, 0},
		{"app valid admin without app password", AppAuthMiddleware(), validAdmin, "", 0},
		{"app valid admin with incorrect app password", AppAuthMiddleware(), validAdmin, "incorrect", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			router := gin.New()
			router.GET("/protected", tt.middleware, func(c *gin.Context) {
				called = true
				utils.Success(c, "accepted")
			})
			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			req.Header.Set("Authorization", tt.admin)
			req.Header.Set("X-App-Token", tt.app)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)

			var body utils.Response
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Code != tt.wantCode {
				t.Fatalf("code = %d, want %d: %s", body.Code, tt.wantCode, response.Body.String())
			}
			if tt.wantCode == 0 {
				if response.Code != http.StatusOK || !called {
					t.Fatalf("authorized request did not reach handler: status=%d called=%v", response.Code, called)
				}
			} else if response.Code != http.StatusUnauthorized || called || body.Message == "" || body.Data != nil {
				t.Fatalf("unexpected unauthorized response: status=%d called=%v body=%s", response.Code, called, response.Body.String())
			}
		})
	}
}
