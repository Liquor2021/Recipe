const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const root = path.join(__dirname, "..")

test("PWA 三个快捷入口在应用范围内、图标存在、不是绕过口令的写接口", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/manifest.json"), "utf8"))
  assert.deepEqual(manifest.shortcuts.map(s => [s.name, s.url]), [["记一笔", "/ledger?action=add"], ["今天吃什么", "/"], ["冰箱", "/fridge"]])
  for (const shortcut of manifest.shortcuts) {
    const url = new URL(shortcut.url, "https://home.example")
    assert.equal(url.origin, "https://home.example")
    assert.ok(!url.pathname.startsWith("/api/"))
    for (const icon of shortcut.icons) assert.ok(fs.existsSync(path.join(root, "public", icon.src)))
  }
  const app = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8")
  assert.match(app, /<AppGate>.*<SubPageLayout/s)
  const ledger = fs.readFileSync(path.join(root, "src/pages/Ledger.tsx"), "utf8")
  assert.match(ledger, /params.get\("action"\) === "add"/)
  assert.match(ledger, /next.delete\("action"\)/)
  assert.match(ledger, /setParams\(next, \{ replace: true \}\)/)
})

async function manifestFetch(network, cached, failCache = false) {
  const handlers = {}, effects = [], writes = []
  const source = fs.readFileSync(path.join(root, "public/sw.js"), "utf8")
  vm.runInNewContext(source, {
    self: { location: { origin: "https://home.example" }, addEventListener: (name, fn) => { handlers[name] = fn } },
    URL, Response,
    fetch: async (req, options) => { assert.equal(options.cache, "no-cache"); return network(req) },
    caches: {
      match: async () => cached,
      open: async () => ({ put: async (_req, res) => { if (failCache) throw new Error("quota"); writes.push(await res.text()) } }),
    },
  })
  let response
  handlers.fetch({ request: new Request("https://home.example/manifest.json"), respondWith: p => { response = p }, waitUntil: p => effects.push(p) })
  const result = await response
  await Promise.all(effects)
  return { result, writes }
}

test("已安装应用也能取得新版 manifest 并更新离线副本，不停在旧快捷入口", async () => {
  const { result, writes } = await manifestFetch(() => new Response("new"), new Response("old"))
  assert.equal(await result.text(), "new")
  assert.deepEqual(writes, ["new"])
})

test("manifest 离线或服务异常回退有效旧副本，没有副本则明确失败", async () => {
  for (const network of [() => { throw new Error("offline") }, () => new Response("broken", { status: 503 })]) {
    const { result, writes } = await manifestFetch(network, new Response("old"))
    assert.equal(await result.text(), "old")
    assert.deepEqual(writes, [])
  }
  assert.equal((await manifestFetch(() => { throw new Error("offline") })).result.type, "error")
})

test("缓存配额满不影响在线 manifest，不清除用户其他离线数据", async () => {
  const { result, writes } = await manifestFetch(() => new Response("new"), new Response("old"), true)
  assert.equal(await result.text(), "new")
  assert.deepEqual(writes, [])
})
