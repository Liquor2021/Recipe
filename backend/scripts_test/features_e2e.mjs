// 新功能批量 E2E：临期管理 / 食材搜索 / 健康报告 / 家庭忌口
const BASE = "http://localhost:8080/api"
const H = { "X-App-Token": "nini123", "Content-Type": "application/json" }
let passed = 0, failed = 0

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) })
  return res.json()
}

function dayStr(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

async function main() {
  console.log("== 临期管理 ==")
  // 清场
  const before = await api("GET", "/fridge")
  for (const it of before.data || []) await api("DELETE", `/fridge/${encodeURIComponent(it.item_name)}`)

  let r = await api("POST", "/fridge", { item_name: "番茄", expiry_date: dayStr(1) })
  check("添加番茄(明天到期)", r.code === 0, JSON.stringify(r))
  await api("POST", "/fridge", { item_name: "鸡蛋" }) // 不带 expiry，应自动按字典设 30 天

  r = await api("GET", "/fridge")
  const items = r.data || []
  check("列表 2 项", items.length === 2, JSON.stringify(items.map(i => i.item_name)))
  const tomato = items.find(i => i.item_name === "番茄")
  const egg = items.find(i => i.item_name === "鸡蛋")
  check("番茄排最前(临期优先)", items[0].item_name === "番茄", JSON.stringify(items.map(i => i.item_name)))
  check("鸡蛋自动设了默认保质期", egg && /^\d{4}-\d{2}-\d{2}$/.test(egg.expiry_date || ""), JSON.stringify(egg))

  r = await api("GET", "/fridge/urgent")
  check("urgent 接口含番茄", (r.data || []).some(i => i.item_name === "番茄"), JSON.stringify(r.data))

  r = await api("GET", "/fridge/recipes?limit=50")
  const tomatoEgg = (r.data || []).find(m => m.dish.name === "番茄炒蛋")
  check("番茄炒蛋命中且 using_urgent 含番茄", tomatoEgg && (tomatoEgg.using_urgent || []).includes("番茄"), JSON.stringify(tomatoEgg))
  const first100 = (r.data || []).filter(m => m.coverage === 100)
  check("同命中率下临期菜排最前", first100.length > 1 && first100[0].using_urgent?.length > 0, JSON.stringify(first100.slice(0, 2).map(m => [m.dish.name, m.using_urgent])))

  r = await api("POST", "/fridge", { item_name: "土豆", expiry_date: "2026-13-99" })
  check("非法日期返回错误", r.code !== 0, JSON.stringify(r))

  // 清冰箱推荐排序验证后清场
  console.log("== 食材搜索 ==")
  r = await api("GET", "/dishes?search=鸡蛋&pageSize=100")
  check("搜鸡蛋命中番茄炒蛋", (r.data.items || []).some(d => d.name === "番茄炒蛋"), `total=${r.data.total}`)
  r = await api("GET", "/dishes?search=土豆&pageSize=100")
  check("搜土豆命中醋溜土豆丝", (r.data.items || []).some(d => d.name === "醋溜土豆丝"), `total=${r.data.total}`)
  r = await api("GET", "/dishes?search=番茄炒蛋&pageSize=50")
  check("搜菜名照常工作", (r.data.items || []).some(d => d.name === "番茄炒蛋"), `total=${r.data.total}`)
  r = await api("GET", "/dishes?search=不存在的食材xyz&pageSize=50")
  check("无命中返回空", r.data.total === 0, `total=${r.data.total}`)
  r = await api("GET", "/dishes?search=鸡&category=川菜&pageSize=50")
  check("搜索与分类过滤可组合", (r.data.items || []).every(d => d.category === "川菜"), JSON.stringify(r.data.items?.map(d => d.category)))

  console.log("== 健康报告 ==")
  r = await api("GET", "/report?range=week")
  const rep = r.data || {}
  check("报告结构完整", typeof rep.cook_days === "number" && typeof rep.repeat_rate === "number" && Array.isArray(rep.taste_shares) && Array.isArray(rep.top_dishes), JSON.stringify(Object.keys(rep)))
  check("周报日期是本周", rep.start_date && rep.end_date && rep.start_date <= dayStr(0) && rep.end_date >= dayStr(0), `${rep.start_date}~${rep.end_date}`)
  check("总餐数与记录一致", rep.total_meals >= 1, `total_meals=${rep.total_meals}`)
  r = await api("GET", "/report?range=month")
  check("月报可生成", r.data && r.data.range === "month", JSON.stringify(r.data?.range))

  console.log("== 家庭忌口 ==")
  // admin 接口需要 JWT：先登录拿 token
  const login = await fetch(BASE + "/admin/login", { method: "POST", headers: H, body: JSON.stringify({ password: "nini123" }) })
  const loginData = await login.json()
  const adminH = { ...H, Authorization: `Bearer ${loginData.data?.token || ""}` }
  async function adminApi(method, path, body) {
    const res = await fetch(BASE + path, { method, headers: adminH, body: body === undefined ? undefined : JSON.stringify(body) })
    return res.json()
  }
  r = await adminApi("PUT", "/settings", { settings: { family_members: JSON.stringify([{ name: "测试成员", dislikes: ["辣", "海鲜"] }]) } })
  check("保存家庭设置", r.code === 0, JSON.stringify(r))
  r = await api("GET", "/settings")
  check("设置读回一致", JSON.stringify(r.data?.family_members || "").includes("海鲜"), JSON.stringify(r.data?.family_members))
  r = await api("POST", "/pick/lunch")
  check("配置忌口后推荐不崩", r.code === 0, JSON.stringify(r).slice(0, 120))
  r = await api("POST", "/pick/tomorrow", { meal_type: "dinner", profile: "spicy", count: 2 })
  check("明日菜单忌口降权不崩", r.code === 0, JSON.stringify(r).slice(0, 120))
  // 清掉测试设置，避免影响真实使用
  await adminApi("PUT", "/settings", { settings: { family_members: "" } })

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("E2E 异常:", e); process.exit(1) })
