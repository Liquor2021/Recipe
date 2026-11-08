import axios from "axios"
import type { ApiResponse } from "@/types"
import { useAuthStore } from "@/store/useAuthStore"

const client = axios.create({
  baseURL: "/api",
  timeout: 10000,
})

export const APP_TOKEN_KEY = "ninimenu_app_password"

type AuthScope = "app" | "admin"
type AuthSnapshot = {
  appToken: string | null
  adminToken: string | null
  appVersion: number
  adminVersion: number
  storeVersion: number
}

// 即使重新登录取得相同的口令/token，也不能让之前发出的请求撤销新会话。
const authVersions = { app: 0, admin: 0 }
const requestAuth = new WeakMap<object, AuthSnapshot>()

function loginScope(url: string | undefined): AuthScope | undefined {
  if (url === "/app/login") return "app"
  if (url === "/admin/login") return "admin"
}

function failedAuthScope(data: unknown): AuthScope | undefined {
  if (!data || typeof data !== "object") return
  const { code, message } = data as { code?: unknown; message?: unknown }
  if (code === 40101) return "admin"
  if (code === 40102) return "app"
  // 兼容旧后端的 40100；未知 401 只报告失败，不凭请求头推断要退出的身份。
  if (code !== 40100) return
  if (message === "未提供认证Token" || message === "Token无效或已过期") return "admin"
  if (message === "请输入应用密码" || message === "应用密码错误") return "app"
}

// 应用口令失效时通知 Service Worker 清掉离线 API 副本（缓存名由 sw.js 自己管理）
function clearOfflineApiCache(expiredVersion: number) {
  if (!("serviceWorker" in navigator)) return
  navigator.serviceWorker.ready
    .then((reg) => {
      if (authVersions.app === expiredVersion && !localStorage.getItem(APP_TOKEN_KEY)) {
        reg.active?.postMessage({ type: "clear-api-cache" })
      }
    })
    .catch(() => {})
}

// 主动合上手账时退出两种身份，避免管理凭证继续放行应用请求。
export function logoutApp() {
  authVersions.app++
  authVersions.admin++
  localStorage.removeItem(APP_TOKEN_KEY)
  useAuthStore.getState().logout()
  clearOfflineApiCache(authVersions.app)
  window.dispatchEvent(new Event("app-auth-expired"))
}

client.interceptors.request.use((config) => {
  const appToken = localStorage.getItem(APP_TOKEN_KEY)
  if (appToken) {
    config.headers["X-App-Token"] = appToken
  }

  const token = localStorage.getItem("token")
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  requestAuth.set(config, {
    appToken,
    adminToken: token,
    appVersion: authVersions.app,
    adminVersion: authVersions.admin,
    storeVersion: useAuthStore.getState().sessionVersion,
  })
  return config
})

client.interceptors.response.use(
  (res) => {
    const scope = loginScope(res.config.url)
    if (scope && res.data?.code === 0) authVersions[scope]++
    return res
  },
  (err) => {
    if (axios.isAxiosError(err) && err.response?.status === 401 && err.config && !loginScope(err.config.url)) {
      const scope = failedAuthScope(err.response.data)
      const snapshot = requestAuth.get(err.config)
      if (snapshot && scope === "admin") {
        const auth = useAuthStore.getState()
        if (snapshot.adminVersion === authVersions.admin && snapshot.storeVersion === auth.sessionVersion &&
            snapshot.adminToken === localStorage.getItem("token") && (snapshot.adminToken || auth.isLoggedIn)) {
          authVersions.admin++
          auth.logout()
          window.dispatchEvent(new Event("admin-auth-expired"))
        }
      } else if (snapshot && scope === "app") {
        // 管理员凭证也能通过 AppAuth；旧请求不能锁住刚用管理员身份重新登录的会话。
        if (snapshot.appVersion === authVersions.app && snapshot.appToken === localStorage.getItem(APP_TOKEN_KEY) &&
            snapshot.adminVersion === authVersions.admin && snapshot.storeVersion === useAuthStore.getState().sessionVersion &&
            snapshot.adminToken === localStorage.getItem("token")) {
          authVersions.app++
          localStorage.removeItem(APP_TOKEN_KEY)
          clearOfflineApiCache(authVersions.app)
          window.dispatchEvent(new Event("app-auth-expired"))
        }
      }
    }
    return Promise.reject(err)
  },
)

async function requestApi<T>(method: string, url: string, data?: unknown, requireFresh = false): Promise<T> {
  const res = await client.request<ApiResponse<T>>({
    method,
    url,
    data,
    params: method === "GET" ? data : undefined,
    headers: requireFresh ? { "X-Nini-Require-Fresh": "1" } : undefined,
  })
  // Older installed service workers may ignore the request header. Their cached
  // responses already carry this marker, so never accept them as an edit baseline.
  if (requireFresh && res.headers["sw-cached-at"] != null) {
    throw new Error("当前只有离线副本，请联网重新读取后再修改")
  }
  if (res.data.code !== 0) {
    throw new Error(res.data.message)
  }
  return res.data.data
}

export function api<T>(method: string, url: string, data?: unknown): Promise<T> {
  return requestApi<T>(method, url, data)
}

export function apiFresh<T>(method: "GET", url: string, data?: unknown): Promise<T> {
  return requestApi<T>(method, url, data, true)
}

export function getUploadErrorMessage(err: unknown, fallback = "上传失败"): string {
  if (axios.isAxiosError(err) && err.response?.data?.message) {
    return err.response.data.message
  }
  if (err instanceof Error && err.message) {
    return err.message
  }
  return fallback
}

export default client
