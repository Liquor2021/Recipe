// 审核修复 E2E：扣库存精确匹配 / 补料 / 家中有 / 严格忌口全覆盖 / 周菜单缓存失效
// 会留下少量 "E2E" 前缀的测试数据（补料条目没有删除接口），请对着临时库启动的服务跑：
//   DB_PATH=<临时目录>/test.db ./ninimenu   然后   node scripts_test/verify_review_fixes.mjs
const BASE = "http://localhost:8080/api"
const H = { "X-App-Token": "nini123", "Content-Type": "application/json" }
let passed = 0, failed = 0

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

async function req(method, path, body, headers = H) {
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}

const dayFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }
// 与后端 dishMatchesDislike 的"辣"口径一致：口味/菜名/菜系含辣
const isSpicy = (d) => [d.taste, d.name, d.category].some((s) => (s || "").includes("辣"))
const planIDs = (p) => (p?.days || []).flatMap((d) => [...d.lunch, ...d.dinner].map((x) => x.id))
const asSetting = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v))

async function shoppingItem(name) {
  const r = await req("GET", "/shopping-list")
  return (r.data || []).flatMap((c) => c.items).find((i) => i.name === name)
}

async function main() {
  const login = await req("POST", "/admin/login", { password: "nini123" })
  const AH = { ...H, Authorization: `Bearer ${login.data?.token || ""}` }
  check("管理端登录", login.code === 0, JSON.stringify(login))

  // 快照：冰箱 + 忌口设置 + 每餐道数（结束时恢复）
  const fridgeBefore = (await req("GET", "/fridge")).data || []
  const settingsBefore = (await req("GET", "/settings")).data || {}
  const lunchBefore = asSetting(settingsBefore.lunch_dishes_per_day) || "1"
  for (const name of new Set(fridgeBefore.map((b) => b.item_name))) await req("DELETE", `/fridge/${encodeURIComponent(name)}`)

  const dish = await req("POST", "/dishes", {
    name: "E2E排骨测试", category: "家常菜", meal_type: "all", taste: "咸鲜",
    ingredients: JSON.stringify([{ name: "排骨", amount: "500g" }, { name: "E2E测试食材", amount: "3份" }, { name: "小葱", amount: "1根" }]),
    seasonings: JSON.stringify([{ name: "生抽", amount: "1勺" }]),
  }, AH)
  const dishID = dish.data?.id
  check("创建测试菜品", dish.code === 0 && !!dishID, JSON.stringify(dish))

  console.log("== 扣库存：精确匹配，不扣错部位 ==")
  await req("POST", "/fridge", { item_name: "五花肉", quantity: "1块", expiry_date: dayFromNow(1) })
  await req("POST", "/fridge", { item_name: "排骨", quantity: "500g", expiry_date: dayFromNow(6) })
  const fridge = (await req("GET", "/fridge")).data || []
  const pork = fridge.find((b) => b.item_name === "五花肉")
  const ribs = fridge.find((b) => b.item_name === "排骨")
  let r = await req("GET", `/fridge/consumption?dish_id=${dishID}`)
  const slot = (r.data?.slots || []).find((s) => s.requested_name === "排骨")
  check("排骨槽默认勾选排骨批（不是明天到期的五花肉）", slot && slot.suggested_batch_id === ribs?.id, JSON.stringify(r.data))
  check("五花肉只作为相近部位列出", slot && slot.batches.some((b) => b.batch_id === pork?.id && b.kind === "similar"), JSON.stringify(slot))
  check("常备配料小葱不参与扣减", !(r.data?.slots || []).some((s) => s.requested_name === "小葱"), JSON.stringify(r.data?.slots))
  r = await req("POST", "/fridge/consume", { batch_ids: [ribs?.id] })
  check("批量扣库存移除 1 批", r.code === 0 && r.data?.removed === 1, JSON.stringify(r))
  const left = (await req("GET", "/fridge")).data || []
  check("五花肉仍在冰箱", left.some((b) => b.id === pork?.id) && !left.some((b) => b.id === ribs?.id), JSON.stringify(left.map((b) => b.item_name)))
  r = await req("GET", "/fridge/consumption?dish_id=99999999")
  check("菜品不存在返回 404", r.status === 404, JSON.stringify(r))
  r = await req("POST", "/fridge/consume", { batch_ids: [] })
  check("空批次列表返回 400", r.status === 400, JSON.stringify(r))

  console.log("== 补料：真实结果 + 菜谱用量 ==")
  r = await req("POST", "/shopping-list/items", { dish_id: dishID, dish_name: "E2E排骨测试", items: [{ name: "E2E测试食材" }] })
  check("补料返回 added=1", r.code === 0 && r.data?.added === 1, JSON.stringify(r))
  r = await req("POST", "/shopping-list/items", { dish_id: dishID, dish_name: "E2E排骨测试", items: [{ name: "E2E测试食材" }] })
  check("重复补料 added=0", r.code === 0 && r.data?.added === 0, JSON.stringify(r))
  const extra = await shoppingItem("E2E测试食材")
  check("补料带上菜谱用量 3份", extra && extra.amount === "3份", JSON.stringify(extra))

  console.log("== 家中有：过期不算、取消只移未过期批 ==")
  const rec = await req("POST", "/records", { dish_id: dishID, dish_name: "E2E排骨测试", meal_type: "lunch", meal_date: dayFromNow(0) })
  check("记录测试菜（生成买菜清单）", rec.code === 0, JSON.stringify(rec))
  const afterRecord = await shoppingItem("E2E测试食材")
  check("先补料再记录这道菜，用量不翻倍（仍是 3份）", afterRecord && afterRecord.amount === "3份", JSON.stringify(afterRecord))
  await req("POST", "/fridge", { item_name: "排骨", expiry_date: dayFromNow(-1) }) // 已过期的一批
  let item = await shoppingItem("排骨")
  check("只有过期排骨时不算家中有", item && !item.in_stock && item.stock_batches === 0, JSON.stringify(item))
  await req("POST", "/shopping-list/inventory", { item_name: "排骨", in_stock: true })
  item = await shoppingItem("排骨")
  check("点家中有后 stock_batches=1", item && item.in_stock && item.stock_batches === 1, JSON.stringify(item))
  r = await req("POST", "/shopping-list/inventory", { item_name: "排骨", in_stock: false })
  const ribsLeft = ((await req("GET", "/fridge")).data || []).filter((b) => b.item_name === "排骨")
  check("取消家中有只移未过期批，过期批留给冰箱页", r.code === 0 && ribsLeft.length === 1 && ribsLeft[0].expiry_date === dayFromNow(-1), JSON.stringify(ribsLeft))
  r = await req("POST", "/shopping-list/inventory", { item_name: "   ", in_stock: true })
  check("空白食材名返回 400", r.status === 400, JSON.stringify(r))

  console.log("== 严格忌口：周菜单/心情/盲盒/清冰箱全覆盖 ==")
  r = await req("PUT", "/settings", { settings: { family_members: JSON.stringify([{ name: "E2E", dislikes: ["辣"] }]), family_dislike_mode: "strict" } }, AH)
  check("保存 strict 忌口", r.code === 0, JSON.stringify(r))
  const strictPlan = (await req("GET", "/week-plan")).data
  const spicyInPlan = (strictPlan?.days || []).flatMap((d) => [...d.lunch, ...d.dinner]).filter(isSpicy)
  check("周菜单立即按新忌口生效、无辣菜", (strictPlan?.days || []).length === 7 && spicyInPlan.length === 0, JSON.stringify(spicyInPlan.map((d) => d.name)))
  r = await req("POST", "/pick/mood", { mood: "spicy" })
  check("想吃辣心情推荐不出现辣菜", r.status === 404 || (r.code === 0 && (r.data?.dishes || []).length > 0 && !r.data.dishes.some(isSpicy)), JSON.stringify(r).slice(0, 200))
  r = await req("POST", "/pick/blind-box")
  check("盲盒不出现辣菜", r.status === 404 || (r.code === 0 && !isSpicy(r.data?.dish || {})), JSON.stringify(r.data?.dish?.name))
  await req("POST", "/fridge", { item_name: "鸡蛋" })
  r = await req("GET", "/fridge/recipes?limit=50")
  check("清冰箱推荐不出现辣菜", r.code === 0 && !(r.data || []).some((m) => isSpicy(m.dish)), JSON.stringify((r.data || []).filter((m) => isSpicy(m.dish)).map((m) => m.dish.name)))
  r = await req("GET", "/dishes?enabled=true&sort=random&pageSize=100&exclude_disliked=1")
  check("首页推荐位（exclude_disliked）不出现辣菜", r.code === 0 && r.data.items.length > 0 && !r.data.items.some(isSpicy), JSON.stringify(r.data?.items?.filter(isSpicy).map((d) => d.name)))
  const allEnabled = await req("GET", "/dishes?enabled=true&pageSize=1")
  check("普通菜品列表不受忌口过滤", allEnabled.data?.total > r.data?.total, `${allEnabled.data?.total} vs ${r.data?.total}`)

  console.log("== 周菜单缓存：设置变化才失效 ==")
  await req("PUT", "/settings", { settings: { family_dislike_mode: "avoid" } }, AH)
  const avoidPlan = (await req("GET", "/week-plan")).data
  check("strict → avoid：原菜单仍合规，不重排", JSON.stringify(planIDs(avoidPlan)) === JSON.stringify(planIDs(strictPlan)))
  await req("PUT", "/settings", { settings: { lunch_dishes_per_day: String(Number(lunchBefore) + 1) } }, AH)
  const morePlan = (await req("GET", "/week-plan")).data
  check("午餐道数 +1 后菜单重新生成", (morePlan?.days || []).length === 7 && morePlan.days.every((d) => d.lunch.length === Number(lunchBefore) + 1), JSON.stringify((morePlan?.days || []).map((d) => d.lunch.length)))

  // 清理：记录、测试菜、冰箱、设置
  if (rec.data?.id) await req("DELETE", `/records/${rec.data.id}`)
  if (dishID) await req("DELETE", `/dishes/${dishID}`, undefined, AH)
  for (const name of new Set(((await req("GET", "/fridge")).data || []).map((b) => b.item_name))) await req("DELETE", `/fridge/${encodeURIComponent(name)}`)
  for (const b of fridgeBefore) await req("POST", "/fridge", { item_name: b.item_name, quantity: b.quantity, expiry_date: b.expiry_date })
  await req("PUT", "/settings", { settings: {
    family_members: asSetting(settingsBefore.family_members),
    family_dislike_mode: asSetting(settingsBefore.family_dislike_mode),
    lunch_dishes_per_day: lunchBefore,
  } }, AH)
  const restored = (await req("GET", "/settings")).data || {}
  check("设置能恢复（含清空成空串）", asSetting(restored.family_members) === asSetting(settingsBefore.family_members), `${asSetting(restored.family_members)} vs ${asSetting(settingsBefore.family_members)}`)

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("E2E 异常:", e); process.exit(1) })
