// 第三批功能 E2E：周菜单只换一道菜 / 清冰箱推荐显示真实库存名
// 会改动本周菜单缓存、清掉冰箱里的猪肉批次，请对着临时库启动的服务跑：
//   DB_PATH=<临时目录>/test.db ./ninimenu   然后   node scripts_test/features3_e2e.mjs
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

const planIDs = (plan) => (plan?.days || []).flatMap((d) => [...d.lunch, ...d.dinner].map((x) => x.id))

async function main() {
  console.log("== 周菜单只换一道菜 ==")
  const before = (await req("GET", "/week-plan")).data
  const day = before?.days?.[3]
  check("本周菜单有 7 天", before?.days?.length === 7 && day?.lunch?.length > 0, JSON.stringify(before?.days?.length))
  const target = day.lunch[0]
  let r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "lunch", dish_id: target.id })
  check("换菜成功，返回换上的菜", r.code === 0 && r.data?.dish?.id > 0 && r.data.dish.id !== target.id, JSON.stringify(r).slice(0, 200))
  const swappedIn = r.data?.dish
  const a = planIDs(before), b = planIDs(r.data?.plan)
  const diff = a.map((id, i) => (id === b[i] ? null : i)).filter((i) => i !== null)
  check("整份菜单只变了那一道", a.length === b.length && diff.length === 1 && b[diff[0]] === swappedIn?.id, JSON.stringify({ diff }))
  const reread = (await req("GET", "/week-plan")).data
  check("再读一次还是换过的（已保存）", reread?.days?.[3]?.lunch?.[0]?.id === swappedIn?.id, JSON.stringify(reread?.days?.[3]?.lunch?.map((x) => x.id)))

  r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "lunch", dish_id: target.id })
  check("拿旧菜单再换同一道返回 409", r.status === 409 && r.code !== 0, JSON.stringify(r))
  r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "breakfast", dish_id: swappedIn?.id })
  check("餐别无效返回 400", r.status === 400, JSON.stringify(r))
  r = await req("POST", "/week-plan/swap", { date: "下周三", meal_type: "lunch", dish_id: swappedIn?.id })
  check("日期格式无效返回 400", r.status === 400, JSON.stringify(r))
  r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "lunch", dish_id: swappedIn?.id }, { "Content-Type": "application/json" })
  check("没有应用口令返回 401", r.status === 401, String(r.status))

  console.log("== 清冰箱推荐显示冰箱里的真实名字 ==")
  const login = await req("POST", "/admin/login", { password: "nini123" })
  const AH = { ...H, Authorization: `Bearer ${login.data?.token || ""}` }
  const dish = await req("POST", "/dishes", {
    name: "E2E五花肉测试菜", category: "家常菜", meal_type: "all",
    ingredients: JSON.stringify([{ name: "瘦肉", amount: "200克" }, { name: "E2E独有菜", amount: "1把" }]),
  }, AH)
  const dishID = dish.data?.id
  check("创建测试菜品", dish.code === 0 && !!dishID, JSON.stringify(dish))
  // 前面的脚本可能留下别的猪肉批次（同大类只取最早到期的一批），先清掉
  for (const name of ["猪肉", "瘦肉", "五花肉", "肉末", "排骨"]) await req("DELETE", `/fridge/${encodeURIComponent(name)}`)
  await req("POST", "/fridge", { item_name: "五花肉", quantity: "500克" })
  await req("POST", "/fridge", { item_name: "E2E独有菜", quantity: "1把" })
  const m = ((await req("GET", "/fridge/recipes?limit=50")).data || []).find((x) => x.dish?.id === dishID)
  check("测试菜出现在推荐里且全部命中", m && m.coverage === 100, JSON.stringify(m && { coverage: m.coverage, matched: m.matched }))
  const pork = (m?.have || []).find((h) => h.recipe === "瘦肉")
  check("瘦肉那一项显示冰箱里的五花肉、标成代用", pork && pork.stock === "五花肉" && pork.substitute === true, JSON.stringify(m?.have))
  const own = (m?.have || []).find((h) => h.recipe === "E2E独有菜")
  check("同名食材不算代用", own && own.stock === "E2E独有菜" && own.substitute === false, JSON.stringify(m?.have))
  check("matched 仍是菜谱原名（与 have 一一对应）", JSON.stringify(m?.matched) === JSON.stringify(["瘦肉", "E2E独有菜"]), JSON.stringify(m?.matched))
  await req("DELETE", `/fridge/${encodeURIComponent("五花肉")}`)
  await req("DELETE", `/fridge/${encodeURIComponent("E2E独有菜")}`)
  if (dishID) await req("DELETE", `/dishes/${dishID}`, undefined, AH)

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("E2E 异常:", e); process.exit(1) })
