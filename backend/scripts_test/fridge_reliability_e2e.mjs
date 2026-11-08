// 库存编辑冲突、过期清理和旧客户端保护；只对专用临时库运行。
// TEST_API_BASE=http://localhost:8080/api node backend/scripts_test/fridge_reliability_e2e.mjs
import assert from "node:assert/strict"

const BASE = process.env.TEST_API_BASE || "http://localhost:8080/api"
const headers = { "X-App-Token": process.env.TEST_APP_PASSWORD || "123456", "Content-Type": "application/json" }
const stamp = Date.now()
const owned = new Set()
let passed = 0
const date = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
async function request(method, path, body) {
  const response = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, ...await response.json() }
}
async function must(method, path, body) {
  const response = await request(method, path, body)
  assert.equal(response.code, 0, `${method} ${path}: ${JSON.stringify(response)}`)
  return response.data
}
function check(label, condition) { assert.ok(condition, label); passed++; console.log("  ✓ " + label) }
const snapshot = b => ({ batch_id: b.id, quantity: b.quantity, updated_at: b.updated_at })
const getBatch = async id => (await must("GET", "/fridge")).find(b => b.id === id)
async function add(label, expiry = date(5)) {
  const name = `E2E库存保护-${stamp}-${label}`
  await must("POST", "/fridge", { item_name: name, quantity: "500克", expiry_date: expiry })
  const batch = (await must("GET", "/fridge")).find(b => b.item_name === name)
  assert.ok(batch, "测试批次应成功创建")
  owned.add(batch.id)
  return batch
}
const edit = (b, values) => request("PUT", `/fridge/batch/${b.id}`, {
  quantity: b.quantity, expiry_date: b.expiry_date, ...values, expected_batch: snapshot(b),
})

try {
  const initial = await add("编辑")
  await must("POST", "/fridge/consume", { remaining: [{ batch_id: initial.id, quantity: "300克" }], expected_batches: [snapshot(initial)] })
  let result = await edit(initial, { expiry_date: date(10) })
  check("旧弹窗只改保质期也不能把500克写回", result.status === 409 && (await getBatch(initial.id)).quantity === "300克")
  result = await request("PUT", `/fridge/batch/${initial.id}`, { quantity: "500克", expiry_date: date(10) })
  check("旧客户端缺少库存版本时拒绝写入", result.status === 409)
  let current = await getBatch(initial.id)
  result = await edit(current, { expiry_date: date(10) })
  check("核对最新库存后可以保存日期且保留300克", result.code === 0 && (await getBatch(initial.id)).quantity === "300克")
  current = await getBatch(initial.id)
  const competing = await Promise.all([edit(current, { quantity: "200克" }), edit(current, { quantity: "100克" })])
  check("同一版本并发编辑仅一个成功", competing.filter(r => r.code === 0).length === 1 && competing.filter(r => r.status === 409).length === 1)
  const survivor = await getBatch(initial.id)
  await must("DELETE", `/fridge/batch/${initial.id}`)
  result = await edit(survivor, { quantity: "500克" })
  check("编辑已删除的批次不会复活库存", result.status === 409 && !(await getBatch(initial.id)))

  const corrected = await add("已修正日期", date(-1))
  const expired = await add("仍过期", date(-2))
  const outside = await add("范围外", date(-3))
  const today = await add("今天到期", date())
  const removed = await add("已移出", date(-1))
  assert.equal((await edit(corrected, { expiry_date: date(7) })).code, 0)
  await must("DELETE", `/fridge/batch/${removed.id}`)
  const selected = [corrected.id, expired.id, today.id, removed.id]
  let cleared = await must("POST", "/fridge/clear-expired", { batch_ids: selected })
  check("清过期重新核验日期，只清理仍过期的一批", cleared.removed === 1 && cleared.skipped === 3)
  check("刚修正、今天到期及未选中的批次均保留", !!(await getBatch(corrected.id)) && !!(await getBatch(today.id)) && !!(await getBatch(outside.id)) && !(await getBatch(expired.id)))
  cleared = await must("POST", "/fridge/clear-expired", { batch_ids: selected })
  check("重复清理只报告跳过，不误删其他库存", cleared.removed === 0 && cleared.skipped === 4)
  for (const ids of [[], [today.id, today.id], [0], Array.from({ length: 101 }, (_, i) => i + 1)]) {
    result = await request("POST", "/fridge/clear-expired", { batch_ids: ids })
    check("拒绝无效清理批次 " + (ids.length === 2 ? "重复ID" : ids.length), result.status === 400)
  }

  const first = await add("批量回滚A"), second = await add("批量回滚B")
  assert.equal((await edit(second, { quantity: "250克" })).code, 0)
  result = await request("POST", "/fridge/consume", {
    batch_ids: [first.id], remaining: [{ batch_id: second.id, quantity: "100克" }],
    expected_batches: [snapshot(first), snapshot(second)],
  })
  check("批量操作任一版本冲突全部回滚", result.status === 409 && !!(await getBatch(first.id)) && (await getBatch(second.id)).quantity === "250克")
  result = await request("POST", "/fridge/consume", { batch_ids: [first.id] })
  check("旧批量接口也不能无版本删除库存", result.status === 409 && !!(await getBatch(first.id)))
  result = await request("POST", "/fridge/consume", { batch_ids: [first.id], expected_batches: [snapshot(await getBatch(first.id))] })
  check("合法版本的批量操作仍能正常完成", result.code === 0 && result.data.removed === 1 && !(await getBatch(first.id)))
  console.log(`\n结果: ${passed} 通过, 0 失败`)
} finally {
  for (const id of owned) {
    const response = await request("DELETE", `/fridge/batch/${id}`)
    if (response.code !== 0 && response.status !== 404) throw new Error("清理测试批次失败: " + JSON.stringify(response))
  }
}
