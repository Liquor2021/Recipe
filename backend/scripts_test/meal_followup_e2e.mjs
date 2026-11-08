// 计划恢复/改期、待完成分页与库存扣减日志回归；必须对专用临时数据库运行。
// node backend/scripts_test/meal_followup_e2e.mjs
const BASE = process.env.TEST_API_BASE || "http://localhost:8080/api"
const H = { "X-App-Token": process.env.TEST_APP_PASSWORD || "123456", "Content-Type": "application/json" }
let passed = 0, failed = 0
const records = new Set(), dishes = [], batchIDs = new Set(), undoOrder = []
const stamp = Date.now()
const itemName = "E2E跟进主料" + stamp
const secondItemName = "E2E跟进配菜" + stamp
const day = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-")
}
function check(name, condition, detail) {
  if (condition) { passed++; console.log("  ✓ " + name) }
  else { failed++; console.error("  ✗ " + name, detail ?? "") }
}
async function req(method, path, body, headers = H) {
  const response = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { httpStatus: response.status, ...await response.json() }
}
async function must(method, path, body, headers) {
  const response = await req(method, path, body, headers)
  if (response.code !== 0) throw new Error(`${method} ${path}: ${JSON.stringify(response)}`)
  return response.data
}
const get = path => must("GET", path)
const shopping = async () => (await get("/shopping-list")).flatMap(c => c.items)
const shoppingItem = async name => (await shopping()).find(item => item.name === name)
const batch = async id => (await get("/fridge")).find(item => item.id === id)
const version = item => ({ batch_id: item.id, quantity: item.quantity, updated_at: item.updated_at })
async function remember(body) {
  const record = await must("POST", "/records", body)
  records.add(record.id)
  return record
}
async function consume(id, body) {
  const response = await req("POST", `/records/${id}/consumption`, body)
  if (response.code === 0) undoOrder.push(id)
  return response
}
async function history(id) { return get(`/records/${id}/consumption`) }
async function undo(id, entryID) {
  if (entryID === undefined) {
    const log = await history(id)
    entryID = (log.entries.find(entry => entry.status === "applied") || log.entries[0])?.id
  }
  if (entryID === undefined) return { code: 0, data: { applied: false } }
  return req("POST", `/records/${id}/consumption/undo`, { entry_id: entryID })
}
async function undoMeal(id, entryID) {
  if (entryID === undefined) entryID = (await history(id)).entries.find(entry => entry.status === "applied")?.id ?? null
  return req("POST", `/records/${id}/undo-completion`, { entry_id: entryID })
}

