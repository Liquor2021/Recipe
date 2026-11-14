package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"ninimenu/internal/config"
	"ninimenu/internal/middleware"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func loginSecurityRouter(t *testing.T, proxies []string) *gin.Engine {
	t.Helper()
	oldConfig, oldMode := config.C, gin.Mode()
	t.Cleanup(func() { config.C = oldConfig; gin.SetMode(oldMode) })
	gin.SetMode(gin.TestMode)
	config.C = config.Config{AppPassword: "test-app", AdminPassword: "test-admin", JWTSecret: "test-long-secret", JWTExpire: "24h", UploadDir: t.TempDir(), TrustedProxies: proxies}
	r := gin.New()
	Setup(r)
	return r
}

func loginSecurityRequest(r *gin.Engine, path, ip, password, forwardedIP string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"password":`+strconv.Quote(password)+`}`))
	req.RemoteAddr = ip + ":1234"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", forwardedIP)
	req.Header.Set("X-Real-IP", forwardedIP)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestLoginRoutesLockBothScopesIgnoreForgedIPAndDoNotResetViaOtherLogin(t *testing.T) {
	r := loginSecurityRouter(t, nil)
	for idx, path := range []string{"/api/app/login", "/api/admin/login"} {
		ip := fmt.Sprintf("192.0.2.%d", 100+idx)
		for attempt := 1; attempt <= 5; attempt++ {
			start := time.Now()
			w := loginSecurityRequest(r, path, ip, "wrong", fmt.Sprintf("203.0.113.%d", attempt))
			want := http.StatusUnauthorized
			if attempt == 5 {
				want = http.StatusTooManyRequests
			}
			if w.Code != want || time.Since(start) < 790*time.Millisecond {
				t.Fatalf("%s 第 %d 次状态或延迟错误: %d %v %s", path, attempt, w.Code, time.Since(start), w.Body.String())
			}
		}
		otherPath, otherPassword, correct := "/api/admin/login", "test-admin", "test-app"
		if idx == 1 {
			otherPath, otherPassword, correct = "/api/app/login", "test-app", "test-admin"
		}
		if w := loginSecurityRequest(r, otherPath, ip, otherPassword, "203.0.113.99"); w.Code != http.StatusOK {
			t.Fatalf("锁定不应误伤其它类型口令: %s", w.Body.String())
		}
		w := loginSecurityRequest(r, path, ip, correct, "203.0.113.99")
		var body struct {
			Code int
			Data struct {
				RetryAfter int `json:"retry_after_seconds"`
			}
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		retry, _ := strconv.Atoi(w.Header().Get("Retry-After"))
		if w.Code != http.StatusTooManyRequests || body.Code != 42901 || retry < 590 || retry > 600 || retry != body.Data.RetryAfter || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("正确口令/换端点/伪造 IP 不得绕过锁定，需提供倒计时: %s", w.Body.String())
		}
	}
}

func TestAppHeaderGuessesShareLoginLimitAndParallelBatchIsBounded(t *testing.T) {
	r := loginSecurityRouter(t, nil)
	const ip = "192.0.2.110"
	for i := 0; i < 3; i++ {
		if w := loginSecurityRequest(r, "/api/app/login", ip, "wrong", ""); w.Code != http.StatusUnauthorized {
			t.Fatal(w.Body.String())
		}
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/dishes", nil)
			req.RemoteAddr = ip + ":1234"
			req.Header.Set("X-App-Token", "wrong")
			req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i))
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			statuses <- w.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	unauthorized := 0
	for status := range statuses {
		if status == http.StatusUnauthorized {
			unauthorized++
		} else if status != http.StatusTooManyRequests {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if unauthorized != 1 {
		t.Fatalf("剩下两次机会只有第四次返回 401，第五次即锁定: %d", unauthorized)
	}
	if w := loginSecurityRequest(r, "/api/app/login", ip, "test-app", ""); w.Code != http.StatusTooManyRequests {
		t.Fatal("普通 API 锁定必须同步到登录接口")
	}
	// 应用口令锁定不应踢掉已取得独立 JWT 的管理会话。
	w := loginSecurityRequest(r, "/api/admin/login", ip, "test-admin", "")
	var login struct {
		Data struct {
			Token string `json:"token"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &login); err != nil || w.Code != http.StatusOK {
		t.Fatalf("管理登录失败: %s", w.Body.String())
	}
	r.GET("/security-probe", middleware.AppAuthMiddleware(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	req := httptest.NewRequest(http.MethodGet, "/security-probe", nil)
	req.RemoteAddr = ip + ":1234"
	req.Header.Set("Authorization", "Bearer "+login.Data.Token)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("有效管理会话不应被应用口令锁定误伤: %d", w.Code)
	}
}

func TestLoginTrustedProxyAndMalformedBody(t *testing.T) {
	r := loginSecurityRouter(t, []string{"192.0.2.120"})
	for i := 0; i < 6; i++ {
		w := loginSecurityRequest(r, "/api/app/login", "192.0.2.120", "wrong", fmt.Sprintf("203.0.113.%d", 120+i))
		if w.Code != http.StatusUnauthorized {
			t.Fatal("受信任代理应区分实际客户端")
		}
	}
	if w := loginSecurityRequest(r, "/api/app/login", "192.0.2.120", "test-app", "203.0.113.120"); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	for _, body := range []string{`{}`, `{"password":""}`, `{"password":"` + strings.Repeat("x", 9000) + `"}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/login", strings.NewReader(body))
		req.RemoteAddr = "192.0.2.121:1234"
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("无效或超大请求应拒绝: %d", w.Code)
		}
	}
}
