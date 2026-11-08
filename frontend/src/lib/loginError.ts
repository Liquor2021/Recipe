import { isAxiosError } from "axios"

export interface LoginError {
  message: string
  invalidPassword: boolean
}

export function getLoginError(cause: unknown, scope: "app" | "admin"): LoginError {
  const status = isAxiosError(cause) ? cause.response?.status : undefined
  if (status === 401) {
    return {
      message: scope === "app" ? "口令不对，再想想～" : "管理密码不对，请再试一次。",
      invalidPassword: true,
    }
  }
  const message = status === 429
    ? "尝试太频繁，请稍等一会儿再试。"
    : isAxiosError(cause) && !cause.response
      ? "暂时连不上小灶，请检查网络后重试。"
      : "小灶暂时没有响应，请稍后再试。"
  return { message, invalidPassword: false }
}
