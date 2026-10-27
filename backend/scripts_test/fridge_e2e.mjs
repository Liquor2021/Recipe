// 冰箱库存 API E2E 测试（Node 原生 fetch，UTF-8）
const BASE = "http://localhost:8080/api"
const HEADERS = { "X-App-Token": "nini123", "Content-Type": "application/json" }
let passed = 0, failed = 0

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

async function main() {
  console.log("== 冰箱库存 API E2E ==")

  // 0. 快照现有库存（非破坏性：测试结束后恢复原样）
  const before = await api("GET", "/fridge")
  const snapshot = (before.data || []).map(i => ({ item_name: i.item_name, expiry_date: i.expiry_date }))
  for (const it of snapshot) await api("DELETE", `/fridge/${encodeURIComponent(it.item_name)}`)
  const cleaned = await api("GET", "/fridge")
  check("清场后为空", Array.isArray(cleaned.data) && cleaned.data.length === 0, JSON.stringify(cleaned))

  // 1. 添加（含首尾空格）
  let r = await api("POST", "/fridge", { item_name: "  番茄  " })
  check("添加 番茄(带空格) 成功", r.code === 0, JSON.stringify(r))
  await api("POST", "/fridge", { item_name: "鸡蛋" })
  await api("POST", "/fridge", { item_name: "土豆" })
  await api("POST", "/fridge", { item_name: "青椒" })

  // 2. 列表
  r = await api("GET", "/fridge")
  const names = (r.data || []).map((i) => i.item_name).sort()
  check("列表含 4 项", r.data.length === 4, JSON.stringify(names))
  check("番茄已去空格存储", names.includes("番茄"), JSON.stringify(names))

  // 3. 重复添加不产生重复行
  await api("POST", "/fridge", { item_name: "番茄" })
  r = await api("GET", "/fridge")
  check("重复添加仍为 4 项", r.data.length === 4, `got ${r.data.length}`)

  // 4. 空名拒绝
  r = await api("POST", "/fridge", { item_name: "   " })
  check("空名返回错误", r.code !== 0, JSON.stringify(r))

  // 5. 匹配：别名（西红柿 菜谱 vs 番茄 库存）
  r = await api("GET", "/fridge/recipes?limit=50")
  const matches = r.data || []
  check("匹配结果非空", matches.length > 0, `got ${matches.length}`)
  const tomatoEgg = matches.find((m) => m.dish.name === "番茄炒蛋")
  check("番茄炒蛋 100% 命中", tomatoEgg && tomatoEgg.coverage === 100, tomatoEgg ? `${tomatoEgg.coverage}%` : "未找到")
  if (tomatoEgg) {
    check("全命中时 missing/matched 是数组不是 null", Array.isArray(tomatoEgg.missing) && Array.isArray(tomatoEgg.matched), JSON.stringify({ m: tomatoEgg.missing, mm: tomatoEgg.matched }))
  }
  const niunan = matches.find((m) => m.dish.name === "番茄牛腩")
  if (niunan) {
    check("番茄牛腩 部分命中（姜不进分母，番茄/土豆 命中 = 50%）", niunan.coverage === 50, `${niunan.coverage}%`)
    check("番茄牛腩 missing 含牛腩和洋葱", (niunan.missing || []).includes("牛腩") && (niunan.missing || []).includes("洋葱"), JSON.stringify(niunan.missing))
    check("番茄牛腩 matched 不含常备配料姜", !(niunan.matched || []).includes("姜"), JSON.stringify(niunan.matched))
  }
  // 排序：第一名 coverage 应 >= 第二名
  if (matches.length >= 2) {
    check("按命中率降序", matches[0].coverage >= matches[1].coverage)
  }

  // 6. 移出冰箱
  r = await api("DELETE", `/fridge/${encodeURIComponent("土豆")}`)
  check("移出 土豆 成功", r.code === 0, JSON.stringify(r))
  r = await api("GET", "/fridge")
  check("移出后剩 3 项", r.data.length === 3, `got ${r.data.length}`)
  r = await api("GET", "/fridge/recipes?limit=50")
  const after = r.data.find((m) => m.dish.name === "酸辣土豆丝")
  check("移出土豆后 酸辣土豆丝 不再 100%", !after || after.coverage < 100, after ? `${after.coverage}%` : "未匹配(也合理)")

  // 7. 鉴权：无 token 应 401
  const noAuth = await fetch(BASE + "/fridge")
  check("无 token 返回 401", noAuth.status === 401, `got ${noAuth.status}`)

  // 8. 恢复测试前的库存快照
  const current = await api("GET", "/fridge")
  for (const it of current.data || []) await api("DELETE", `/fridge/${encodeURIComponent(it.item_name)}`)
  for (const it of snapshot) await api("POST", "/fridge", { item_name: it.item_name, expiry_date: it.expiry_date })
  const restored = await api("GET", "/fridge")
  check("恢复原有库存", (restored.data || []).length === snapshot.length, `got ${(restored.data || []).length}, want ${snapshot.length}`)

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("E2E 脚本异常:", e); process.exit(1) })
