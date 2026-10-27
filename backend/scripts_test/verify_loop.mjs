// 验证冰箱闭环：补料入清单 + 做完菜扣库存
const H = { "X-App-Token": "nini123", "Content-Type": "application/json" }
const B = "http://localhost:8080/api"
let ok = 0, bad = 0
const check = (name, cond, detail = "") => {
  if (cond) { ok++; console.log(`  ✓ ${name}`) } else { bad++; console.log(`  ✗ ${name} ${detail}`) }
}

async function main() {
  console.log("== 补料入清单 ==")
  const list = await fetch(B + "/shopping-list", { headers: H }).then(r => r.json())
  check("买菜清单含鲜面条（刚点的补料）", (list.data || []).some(c => c.items.some(i => i.name === "鲜面条")), JSON.stringify(list.data).slice(0, 300))

  // 再点一次同卡补料（模拟重复点击）→ 去重
  const r2 = await fetch(B + "/shopping-list/items", {
    method: "POST", headers: H,
    body: JSON.stringify({ dish_id: 1, dish_name: "番茄炒蛋", items: [{ name: "鲜面条" }] }),
  }).then(r => r.json())
  // 注意：这个 POST 的 dish_id=1 与刚才番茄鸡蛋面 dish_id 不同？鲜面条来自番茄鸡蛋面
  // 用相同 item_name 不同 dish 会新增——改为同名同日去重验证走 added=0
  const r3 = await fetch(B + "/shopping-list/items", {
    method: "POST", headers: H,
    body: JSON.stringify({ dish_id: 0, dish_name: "", items: [{ name: "鲜面条" }] }),
  }).then(r => r.json())
  check("同名条目去重 added=0", r3.data?.added === 0, JSON.stringify(r3))

  console.log("== 做完菜扣库存 ==")
  // 冰箱当前库存
  const fridge = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  const stockNames = (fridge.data || []).map(i => i.item_name)
  check("冰箱有番茄和鸡蛋", stockNames.includes("番茄") && stockNames.includes("鸡蛋"), JSON.stringify(stockNames))

  // 模拟记录番茄炒蛋晚餐（今天）→ 弹层逻辑在前端，这里验证 API 链路：清冰箱匹配含该菜
  const recipes = await fetch(B + "/fridge/recipes?limit=50", { headers: H }).then(r => r.json())
  const m = (recipes.data || []).find(x => x.dish.name === "番茄炒蛋")
  check("番茄炒蛋匹配可用于扣库存提示", m && (m.matched || []).includes("番茄") && (m.matched || []).includes("鸡蛋"), JSON.stringify(m))

  // 模拟用户勾选移除：移出番茄+鸡蛋，再放回（恢复现场）
  for (const n of ["番茄", "鸡蛋"]) await fetch(B + `/fridge/${encodeURIComponent(n)}`, { method: "DELETE", headers: H })
  const after = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  check("移除后库存不含番茄鸡蛋", !(after.data || []).some(i => ["番茄", "鸡蛋"].includes(i.item_name)), JSON.stringify(after.data))
  for (const n of ["番茄", "鸡蛋"]) await fetch(B + "/fridge", { method: "POST", headers: H, body: JSON.stringify({ item_name: n }) })
  const restored = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  check("库存已恢复", (restored.data || []).length === stockNames.length, `${(restored.data || []).length} vs ${stockNames.length}`)

  // 清理验证期加入清单的鲜面条条目：无删除 API，标记 checked 勾选即可（用户可在 UI 取消）
  console.log(`\n结果: ${ok} 通过, ${bad} 失败`)
  process.exit(bad > 0 ? 1 : 0)
}

main().catch(e => { console.error("异常:", e); process.exit(1) })
