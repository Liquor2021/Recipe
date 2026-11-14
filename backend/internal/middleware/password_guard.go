package middleware

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"ninimenu/internal/utils"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type PasswordScope string

const (
	AppPasswordScope     PasswordScope = "app"
	AdminPasswordScope   PasswordScope = "admin"
	passwordFailureLimit               = 5
	passwordLockDuration               = 10 * time.Minute
	passwordFailureDelay               = 800 * time.Millisecond
	passwordMaxEntries                 = 10000
)

type passwordKey struct {
	scope PasswordScope
	ip    string
}

type passwordFailures struct {
	count   int
	expires time.Time
}

type passwordVerdict struct {
	valid        bool
	failed       bool
	blockedUntil time.Time
}

type passwordGuard struct {
	mu          sync.Mutex
	entries     map[passwordKey]passwordFailures
	nextCleanup time.Time
}

var passwords = newPasswordGuard()

const passwordGuardContextKey = "ninimenu.password-guard"

// 每个路由实例持有一份共享计数；没有后台清理 goroutine，实例释放时记录也可回收。
func PasswordProtection() gin.HandlerFunc {
	guard := newPasswordGuard()
	return func(c *gin.Context) {
		c.Set(passwordGuardContextKey, guard)
		c.Next()
	}
}

func newPasswordGuard() *passwordGuard {
	return &passwordGuard{entries: make(map[passwordKey]passwordFailures)}
}

func (g *passwordGuard) check(scope PasswordScope, ip, supplied, expected string, resetOnSuccess bool, now time.Time) passwordVerdict {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !now.Before(g.nextCleanup) || len(g.entries) >= passwordMaxEntries {
		for key, failures := range g.entries {
			if !now.Before(failures.expires) {
				delete(g.entries, key)
			}
		}
		g.nextCleanup = now.Add(time.Minute)
	}
	key := passwordKey{scope: scope, ip: ip}
	failures := g.entries[key]
	if !now.Before(failures.expires) {
		delete(g.entries, key)
		failures = passwordFailures{}
	}
	if failures.count >= passwordFailureLimit {
		return passwordVerdict{blockedUntil: failures.expires}
	}
	// 不淘汰仍有效的锁定记录；地址洪泛时限制新来源，防止内存膨胀或挤掉锁定绕过保护。
	if failures.count == 0 && len(g.entries) >= passwordMaxEntries {
		return passwordVerdict{blockedUntil: now.Add(time.Minute)}
	}
	// 检查、比较、失败计数必须是同一个原子操作。延迟在解锁后执行，批量并发也只能试 5 次。
	if subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) == 1 {
		if resetOnSuccess {
			delete(g.entries, key)
		}
		return passwordVerdict{valid: true}
	}
	failures.count++
	failures.expires = now.Add(passwordLockDuration)
	g.entries[key] = failures
	verdict := passwordVerdict{failed: true}
	if failures.count >= passwordFailureLimit {
		verdict.blockedUntil = failures.expires
	}
	return verdict
}

// VerifyPassword 同时保护登录和 X-App-Token 校验。成功登录清除对应失败记录，
// 普通 API 的有效口令不清计数，以免同 IP 的后台请求不断抵消攻击者的失败。
func VerifyPassword(c *gin.Context, scope PasswordScope, supplied, expected string, resetOnSuccess bool) bool {
	guard := passwords // 直接调用处理器时也保留保护，不依赖特定的路由接线。
	if value, exists := c.Get(passwordGuardContextKey); exists {
		guard = value.(*passwordGuard)
	}
	verdict := guard.check(scope, c.ClientIP(), supplied, expected, resetOnSuccess, time.Now())
	if verdict.valid {
		return true
	}
	c.Header("Cache-Control", "no-store")
	if verdict.failed {
		timer := time.NewTimer(passwordFailureDelay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-c.Request.Context().Done():
			// 客户端取消请求也不能撤销已经记下的失败。
			return false
		}
	}
	if !verdict.blockedUntil.IsZero() {
		seconds := max(1, int(time.Until(verdict.blockedUntil).Seconds()+0.999))
		c.Header("Retry-After", strconv.Itoa(seconds))
		c.JSON(http.StatusTooManyRequests, utils.Response{
			Code: 42901, Message: fmt.Sprintf("尝试次数过多，已锁定，请 %d 分钟后再试", (seconds+59)/60),
			Data: gin.H{"retry_after_seconds": seconds, "auth_scope": scope},
		})
		return false
	}
	if scope == AppPasswordScope {
		utils.Error(c, http.StatusUnauthorized, AppAuthErrorCode, "应用密码错误")
	} else {
		utils.Error(c, http.StatusUnauthorized, AdminAuthErrorCode, "密码错误")
	}
	return false
}
