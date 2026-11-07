// 计划状态、份量与买菜/库存的接口回归；必须对临时数据库运行。
// node backend/scripts_test/meal_status_portions_e2e.mjs
const BASE = process.env.TEST_API_BASE || "http://localhost:8080/api"
const H = { "X-App-Token": process.env.TEST_APP_PASSWORD || "nini123", "Content-Type": "application/json" }
let passed = 0, failed = 0
const records = new Set(), dishes = [], batches = []
const stamp = Date.now()
const numericItem = "E2E份量食材" + stamp
const textItem = "E2E适量调味" + stamp
const bareItem = "E2E无单位" + stamp
const day = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-")
}
function check(name, value, detail) {
  if (value) { passed++; console.log("  ✓ " + name) }
  else { failed++; console.error("  ✗ " + name, detail ?? "") }
}
async function req(method, path, body, headers = H) {
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  return { httpStatus: res.status, ...json }
}
async function get(path, headers) { return (await req("GET", path, undefined, headers)).data }
async function shopping() { return (await get("/shopping-list")).flatMap(c => c.items) }
async function remember(body) {
  const r = await req("POST", "/records", body)
  if (r.data?.id) records.add(r.data.id)
  return r
}

const login = await req("POST", "/admin/login", { password: process.env.TEST_ADMIN_PASSWORD || "nini123" })
if (!login.data?.token) throw new Error("测试服务管理端登录失败")
const AH = { ...H, Authorization: "Bearer " + login.data.token }
try {
  const createdDish = await req("POST", "/dishes", {
    name: "E2E计划份量" + stamp, category: "家常菜", meal_type: "all",
    ingredients: JSON.stringify([{ name: numericItem, amount: "200克" }, { name: bareItem, amount: "2" }]),
    seasonings: JSON.stringify([{ name: textItem, amount: "适量" }]),
  }, AH)
  if (!createdDish.data?.id) throw new Error(JSON.stringify(createdDish))
  const dish = createdDish.data; dishes.push(dish.id)
  const payload = { dish_id: dish.id, dish_name: dish.name, meal_type: "lunch", meal_date: day() }
  const beforeStats = await get("/stats")
  const beforeReport = await get("/report?range=week")
  const beforeLunch = await get(`/records?status=completed&meal_type=lunch&date_from=${day()}&date_to=${day()}&pageSize=1`)
  const expectedMealsAfterCompletion = beforeReport.total_meals + (beforeLunch.total > 0 ? 0 : 1)
  const beforeDashboard = await get("/admin/dashboard", AH)

  const plan = await remember({ ...payload, portion_scale: 2 })
  const id = plan.data?.id
  check("省略状态也保存为计划，保存双倍用量", plan.code === 0 && plan.data.status === "planned" && plan.data.portion_scale === 2, plan)
  check("单条记录接口可恢复份量", (await get("/records/" + id)).portion_scale === 2)
  let items = await shopping()
  check("双倍食材进入买菜清单", items.find(i => i.name === numericItem)?.amount === "400克", items)
  check("数字无单位也缩放", items.find(i => i.name === bareItem)?.amount === "4", items)
  check("适量原文保留", items.find(i => i.name === textItem)?.amount === "适量", items)
  check("当天计划不增加吃过统计", (await get("/stats")).total_records === beforeStats.total_records)
  check("当天计划不增加饮食报告", (await get("/report?range=week")).total_meals === beforeReport.total_meals)
  check("后台吃过次数排除计划", (await get("/admin/dashboard", AH)).total_records === beforeDashboard.total_records)
  check("菜品详情吃过次数排除计划", (await get("/dishes/" + dish.id + "/records")).stats.total_count === 0)

  await req("POST", "/shopping-list/toggle", { item_name: numericItem, meal_date: day(), checked: true })
  let r = await req("PUT", "/records/" + id, { portion_scale: 2.5 })
  check("可修改计划份量", r.code === 0 && r.data.portion_scale === 2.5, r)
  items = await shopping()
  check("增加份量保留旧采购400克且新增100克待买", items.find(i => i.name === numericItem)?.amount === "500克" && !items.find(i => i.name === numericItem)?.checked && items.find(i => i.name === numericItem)?.pending_amount === "100克" && items.find(i => i.name === numericItem)?.stock_in_amount === "400克", items)
  await req("POST", "/shopping-list/stock-in", { items: [{ item_name: numericItem, quantity: "1000克" }] })
  const batch = (await get("/fridge")).find(b => b.item_name === numericItem)
  if (batch) batches.push(batch.id)
  check("旧页面入库总量不能超过尚未入库的400克采购", batch?.quantity === "400克", batch)
  // 后续验证扣减建议：单独补录家中实际库存到1000克，不用入库接口伪造采购量。
  if (batch) await req("PUT", `/fridge/batch/${batch.id}`, { quantity: "1000克", expiry_date: batch.expiry_date, expected_batch: { batch_id: batch.id, quantity: batch.quantity, updated_at: batch.updated_at } })
  await req("PUT", "/records/" + id, { portion_scale: 2 })
  items = await shopping()
  check("再次改份量仍保留入库标记", items.find(i => i.name === numericItem)?.stocked && items.find(i => i.name === numericItem)?.amount === "400克", items)
  const consumption = await get("/fridge/consumption?dish_id=" + dish.id + "&portion_scale=2")
  const slot = consumption.slots.find(s => s.requested_name === numericItem)
  check("扣库存建议按保存份量计算", slot?.amount === "400克" && slot.batches.find(b => b.batch_id === batch?.id)?.remaining_hint === "600克", slot)

  r = await req("PUT", "/records/" + id, { status: "cancelled" })
  check("计划可以取消", r.code === 0 && r.data.status === "cancelled", r)
  check("取消移除关联买菜项目", !(await shopping()).some(i => [numericItem, textItem, bareItem].includes(i.name)))
  check("取消不删除已购买的实际库存", (await get("/fridge")).some(b => b.id === batch?.id))
  r = await req("PUT", "/records/" + id, { status: "planned" })
  check("恢复保留份量并重新生成清单", r.code === 0 && r.data.portion_scale === 2 && (await shopping()).find(i => i.name === numericItem)?.amount === "400克", r)

  r = await remember({ ...payload, status: "completed" })
  check("做完原计划沿用同一记录和份量", r.code === 0 && r.data.id === id && r.data.status === "completed" && r.data.portion_scale === 2, r)
  check("完成后统计恰好增加一次", (await get("/stats")).total_records === beforeStats.total_records + 1)
  check("完成后按日期和餐次统计，同餐多菜不重复计顿", (await get("/report?range=week")).total_meals === expectedMealsAfterCompletion)
  r = await remember({ ...payload, status: "completed" })
  check("重复完成不会创建第二条记录", r.httpStatus === 400 && (await get("/stats")).total_records === beforeStats.total_records + 1, r)
  r = await req("PUT", "/records/" + id, { status: "completed" })
  check("重复确认同一记录不会重复计数", r.code === 0 && (await get("/dishes/" + dish.id + "/records")).stats.total_count === 1)
  check("已完成记录不能当作计划取消", (await req("PUT", "/records/" + id, { status: "cancelled" })).httpStatus === 400)
  check("已完成记录可以评价", (await req("PUT", "/records/" + id, { rating: 5, mood: "yum" })).code === 0)

  const future = await remember({ ...payload, meal_date: day(1), status: "planned", portion_scale: 0.5 })
  check("明日计划支持半份", future.code === 0 && future.data.portion_scale === 0.5)
  check("未来计划不能提前完成", (await req("PUT", "/records/" + future.data.id, { status: "completed" })).httpStatus === 400)
  check("新增未来已吃记录也被拦截", (await remember({ ...payload, meal_type: "dinner", meal_date: day(1), status: "completed" })).httpStatus === 400)
  const past = await remember({ ...payload, meal_date: day(-1), status: "planned" })
  check("过了日期仍然是计划", past.code === 0 && past.data.status === "planned" && (await get("/stats")).total_records === beforeStats.total_records + 1)
  check("计划不能先填写吃后评价", (await req("PUT", "/records/" + past.data.id, { rating: 5 })).httpStatus === 400)
  for (const scale of [0, -1, 9]) {
    check("拒绝无效份量 " + scale, (await req("PUT", "/records/" + id, { portion_scale: scale })).httpStatus === 400)
  }
  check("拒绝无效状态", (await req("PUT", "/records/" + id, { status: "unknown" })).httpStatus === 400)
  check("状态筛选返回计划", (await get("/records?status=planned&pageSize=100")).items.every(r => r.status === "planned"))
} finally {
  for (const id of records) await req("DELETE", "/records/" + id)
  for (const id of batches) await req("DELETE", "/fridge/batch/" + id)
  for (const id of dishes) await req("DELETE", "/dishes/" + id, undefined, AH)
}
console.log("\n结果: " + passed + " 通过, " + failed + " 失败")
process.exitCode = failed ? 1 : 0