const login = await must("POST", "/admin/login", { password: process.env.TEST_ADMIN_PASSWORD || "123456" })
if (!login?.token) throw new Error("测试服务管理端登录失败")
const AH = { ...H, Authorization: "Bearer " + login.token }
try {
  const dish = await must("POST", "/dishes", {
    name: "E2E计划跟进" + stamp, category: "家常菜", meal_type: "all",
    ingredients: JSON.stringify([{ name: itemName, amount: "200克" }, { name: secondItemName, amount: "2个" }]),
    seasonings: "[]",
  }, AH)
  dishes.push(dish.id)
  const payload = { dish_id: dish.id, dish_name: dish.name, meal_type: "lunch", meal_date: day(), status: "planned" }
  const plan = await remember({ ...payload, portion_scale: 2 })
  const id = plan.id
  await must("POST", "/shopping-list/toggle", { item_name: itemName, meal_date: day(), checked: true, demand_version: (await shoppingItem(itemName))?.demand_version })
  await must("POST", "/shopping-list/toggle", { item_name: secondItemName, meal_date: day(), checked: true, demand_version: (await shoppingItem(secondItemName))?.demand_version })
  await must("POST", "/shopping-list/stock-in", { items: [{ item_name: itemName, quantity: "1000克" }] })
  const originalBatch = (await get("/fridge")).find(item => item.item_name === itemName)
  if (!originalBatch) throw new Error("测试库存创建失败")
  batchIDs.add(originalBatch.id)
  check("入库按已买的400克计算，不信任旧页面提交的总量", originalBatch.quantity === "400克", originalBatch)
  // 消费/撤销链路使用单独核对后的1000克库存；采购快照仍保留已买的400克。
  await must("PUT", `/fridge/batch/${originalBatch.id}`, { quantity: "1000克", expiry_date: originalBatch.expiry_date, expected_batch: version(originalBatch) })
  check("计划买菜状态包含已买、已入库和双倍用量", (await shoppingItem(itemName))?.checked && (await shoppingItem(itemName))?.stocked && (await shoppingItem(itemName))?.amount === "400克")

  const secondItemVersion = (await shoppingItem(secondItemName))?.demand_version
  let response = await req("PUT", `/records/${id}`, { status: "cancelled" })
  check("取消计划隐藏所有关联购物需求", response.code === 0 && !(await shopping()).some(item => [itemName, secondItemName].includes(item.name)), response)
  check("取消计划不改变真实库存", (await batch(originalBatch.id))?.quantity === "1000克")
  response = await req("POST", "/shopping-list/toggle", { item_name: secondItemName, meal_date: day(), checked: false, demand_version: secondItemVersion })
  check("取消后旧页面的勾选请求返回冲突", response.httpStatus === 409, response)
  response = await req("POST", "/shopping-list/stock-in", { items: [{ item_name: secondItemName, quantity: "4个" }] })
  check("取消后到达的入库请求不创建库存", response.code === 0 && response.data.added === 0 && !(await get("/fridge")).some(item => item.item_name === secondItemName), response)
  response = await req("PUT", `/records/${id}`, { status: "planned", portion_scale: 3 })
  let item = await shoppingItem(itemName)
  check("恢复沿用原记录且新增200克仍需购买", response.code === 0 && response.data.id === id && !item?.checked && !item?.stocked && item?.pending_amount === "200克" && item?.stock_in_amount === "" && item?.needs_buy, { response, item })
  check("恢复时按原量快照更新份量", item?.amount === "600克", item)
  item = await shoppingItem(secondItemName)
  check("取消期间勾选不污染旧采购，新增2个待买", !item?.checked && !item?.stocked && item?.amount === "6个" && item?.pending_amount === "2个" && item?.stock_in_amount === "4个", item)
  response = await req("POST", "/shopping-list/stock-in", { items: [{ item_name: itemName, quantity: "1000克" }] })
  check("恢复后重复入库不会再生成同一批采购", response.code === 0 && response.data.added === 0 && (await get("/fridge")).filter(item => item.item_name === itemName).length === 1, response)

  const target = await remember({ ...payload, meal_date: day(7), meal_type: "dinner" })
  response = await req("PUT", `/records/${id}`, { meal_date: target.meal_date, meal_type: target.meal_type })
  const afterConflict = await get(`/records/${id}`)
  check("改到同菜同日同餐会被拒绝", response.httpStatus === 400, response)
  check("改期冲突不改变原计划或采购差额", afterConflict.meal_date === day() && afterConflict.meal_type === "lunch" && afterConflict.portion_scale === 3 && (await shoppingItem(itemName))?.pending_amount === "200克" && (await shoppingItem(itemName))?.stock_in_amount === "")
  response = await req("PUT", `/records/${id}`, { meal_date: day(1), meal_type: "dinner" })
  item = await shoppingItem(itemName)
  check("移到明天并改餐次仍保留记录和份量", response.code === 0 && response.data.id === id && response.data.meal_date === day(1) && response.data.meal_type === "dinner" && response.data.portion_scale === 3, response)
  check("改期保留已购部分和新增差额", item?.amount === "600克" && item?.pending_amount === "200克" && item?.stock_in_amount === "", item)
  response = await req("PUT", `/records/${id}`, { meal_date: day(40) })
  check("移到更远日期后从今日明日清单中移出", response.code === 0 && !(await shopping()).some(item => item.name === itemName), response)
  response = await req("PUT", `/records/${id}`, { meal_date: day(), meal_type: "lunch", portion_scale: 2 })
  item = await shoppingItem(itemName)
  check("跨月份移回今天仍保留购物状态和原量", response.code === 0 && item?.checked && item?.stocked && item?.amount === "400克", { response, item })
  check("不允许把计划改到过去", (await req("PUT", `/records/${id}`, { meal_date: day(-1) })).httpStatus === 400)
  check("不接受无效改期日期", (await req("PUT", `/records/${id}`, { meal_date: "2026-02-30" })).httpStatus === 400)
  check("不接受无效餐次", (await req("PUT", `/records/${id}`, { meal_type: "breakfast" })).httpStatus === 400)

  const spread = []
  for (const offset of [-62, -32, -1, 32, 62]) spread.push(await remember({ ...payload, meal_date: day(offset) }))
  const plannedRows = []
  let expectedTotal = 0
  for (let page = 1; page <= 100; page++) {
    const result = await get(`/records?status=planned&pageSize=2&page=${page}`)
    expectedTotal = result.total
    plannedRows.push(...result.items)
    if (plannedRows.length >= expectedTotal || result.items.length === 0) break
  }
  check("待完成接口跨月份分页返回全部记录", plannedRows.length === expectedTotal && spread.every(record => plannedRows.some(row => row.id === record.id)), { expectedTotal, actual: plannedRows.length })
  check("待完成分页不重复、不混入已完成或取消", new Set(plannedRows.map(row => row.id)).size === plannedRows.length && plannedRows.every(row => row.status === "planned"))
  check("过去的未完成计划仍能在筛选中找到", spread.filter(record => record.meal_date < day()).every(record => plannedRows.some(row => row.id === record.id)))

  const statsBefore = await get("/stats")
  response = await req("PUT", `/records/${id}`, { status: "completed", rating: 5, mood: "yum", photo: "/uploads/e2e-followup.jpg", remark: "保留这条备注" })
  check("完成计划进入待扣库存状态", response.code === 0 && response.data.status === "completed" && response.data.inventory_applied === false, response)
  check("只有完成才增加一次用餐统计", (await get("/stats")).total_records === statsBefore.total_records + 1)
  check("已完成记录不能直接改期", (await req("PUT", `/records/${id}`, { meal_date: day(1) })).httpStatus === 400)
  let log = await history(id)
  check("首次扣减前没有日志且未扣库存", !log.applied && log.entries.length === 0, log)
  await must("POST", "/fridge", { item_name: secondItemName, quantity: "4个" })
  const secondBatch = (await get("/fridge")).find(item => item.item_name === secondItemName)
  if (!secondBatch) throw new Error("第二份测试库存创建失败")
  batchIDs.add(secondBatch.id)
  const current = await batch(originalBatch.id)
  const consumedBody = {
    batch_ids: [secondBatch.id],
    remaining: [{ batch_id: originalBatch.id, quantity: "600克" }],
    expected_batches: [version(current), version(secondBatch)],
  }
  check("缺少库存版本的扣减请求会被拒绝", (await consume(id, { batch_ids: [secondBatch.id] })).httpStatus === 400)
  response = await consume(id, consumedBody)
  check("部分扣减与整批移出在同次操作完成", response.code === 0 && response.data.removed === 1 && response.data.updated === 1 && response.data.applied, response)
  check("实际库存按确认后的剩余量保存", (await batch(originalBatch.id))?.quantity === "600克" && !(await batch(secondBatch.id)))
  log = await history(id)
  const firstEntryID = log.entries[0]?.id
  check("扣减日志记住批次的前后数量", log.applied && log.entries.length === 1 && log.entries[0].items.some(item => item.batch_id === originalBatch.id && item.before_quantity === "1000克" && item.after_quantity === "600克") && log.entries[0].items.some(item => item.batch_id === secondBatch.id && item.removed), log)
  check("单条记录返回已扣库存状态", (await get(`/records/${id}`)).inventory_applied === true)
  response = await consume(id, consumedBody)
  check("重复提交不重复扣减或生成日志", response.httpStatus === 400 && (await batch(originalBatch.id))?.quantity === "600克" && (await history(id)).entries.length === 1, response)
  check("仍有有效扣减时不允许删掉用餐记录", (await req("DELETE", `/records/${id}`)).httpStatus === 400)
  check("已扣库存后调整份量需先撤销", (await req("PUT", `/records/${id}`, { portion_scale: 3 })).httpStatus === 400)
  response = await undo(id)
  check("撤销同时恢复部分扣减和整批移除", response.code === 0 && (await batch(originalBatch.id))?.quantity === "1000克" && (await batch(secondBatch.id))?.quantity === "4个", response)
  log = await history(id)
  check("撤销保留历史日志并清除已扣标记", !log.applied && log.entries[0].status === "reverted" && !!log.entries[0].reverted_at && !(await get(`/records/${id}`)).inventory_applied, log)
  response = await undo(id)
  check("重复撤销不会重复补回库存", response.code === 0 && (await get("/fridge")).filter(item => item.id === secondBatch.id).length === 1 && (await batch(originalBatch.id))?.quantity === "1000克")

  const stale = await batch(originalBatch.id)
  await must("PUT", `/fridge/batch/${originalBatch.id}`, { quantity: "900克", expiry_date: stale.expiry_date, expected_batch: version(stale) })
  response = await consume(id, { remaining: [{ batch_id: originalBatch.id, quantity: "600克" }], expected_batches: [version(stale)] })
  check("失效版本不能覆盖其他页面更新的库存", response.httpStatus === 400 && (await batch(originalBatch.id))?.quantity === "900克" && !(await history(id)).applied, response)
  const fresh = await batch(originalBatch.id)
  response = await consume(id, { remaining: [{ batch_id: originalBatch.id, quantity: "500克" }], expected_batches: [version(fresh)] })
  check("刷新库存版本后可再次扣减并新增日志", response.code === 0 && (await history(id)).entries.length === 2, response)
  response = await undo(id, firstEntryID)
  check("旧日志的撤销请求不能撤销新一轮扣减", response.httpStatus === 400 && (await batch(originalBatch.id))?.quantity === "500克" && (await history(id)).applied, response)
  response = await undoMeal(id, firstEntryID)
  check("旧日志确认不能撤销新一轮已吃状态", response.httpStatus === 400 && (await get(`/records/${id}`)).status === "completed" && (await batch(originalBatch.id))?.quantity === "500克", response)
  response = await undoMeal(id, null)
  check("确认时尚未扣库存的旧弹层不能撤销后续扣减", response.httpStatus === 400 && (await history(id)).applied, response)
  const later = await remember({ ...payload, meal_type: "dinner", status: "completed" })
  const beforeLater = await batch(originalBatch.id)
  response = await consume(later.id, { remaining: [{ batch_id: originalBatch.id, quantity: "300克" }], expected_batches: [version(beforeLater)] })
  check("另一顿可以继续使用同一库存批次", response.code === 0 && (await batch(originalBatch.id))?.quantity === "300克", response)
  response = await undo(id)
  check("撤销较早消费不会覆盖较晚的库存变动", response.httpStatus === 400 && (await batch(originalBatch.id))?.quantity === "300克" && (await history(id)).applied, response)
  response = await undoMeal(id)
  check("库存冲突时撤销已吃也保持原状态", response.httpStatus === 400 && (await get(`/records/${id}`)).status === "completed" && (await batch(originalBatch.id))?.quantity === "300克", response)
  response = await undo(later.id)
  check("先撤销后一次消费可恢复其前一份数量", response.code === 0 && (await batch(originalBatch.id))?.quantity === "500克", response)
  response = await undoMeal(id)
  check("撤销已吃原子恢复库存并回到待完成", response.code === 0 && response.data.status === "planned" && !response.data.inventory_applied && (await batch(originalBatch.id))?.quantity === "900克", response)
  check("误记回退清理吃后评价并保留备注和份量", response.data?.rating === 0 && response.data?.mood === "" && response.data?.photo === "" && response.data?.remark === "保留这条备注" && response.data?.portion_scale === 2, response)
  check("撤销已吃只减少对应一次统计", (await get("/stats")).total_records === statsBefore.total_records + 1)
  response = await undoMeal(id)
  check("重复撤销已吃不重复补回库存", response.code === 0 && (await batch(originalBatch.id))?.quantity === "900克", response)
  response = await consume(id, { batch_ids: [secondBatch.id], expected_batches: [version(await batch(secondBatch.id))] })
  check("待完成状态不允许扣库存", response.httpStatus === 400 && !!(await batch(secondBatch.id)), response)
  response = await consume(target.id, { batch_ids: [secondBatch.id], expected_batches: [version(await batch(secondBatch.id))] })
  check("未来计划不允许扣库存", response.httpStatus === 400 && !(await history(target.id)).applied, response)
} finally {
  // 严格按消费的相反顺序撤销，避免一顿的旧快照覆盖另一顿的后续变动。
  for (const id of [...undoOrder].reverse()) {
    const result = await undo(id)
    if (result.code !== 0 && result.httpStatus !== 404) console.error("清理扣减失败", id, result)
  }
  for (const id of records) {
    const result = await req("DELETE", `/records/${id}`)
    if (result.code !== 0 && result.httpStatus !== 404) { failed++; console.error("清理用餐记录失败", id, result) }
  }
  for (const id of batchIDs) await req("DELETE", `/fridge/batch/${id}`)
  for (const id of dishes) await req("DELETE", `/dishes/${id}`, undefined, AH)
}
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exitCode = failed ? 1 : 0
