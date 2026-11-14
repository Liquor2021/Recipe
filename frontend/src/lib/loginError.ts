import { isAxiosError } from "axios"

export interface LoginError {
  message: string
  invalidPassword: boolean
  retryAt?: number
}

export function getLoginRetrySeconds(retryAt: number | undefined, now: number): number {
  return retryAt === undefined ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000))
}

export function getLoginLockMessage(seconds: number): string {
  return seconds > 60 ? `已锁定，${Math.ceil(seconds / 60)} 分钟后再试。` : `已锁定，${seconds} 秒后再试。`
}

function retrySeconds(cause: unknown, now: number): number | undefined {
  if (!isAxiosError(cause) || !cause.response) return
  const headers = cause.response.headers
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"]
  const data: unknown = cause.response.data?.data?.retry_after_seconds
  for (const value of [raw, data]) {
    if (typeof value !== "string" && typeof value !== "number") continue
    const seconds = /^\d+$/.test(String(value)) ? Number(value)
      : typeof value === "string" ? Math.ceil((Date.parse(value) - now) / 1000) : NaN
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) return seconds
  }
}

export function getLoginError(cause: unknown, scope: "app" | "admin", now = Date.now()): LoginError {
  const status = isAxiosError(cause) ? cause.response?.status : undefined
  if (status === 401) {
    return {
      message: scope === "app" ? "口令不对，再想想～" : "管理密码不对，请再试一次。",
      invalidPassword: true,
    }
  }
  if (status === 429) {
    const seconds = retrySeconds(cause, now)
    if (seconds !== undefined) return { message: getLoginLockMessage(seconds), invalidPassword: false, retryAt: now + seconds * 1000 }
  }
  const message = status === 429
    ? "尝试太频繁，请稍等一会儿再试。"
    : isAxiosError(cause) && !cause.response
      ? "暂时连不上小灶，请检查网络后重试。"
      : "小灶暂时没有响应，请稍后再试。"
  return { message, invalidPassword: false }
}
