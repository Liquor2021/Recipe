// NiniMenu Service Worker：静态资源 + API 离线缓存
// 策略：页面导航 network-first（离线回退缓存的 index.html）；
// 同源静态资源（构建产物/图标/上传图片）cache-first；
// 白名单 API（只读数据）network-first，离线回退最近一次成功的响应副本；
// 其余 API 一律透传网络，保证数据新鲜。
const CACHE_NAME = "ninimenu-v1"
// API 缓存独立命名 + 版本化：策略调整时递增 vN，activate 会清掉旧版本
// （v2：加入离线副本有效期与条目上限，v1 时期无上限累积的副本随升级一并清掉）
const API_CACHE_NAME = "ninimenu-api-v2"
const CORE_ASSETS = ["/", "/index.html", "/manifest.json"]

// 离线副本最多保留 7 天：再旧的家庭数据（忌口、记录等）宁可不展示
const API_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
// 条目上限：搜索词、分页参数会产生大量不同 URL，超出后淘汰最久未更新的
const API_CACHE_MAX_ENTRIES = 200
const CACHED_AT_HEADER = "sw-cached-at"

// 离线可回退的数据接口白名单（前缀匹配：/api/dishes 也能覆盖 /api/dishes/1 这类详情）。
// 前缀下挂有写端点（如 /api/records 的 POST/PUT/DELETE）也不受影响——
// 写方法（POST/PUT/DELETE）在 fetch 入口就被放行，永不缓存。
const API_CACHE_PREFIXES = [
  "/api/app-info",
  "/api/dishes",
  "/api/fridge",
  "/api/report",
  "/api/achievements",
  "/api/settings",
  "/api/week-plan",
  "/api/shopping-list",
  "/api/holidays",
  "/api/quotes",
  "/api/stats",
  "/api/day-rating",
  "/api/photo-wall",
  "/api/records",
  "/api/favorites",
]

function isApiCacheable(pathname) {
  return API_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

// 写入离线副本：附带写入时间（用于有效期判断），写完按上限淘汰最旧的条目。
// Cache API 的 keys() 按插入顺序返回，put 同一 URL 会移到末尾，删头部即"最久未更新"。
async function putApiCache(req, res) {
  const body = await res.blob()
  const headers = new Headers(res.headers)
  // blob() 拿到的是已解压的内容：去掉原始的压缩/长度头，避免副本"自称 gzip"却是明文
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.set(CACHED_AT_HEADER, String(Date.now()))
  const cache = await caches.open(API_CACHE_NAME)
  await cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }))
  const keys = await cache.keys()
  if (keys.length > API_CACHE_MAX_ENTRIES) {
    await Promise.all(keys.slice(0, keys.length - API_CACHE_MAX_ENTRIES).map((k) => cache.delete(k)))
  }
}

// 读取离线副本：超过有效期的视为不存在并顺手删除
async function matchApiCache(req) {
  const cache = await caches.open(API_CACHE_NAME)
  const cached = await cache.match(req)
  if (!cached) return undefined
  const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER) || 0)
  if (!cachedAt || Date.now() - cachedAt > API_CACHE_TTL_MS) {
    await cache.delete(req)
    return undefined
  }
  return cached
}

// 页面通知清空离线数据（应用口令失效时）：别人拿到这台设备也看不到旧的家庭数据
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-api-cache") {
    event.waitUntil(caches.delete(API_CACHE_NAME))
  }
})

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        // 只保留当前版本的两个缓存（静态 + API），其余（含旧版本 api-cache）全部清理
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() =>
        // Vite 构建产物文件名带内容 hash，新版本发布后旧 hash 文件不再被引用，
        // 激活时统一清掉，避免 cache-first 策略下只增不减
        caches.open(CACHE_NAME).then((cache) =>
          cache.keys().then((reqs) =>
            Promise.all(reqs.filter((r) => new URL(r.url).pathname.startsWith("/assets/")).map((r) => cache.delete(r)))
          )
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 白名单 API：network-first。网络成功返回响应并把副本写进缓存（只缓存 2xx，
  // 避免把 401/500 等错误响应写进缓存污染离线回退）；网络失败回退最近一次缓存副本。
  // 写入必须包进 event.waitUntil：respondWith 一返回 SW 就可能被浏览器终止，
  // 悬空 promise 的 cache.put 可能没写完就丢；.catch 兜住配额满等 put 失败，
  // 不让它成为 SW 内未处理的 rejection（本次网络响应已正常返回，不受影响）。
  if (isApiCacheable(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            event.waitUntil(putApiCache(req, copy).catch(() => {}))
          }
          return res
        })
        .catch(() => matchApiCache(req))
    )
    return
  }

  // 非白名单 API（如写接口、记录提交等）维持直接透传
  if (url.pathname.startsWith("/api/")) return

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy)).catch(() => {}))
          return res
        })
        .catch(() => caches.match("/index.html"))
    )
    return
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {}))
        }
        return res
      })
    })
  )
})
