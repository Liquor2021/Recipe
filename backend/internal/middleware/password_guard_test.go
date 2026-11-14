package middleware

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestPasswordGuardLocksBeforeDelayAndDoesNotExtendLock(t *testing.T) {
	g := newPasswordGuard()
	now := time.Unix(1000, 0)
	for i := 1; i <= passwordFailureLimit; i++ {
		verdict := g.check(AppPasswordScope, "192.0.2.1", "wrong", "right", true, now)
		if verdict.valid || !verdict.failed || verdict.blockedUntil.IsZero() != (i < passwordFailureLimit) {
			t.Fatalf("第 %d 次失败结果不正确: %+v", i, verdict)
		}
	}
	for _, supplied := range []string{"wrong", "right"} {
		verdict := g.check(AppPasswordScope, "192.0.2.1", supplied, "right", true, now.Add(time.Minute))
		if verdict.valid || verdict.failed || !verdict.blockedUntil.Equal(now.Add(passwordLockDuration)) {
			t.Fatalf("锁定期不能再次校验、延迟或延长锁定: %+v", verdict)
		}
	}
	if verdict := g.check(AppPasswordScope, "192.0.2.1", "right", "right", true, now.Add(passwordLockDuration)); !verdict.valid {
		t.Fatalf("锁定到期后应恢复: %+v", verdict)
	}
}

func TestPasswordGuardSeparatesIPsAndScopesAndOnlyLoginClearsFailures(t *testing.T) {
	g := newPasswordGuard()
	now := time.Unix(1000, 0)
	key := passwordKey{scope: AdminPasswordScope, ip: "192.0.2.2"}
	for i := 0; i < 4; i++ {
		g.check(key.scope, key.ip, "wrong", "right", true, now)
	}
	for _, check := range []struct {
		scope PasswordScope
		ip    string
		reset bool
	}{
		{AppPasswordScope, key.ip, true}, {key.scope, "192.0.2.3", true}, {key.scope, key.ip, false},
	} {
		if !g.check(check.scope, check.ip, "right", "right", check.reset, now).valid || g.entries[key].count != 4 {
			t.Fatal("其它口令、IP 或普通 API 成功不能清掉失败记录")
		}
	}
	if !g.check(key.scope, key.ip, "right", "right", true, now).valid || len(g.entries) != 0 {
		t.Fatal("对应口令成功登录应清除失败记录")
	}
}

func TestPasswordGuardParallelAttemptsCannotOvershootFive(t *testing.T) {
	g := newPasswordGuard()
	var failures atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if g.check(AppPasswordScope, "192.0.2.4", "wrong", "right", true, time.Unix(1000, 0)).failed {
				failures.Add(1)
			}
		}()
	}
	wg.Wait()
	if failures.Load() != passwordFailureLimit || g.entries[passwordKey{AppPasswordScope, "192.0.2.4"}].count != passwordFailureLimit {
		t.Fatalf("并发绕过了失败上限: %d", failures.Load())
	}
}

func TestPasswordGuardExpiresPartialFailuresAndBoundsMemoryWithoutEvictingLocks(t *testing.T) {
	g := newPasswordGuard()
	now := time.Unix(1000, 0)
	for i := 0; i < passwordMaxEntries; i++ {
		g.check(AppPasswordScope, fmt.Sprint(i), "wrong", "right", true, now)
	}
	for i := 1; i < passwordFailureLimit; i++ {
		g.check(AppPasswordScope, "0", "wrong", "right", true, now)
	}
	if verdict := g.check(AppPasswordScope, "new-source", "right", "right", true, now); verdict.valid || verdict.blockedUntil.IsZero() {
		t.Fatal("满容量时必须限制新来源，而不是淘汰有效锁定")
	}
	if len(g.entries) != passwordMaxEntries || g.entries[passwordKey{AppPasswordScope, "0"}].count != passwordFailureLimit {
		t.Fatal("容量或有效锁定被改变")
	}
	g.check(AppPasswordScope, "new-source", "wrong", "right", true, now.Add(passwordLockDuration))
	if len(g.entries) != 1 || g.entries[passwordKey{AppPasswordScope, "new-source"}].count != 1 {
		t.Fatal("过期失败应清理，新轮从第一次失败开始")
	}
}

func TestPasswordGuardCancellationStillCountsFailure(t *testing.T) {
	old := passwords
	passwords = newPasswordGuard()
	t.Cleanup(func() { passwords = old })
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/login", nil)
	ctx, cancel := context.WithCancel(c.Request.Context())
	cancel()
	c.Request = c.Request.WithContext(ctx)
	if VerifyPassword(c, AdminPasswordScope, "wrong", "right", true) {
		t.Fatal("取消请求不能变成成功")
	}
	if passwords.entries[passwordKey{AdminPasswordScope, c.ClientIP()}].count != 1 {
		t.Fatal("取消请求丢失了失败计数")
	}
}
