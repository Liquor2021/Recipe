// 第三批功能 E2E：周菜单只换一道菜 / 清冰箱推荐显示真实库存名 / 饮食报告荤素搭配
// 会改动本周菜单缓存、清掉冰箱里的猪肉批次，请对着临时库启动的服务跑：
//   DB_PATH=<临时目录>/test.db ./ninimenu   然后   node scripts_test/features3_e2e.mjs
const BASE = "http://localhost:8080/api"
const H = { "X-App-Token": "123456", "Content-Type": "application/json" }
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
const todayString = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }

// 覆盖本轮修复的 API 链路；只清理本段新建的数据，设置在失败时也恢复。
async function verifyFoodFixes(AH) {
  const settings = (await req("GET", "/settings")).data
  const asSetting = (v) => v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)
  const dishIDs = [], recordIDs = [], batchIDs = []
  const createDish = async (name, names) => {
    const r = await req("POST", "/dishes", {
      name, category: "家常菜", meal_type: "all",
      ingredients: JSON.stringify(names.map((name) => ({ name, amount: "200克" }))),
    }, AH)
    if (r.code !== 0 || !r.data?.id) throw new Error(`创建回归菜品失败: ${JSON.stringify(r)}`)
    dishIDs.push(r.data.id)
    return r.data
  }
  const record = async (dish) => {
    const r = await req("POST", "/records", { dish_id: dish.id, dish_name: dish.name, meal_type: "dinner", meal_date: todayString(), status: "completed" })
    if (r.code !== 0 || !r.data?.id) throw new Error(`创建回归记录失败: ${JSON.stringify(r)}`)
    recordIDs.push(r.data.id)
  }
  const balance = async () => (await req("GET", "/report?range=week")).data.balance
  try {
    console.log("== 严格猪肉忌口：真实肥肠菜谱 ==")
    const ordinary = await req("GET", `/dishes?search=${encodeURIComponent("肥肠")}&enabled=true&pageSize=100`)
    const names = (ordinary.data?.items || []).map((d) => d.name)
    check("种子菜包含肥肠粉和干锅肥肠", names.includes("肥肠粉") && names.includes("干锅肥肠"), JSON.stringify(names))
    const saved = await req("PUT", "/settings", { settings: { family_members: JSON.stringify([{ name: "E2E", dislikes: ["猪肉"] }]), family_dislike_mode: "strict" } }, AH)
    if (saved.code !== 0) throw new Error(`保存忌口失败: ${JSON.stringify(saved)}`)
    const filtered = await req("GET", `/dishes?search=${encodeURIComponent("肥肠")}&enabled=true&pageSize=100&recommend=1`)
    check("严格推荐排除肥肠粉和干锅肥肠", filtered.code === 0 && !(filtered.data?.items || []).some((d) => ["肥肠粉", "干锅肥肠"].includes(d.name)), JSON.stringify(filtered.data?.items?.map((d) => d.name)))

    console.log("== 具体肉片不能默认扣排骨 ==")
    for (const [requested, stock] of [["猪肉片", "排骨"], ["排骨", "猪肉片"], ["羊肉片", "羊排"]]) {
      const dish = await createDish(`E2E扣库存${requested}`, [requested])
      const before = new Set(((await req("GET", "/fridge")).data || []).map((b) => b.id))
      const added = await req("POST", "/fridge", { item_name: stock, quantity: "500克" })
      if (added.code !== 0) throw new Error(`创建回归库存失败: ${JSON.stringify(added)}`)
      const batch = ((await req("GET", "/fridge")).data || []).find((b) => b.item_name === stock && !before.has(b.id))
      if (!batch) throw new Error(`未找到新建的${stock}批次`)
      batchIDs.push(batch.id)
      const result = await req("GET", `/fridge/consumption?dish_id=${dish.id}`)
      const slot = result.data?.slots?.find((s) => s.requested_name === requested)
      check(`${requested}对${stock}仅作参考、不默认扣减`, result.code === 0 && slot && slot.suggested_batch_id !== batch.id && slot.batches.some((b) => b.batch_id === batch.id && b.kind === "similar"), JSON.stringify(slot))
    }

    console.log("== 报告区分主料与调味变体 ==")
    const fish = await createDish("E2E豆豉鲮鱼油麦菜", ["豆豉鲮鱼罐头", "油麦菜"])
    const beforeFish = await balance()
    await record(fish)
    const afterFish = await balance()
    check("鱼罐头加油麦菜计为有荤有素", afterFish.mixed_count === beforeFish.mixed_count + 1 && afterFish.veg_count === beforeFish.veg_count && afterFish.meat_count === beforeFish.meat_count, JSON.stringify({ beforeFish, afterFish }))

    const seasoning = await createDish("E2E调味不算蔬菜", ["猪肉", "干辣椒段", "香菜末", "蒜泥", "芜荽"])
    await record(seasoning)
    const afterSeasoning = await balance()
    check("猪肉加调味食材计为只有荤", afterSeasoning.meat_count === afterFish.meat_count + 1 && afterSeasoning.mixed_count === afterFish.mixed_count && afterSeasoning.veg_count === afterFish.veg_count, JSON.stringify(afterSeasoning))
    check("调味食材不增加蔬菜种类与次数", JSON.stringify(afterSeasoning.vegetables) === JSON.stringify(afterFish.vegetables), JSON.stringify(afterSeasoning.vegetables))
  } finally {
    for (const id of recordIDs) await req("DELETE", `/records/${id}`)
    for (const id of dishIDs) await req("DELETE", `/dishes/${id}`, undefined, AH)
    for (const id of batchIDs) await req("DELETE", `/fridge/batch/${id}`)
    const restored = await req("PUT", "/settings", { settings: { family_members: asSetting(settings.family_members), family_dislike_mode: asSetting(settings.family_dislike_mode) } }, AH)
    if (restored.code !== 0) throw new Error(`恢复忌口设置失败: ${JSON.stringify(restored)}`)
  }
}

