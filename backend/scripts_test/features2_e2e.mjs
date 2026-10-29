// 第二批功能 E2E：买菜回来放进冰箱 / 计划与已吃分开统计 / 数据库备份 / 买菜清单精简
// 会留下痕迹（记录会解锁成就、测试菜是软删除），请对着临时库启动的服务跑：
//   DB_PATH=<临时目录>/test.db ./ninimenu   然后   node scripts_test/features2_e2e.mjs
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

async function shoppingItem(name) {
  const r = await req("GET", "/shopping-list")
  return (r.data || []).flatMap((c) => c.items).find((i) => i.name === name)
}

async function main() {
  const login = await req("POST", "/admin/login", { password: "nini123" })
  const AH = { ...H, Authorization: `Bearer ${login.data?.token || ""}` }
  check("管理端登录", login.code === 0, JSON.stringify(login))

  const dish = await req("POST", "/dishes", {
    name: "E2E入库测试菜", category: "家常菜", meal_type: "all",
    ingredients: JSON.stringify([{ name: "E2E入库食材", amount: "2个" }]),
    seasonings: JSON.stringify([{ name: "清水", amount: "200毫升" }]),
  }, AH)
  const dishID = dish.data?.id
  check("创建测试菜品", dish.code === 0 && !!dishID, JSON.stringify(dish))

  console.log("== 买菜回来放进冰箱 ==")
  const rec = await req("POST", "/records", { dish_id: dishID, dish_name: "E2E入库测试菜", meal_type: "dinner", meal_date: dayFromNow(0) })
  check("记录测试菜（生成买菜清单）", rec.code === 0, JSON.stringify(rec))
  check("清水不进买菜清单", !(await shoppingItem("清水")))
  await req("POST", "/shopping-list/toggle", { item_name: "E2E入库食材", meal_date: dayFromNow(0), checked: true })
  let item = await shoppingItem("E2E入库食材")
  check("勾选已买后还没放进冰箱", item && item.checked && !item.stocked && !item.in_stock, JSON.stringify(item))
  let r = await req("POST", "/shopping-list/stock-in", { items: [{ item_name: "E2E入库食材", quantity: "2个" }] })
  check("放进冰箱 1 样", r.code === 0 && r.data?.added === 1, JSON.stringify(r))
  const batch = ((await req("GET", "/fridge")).data || []).find((b) => b.item_name === "E2E入库食材")
  check("冰箱里有这一批（数量取清单、自动设保质期）", batch && batch.quantity === "2个" && /^\d{4}-\d{2}-\d{2}$/.test(batch.expiry_date), JSON.stringify(batch))
  item = await shoppingItem("E2E入库食材")
  check("清单里标记已放入、家中有", item && item.stocked && item.in_stock, JSON.stringify(item))
  r = await req("POST", "/shopping-list/stock-in", { items: [] })
  check("空列表返回 400", r.status === 400, JSON.stringify(r))

  console.log("== 计划与已吃分开统计 ==")
  const statsBefore = (await req("GET", "/stats")).data
  const plan = await req("POST", "/records", { dish_id: dishID, dish_name: "E2E入库测试菜", meal_type: "lunch", meal_date: dayFromNow(1) })
  check("保存明天的计划", plan.code === 0, JSON.stringify(plan))
  const statsAfter = (await req("GET", "/stats")).data
  check("明天的计划不计入累计做饭/午餐次数", statsAfter.total_records === statsBefore.total_records && statsAfter.lunch_count === statsBefore.lunch_count, JSON.stringify({ statsBefore, statsAfter }))
  const dishRecs = (await req("GET", `/dishes/${dishID}/records`)).data
  check("菜品详情列表里有计划，但\"做了几次/上次做\"只算吃过的", dishRecs.records.length === 2 && dishRecs.stats.total_count === 1 && dishRecs.stats.last_date === dayFromNow(0), JSON.stringify(dishRecs.stats))
  if (plan.data?.id) await req("DELETE", `/records/${plan.data.id}`)

  // 清理
  await req("DELETE", `/fridge/${encodeURIComponent("E2E入库食材")}`)
  if (rec.data?.id) await req("DELETE", `/records/${rec.data.id}`)
  if (dishID) await req("DELETE", `/dishes/${dishID}`, undefined, AH)

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("E2E 异常:", e); process.exit(1) })
