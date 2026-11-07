// node --test scripts/auth-regression.test.cjs
// Run the actual TS client/store with an Axios adapter; no server or database writes.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const axios = require("axios")

function setup() {
  const storage = new Map([["token", "old-admin"], ["ninimenu_app_password", "app-password"]])
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  const window = new EventTarget()
  const events = []
  const cacheMessages = []
  for (const type of ["admin-auth-expired", "app-auth-expired"]) {
    window.addEventListener(type, () => events.push(type))
  }
  const loaded = new Map()
  function load(relative) {
    if (loaded.has(relative)) return loaded.get(relative)
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8")
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    const module = { exports: {} }
    vm.runInNewContext(compiled, {
      module, exports: module.exports,
      require: (name) => name === "@/store/useAuthStore" ? load("src/store/useAuthStore.ts") : require(name),
      localStorage, window, navigator: {
        serviceWorker: { ready: Promise.resolve({ active: { postMessage: (message) => cacheMessages.push(message) } }) },
      },
      Event, Error, console,
    }, { filename: relative })
    loaded.set(relative, module.exports)
    return module.exports
  }
  const auth = load("src/store/useAuthStore.ts").useAuthStore
  const client = load("src/api/client.ts").default
  return { client, auth, storage, events, cacheMessages }
}

function reject401(config, code, message = "认证失败") {
  const response = { status: 401, statusText: "Unauthorized", headers: {}, config, data: { code, message, data: null } }
  return new axios.AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, {}, response)
}

function successfulLogin(config) {
  return { status: 200, statusText: "OK", headers: {}, config, data: { code: 0, data: { verified: true, token: "old-admin" } } }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test("admin expiry on an ordinary page synchronizes the store and keeps app access", async () => {
  const { client, auth, storage, events, cacheMessages } = setup()
  client.defaults.adapter = async (config) => { throw reject401(config, 40101) }
  await assert.rejects(client.put("/settings", {}))
  assert.equal(auth.getState().isLoggedIn, false)
  assert.equal(auth.getState().token, null)
  assert.equal(storage.has("token"), false)
  assert.equal(storage.get("ninimenu_app_password"), "app-password")
  await assert.rejects(client.put("/settings", {}))
  assert.deepEqual(events, ["admin-auth-expired"])
  assert.equal(storage.has("ninimenu_app_password"), true)
  assert.equal(cacheMessages.length, 0)
})

test("an app 401 with Authorization still locks the app without logging the admin out", async () => {
  const { client, auth, storage, events, cacheMessages } = setup()
  client.defaults.adapter = async (config) => {
    assert.equal(config.headers.Authorization, "Bearer old-admin")
    throw reject401(config, 40102)
  }
  await assert.rejects(client.get("/fridge"))
  assert.equal(auth.getState().isLoggedIn, true)
  assert.equal(storage.get("token"), "old-admin")
  assert.equal(storage.has("ninimenu_app_password"), false)
  assert.deepEqual(events, ["app-auth-expired"])
  assert.equal(cacheMessages.length, 1)
})

test("failed login does not invalidate either current identity", async () => {
  for (const url of ["/app/login", "/admin/login"]) {
    for (const code of [40100, 40101, 40102]) {
      const { client, auth, storage, events } = setup()
      client.defaults.adapter = async (config) => { throw reject401(config, code, "应用密码错误") }
      await assert.rejects(client.post(url, { password: "incorrect" }))
      assert.equal(auth.getState().isLoggedIn, true)
      assert.equal(storage.size, 2)
      assert.deepEqual(events, [])
    }
  }
})

test("known legacy 401 messages retain their auth scope, unknown errors keep credentials", async () => {
  for (const [message, expectedEvent] of [
    ["未提供认证Token", "admin-auth-expired"],
    ["Token无效或已过期", "admin-auth-expired"],
    ["请输入应用密码", "app-auth-expired"],
    ["应用密码错误", "app-auth-expired"],
    ["网关未授权", undefined],
  ]) {
    const { client, storage, events } = setup()
    client.defaults.adapter = async (config) => { throw reject401(config, 40100, message) }
    await assert.rejects(client.get("/fridge"))
    assert.deepEqual(events, expectedEvent ? [expectedEvent] : [])
    if (!expectedEvent) assert.equal(storage.size, 2)
  }
})

test("late admin 401 cannot clear a new login, including a same-token login", async () => {
  for (const token of ["new-admin", "old-admin"]) {
    const { client, auth, storage, events } = setup()
    const started = deferred(), finish = deferred()
    client.defaults.adapter = async (config) => {
      started.resolve()
      await finish.promise
      throw reject401(config, 40101)
    }
    const pending = assert.rejects(client.put("/settings", {}))
    await started.promise
    auth.getState().login(token)
    finish.resolve()
    await pending
    assert.equal(storage.get("token"), token)
    assert.equal(auth.getState().isLoggedIn, true)
    assert.deepEqual(events, [])
  }
})

test("late 401 is ignored after successful login response even before its UI callback", async () => {
  for (const [scope, url, code] of [["app", "/fridge", 40102], ["admin", "/settings", 40101]]) {
    const { client, auth, storage, events } = setup()
    const started = deferred(), finish = deferred()
    client.defaults.adapter = async (config) => {
      if (config.url === `/${scope}/login`) return successfulLogin(config)
      started.resolve()
      await finish.promise
      throw reject401(config, code)
    }
    const pending = assert.rejects(client.get(url))
    await started.promise
    await client.post(`/${scope}/login`, { password: "same-password" })
    finish.resolve()
    await pending
    assert.equal(storage.size, 2)
    assert.equal(auth.getState().isLoggedIn, true)
    assert.deepEqual(events, [])
  }
})

test("late 401 for a replaced stored credential cannot clear the replacement", async () => {
  for (const [key, code] of [["token", 40101], ["ninimenu_app_password", 40102]]) {
    const { client, storage, events } = setup()
    const started = deferred(), finish = deferred()
    client.defaults.adapter = async (config) => {
      started.resolve()
      await finish.promise
      throw reject401(config, code)
    }
    const pending = assert.rejects(client.get("/fridge"))
    await started.promise
    storage.set(key, "replacement")
    finish.resolve()
    await pending
    assert.equal(storage.get(key), "replacement")
    assert.deepEqual(events, [])
  }
})

test("late app 401 cannot lock a newly authorized admin session", async () => {
  const { client, auth, storage, events } = setup()
  const started = deferred(), finish = deferred()
  client.defaults.adapter = async (config) => {
    started.resolve()
    await finish.promise
    throw reject401(config, 40102)
  }
  const pending = assert.rejects(client.get("/fridge"))
  await started.promise
  auth.getState().login("new-valid-admin")
  finish.resolve()
  await pending
  assert.equal(storage.get("token"), "new-valid-admin")
  assert.equal(storage.get("ninimenu_app_password"), "app-password")
  assert.deepEqual(events, [])
})

test("unknown 401 does not choose an identity from its URL or Authorization header", async () => {
  for (const url of ["/admin/dashboard", "/settings", "/fridge"]) {
    const { client, auth, storage, events } = setup()
    client.defaults.adapter = async (config) => { throw reject401(config, 40199, "未知的认证错误") }
    await assert.rejects(client.get(url))
    assert.equal(storage.size, 2)
    assert.equal(auth.getState().isLoggedIn, true)
    assert.deepEqual(events, [])
  }
})