async function main() {
  console.log("== 周菜单只换一道菜 ==")
  const before = (await req("GET", "/week-plan")).data
  const day = before?.days?.find((d) => d.date === todayString())
  check("本周菜单有 7 天", before?.days?.length === 7 && day?.lunch?.length > 0, JSON.stringify(before?.days?.length))
  const target = day.lunch[0]
  let r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "lunch", dish_id: target.id })
  check("换菜成功，返回换上的菜", r.code === 0 && r.data?.dish?.id > 0 && r.data.dish.id !== target.id, JSON.stringify(r).slice(0, 200))
  const swappedIn = r.data?.dish
  const a = planIDs(before), b = planIDs(r.data?.plan)
  const diff = a.map((id, i) => (id === b[i] ? null : i)).filter((i) => i !== null)
  check("整份菜单只变了那一道", a.length === b.length && diff.length === 1 && b[diff[0]] === swappedIn?.id, JSON.stringify({ diff }))
  const reread = (await req("GET", "/week-plan")).data
  const rereadDay = reread?.days?.find((d) => d.date === day.date)
  check("再读一次还是换过的（已保存）", rereadDay?.lunch?.[0]?.id === swappedIn?.id, JSON.stringify(rereadDay?.lunch?.map((x) => x.id)))

  r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "lunch", dish_id: target.id })
  check("拿旧菜单再换同一道返回 409", r.status === 409 && r.code !== 0, JSON.stringify(r))
  r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "breakfast", dish_id: swappedIn?.id })
  check("餐别无效返回 400", r.status === 400, JSON.stringify(r))
  r = await req("POST", "/week-plan/swap", { date: "下周三", meal_type: "lunch", dish_id: swappedIn?.id })
  check("日期格式无效返回 400", r.status === 400, JSON.stringify(r))
  r = await req("POST", "/week-plan/swap", { date: day.date, meal_type: "lunch", dish_id: swappedIn?.id }, { "Content-Type": "application/json" })
  check("没有应用口令返回 401", r.status === 401, String(r.status))

  console.log("== 清冰箱推荐显示冰箱里的真实名字 ==")
  const login = await req("POST", "/admin/login", { password: "123456" })
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

  console.log("== 饮食报告：荤素搭配 ==")
  // 其他脚本会在临时库里留下记录，这里只看记录前后的增量
  const todayStr = todayString()
  const balBefore = (await req("GET", "/report?range=week")).data?.balance
  check("周报带荤素搭配字段", balBefore && Number.isInteger(balBefore.mixed_count) && Array.isArray(balBefore.vegetables), JSON.stringify(balBefore))
  // 蔬菜名用纯中文：统计时按真别名归一，拉丁字母会被转成小写
  const testVeg = "测试荤素专用菜"
  const mixDish = await req("POST", "/dishes", {
    name: "E2E荤素测试菜", category: "家常菜", meal_type: "all",
    ingredients: JSON.stringify([{ name: "瘦肉", amount: "200克" }, { name: testVeg, amount: "1把" }, { name: "小葱", amount: "1根" }]),
  }, AH)
  const mixRec = await req("POST", "/records", { dish_id: mixDish.data?.id, dish_name: "E2E荤素测试菜", meal_type: "dinner", meal_date: todayStr, status: "completed" })
  check("记录一道荤素搭配的菜", mixDish.code === 0 && mixRec.code === 0, JSON.stringify({ d: mixDish.code, r: mixRec }))
  const balAfter = (await req("GET", "/report?range=week")).data?.balance
  check("有荤有素 +1，另外两类不变", balAfter && balAfter.mixed_count === balBefore.mixed_count + 1 && balAfter.meat_count === balBefore.meat_count && balAfter.veg_count === balBefore.veg_count, JSON.stringify({ balBefore, balAfter }))
  const v = (balAfter?.vegetables || []).find((x) => x.name === testVeg)
  check("吃到的蔬菜里有它，葱不算", v && v.count === 1 && !(balAfter?.vegetables || []).some((x) => x.name === "小葱"), JSON.stringify(balAfter?.vegetables))
  if (mixRec.data?.id) await req("DELETE", `/records/${mixRec.data.id}`)
  if (mixDish.data?.id) await req("DELETE", `/dishes/${mixDish.data.id}`, undefined, AH)

  await verifyFoodFixes(AH)

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("E2E 异常:", e); process.exit(1) })
