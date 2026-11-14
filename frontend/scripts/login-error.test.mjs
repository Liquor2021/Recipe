import assert from "node:assert/strict"
import test from "node:test"
import { AxiosError } from "axios"
import { getLoginError, getLoginLockMessage, getLoginRetrySeconds } from "../src/lib/loginError.ts"

const httpError = (status) => new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, { status })

test("两种登录只有在认证被拒绝时才提示密码错误", () => {
  assert.deepEqual(getLoginError(httpError(401), "app"), { message: "口令不对，再想想～", invalidPassword: true })
  assert.deepEqual(getLoginError(httpError(401), "admin"), { message: "管理密码不对，请再试一次。", invalidPassword: true })
})

test("两类口令锁定读取 Retry-After 或响应体，显示等待时间而非密码错误", () => {
  const now = Date.UTC(2026, 10, 14)
  for (const response of [
    { headers: { "retry-after": "600" } },
    { headers: { "Retry-After": "600" } },
    { headers: { "retry-after": new Date(now + 600000).toUTCString() } },
    { data: { data: { retry_after_seconds: 600 } } },
    { headers: { "retry-after": "bad" }, data: { data: { retry_after_seconds: 600 } } },
  ]) {
    const cause = new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, { status: 429, ...response })
    for (const scope of ["app", "admin"]) assert.deepEqual(getLoginError(cause, scope, now), {
      message: "已锁定，10 分钟后再试。", invalidPassword: false, retryAt: now + 600000,
    })
  }
})

test("异常等待值不锁死登录，倒计时按截止时间纠偏并在边界解除", () => {
  for (const value of [undefined, null, "", "-1", "0", "Infinity", "999999999", {}, 0.5]) {
    const cause = new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, { status: 429, headers: { "retry-after": value } })
    assert.equal(getLoginError(cause, "app", 0).retryAt, undefined)
  }
  assert.equal(getLoginRetrySeconds(600000, 0), 600)
  assert.equal(getLoginRetrySeconds(600000, 540001), 60)
  assert.equal(getLoginRetrySeconds(600000, 600000), 0)
  assert.equal(getLoginRetrySeconds(600000, 700000), 0)
  assert.equal(getLoginLockMessage(61), "已锁定，2 分钟后再试。")
  assert.equal(getLoginLockMessage(60), "已锁定，60 秒后再试。")
})

test("断网和超时保留密码有效状态，并提示检查网络", () => {
  for (const code of ["ERR_NETWORK", "ECONNABORTED", "ETIMEDOUT"]) {
    for (const scope of ["app", "admin"]) {
      const feedback = getLoginError(new AxiosError("Network error", code), scope)
      assert.equal(feedback.invalidPassword, false)
      assert.match(feedback.message, /检查网络/)
    }
  }
})

test("限流提示稍后重试，不误报密码错误", () => {
  for (const scope of ["app", "admin"]) {
    assert.deepEqual(getLoginError(httpError(429), scope), { message: "尝试太频繁，请稍等一会儿再试。", invalidPassword: false })
  }
})

test("服务故障和未知错误不把技术异常原文显示给用户", () => {
  for (const cause of [httpError(500), httpError(502), httpError(503), new Error("内部异常"), null]) {
    for (const scope of ["app", "admin"]) {
      assert.deepEqual(getLoginError(cause, scope), { message: "小灶暂时没有响应，请稍后再试。", invalidPassword: false })
    }
  }
})
