import axios from "axios"
import type { ApiResponse } from "@/types"

const client = axios.create({
  baseURL: "/api",
  timeout: 10000,
})

export const APP_TOKEN_KEY = "ninimenu_app_password"

// 应用口令失效时通知 Service Worker 清掉离线 API 副本（缓存名由 sw.js 自己管理）
function clearOfflineApiCache() {
  if (!("serviceWorker" in navigator)) return
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: "clear-api-cache" }))
    .catch(() => {})
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
  return config
})

client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      const url = err.config?.url || ""
      if (url.startsWith("/admin/") || err.config?.headers?.Authorization) {
        localStorage.removeItem("token")
        window.dispatchEvent(new Event("admin-auth-expired"))
      } else {
        localStorage.removeItem(APP_TOKEN_KEY)
        clearOfflineApiCache()
        window.dispatchEvent(new Event("app-auth-expired"))
      }
    }
    return Promise.reject(err)
  },
)

export async function api<T>(method: string, url: string, data?: unknown): Promise<T> {
  const res = await client.request<ApiResponse<T>>({
    method,
    url,
    data,
    params: method === "GET" ? data : undefined,
  })
  if (res.data.code !== 0) {
    throw new Error(res.data.message)
  }
  return res.data.data
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
