// 批次模型 E2E
const H = { "X-App-Token": "nini123", "Content-Type": "application/json" }
const B = "http://localhost:8080/api"
let ok = 0, bad = 0
const check = (n, c, d = "") => { if (c) { ok++; console.log("  ✓ " + n) } else { bad++; console.log("  ✗ " + n + " " + d) } }
;(async () => {
  const before = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  const snap = (before.data || []).map(i => ({ item_name: i.item_name, quantity: i.quantity, expiry_date: i.expiry_date }))
  for (const it of snap) await fetch(B + "/fridge/" + encodeURIComponent(it.item_name), { method: "DELETE", headers: H })

  let r = await fetch(B + "/fridge", { method: "POST", headers: H, body: JSON.stringify({ item_name: "番茄", quantity: "2个", expiry_date: "2026-10-29" }) }).then(r => r.json())
  check("新批次(明天到期,2个)", r.code === 0)
  r = await fetch(B + "/fridge", { method: "POST", headers: H, body: JSON.stringify({ item_name: "番茄", quantity: "1袋", expiry_date: "2026-11-27" }) }).then(r => r.json())
  check("同食材追加新批(30天)", r.code === 0)
  r = await fetch(B + "/fridge", { method: "POST", headers: H, body: JSON.stringify({ item_name: "鸡蛋" }) }).then(r => r.json())
  check("加鸡蛋(自动默认保质期)", r.code === 0)

  r = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  const batches = (r.data || []).filter(i => i.item_name === "番茄")
  check("番茄有 2 批", batches.length === 2, JSON.stringify(batches.map(b => [b.quantity, b.expiry_date])))
  check("旧批排前(临期在前)", batches[0].expiry_date === "2026-10-29", JSON.stringify(batches.map(b => b.expiry_date)))
  check("数量字段存储", batches.some(b => b.quantity === "2个") && batches.some(b => b.quantity === "1袋"), JSON.stringify(batches.map(b => b.quantity)))

  r = await fetch(B + "/fridge/recipes?limit=50", { headers: H }).then(r => r.json())
  const m = (r.data || []).find(x => x.dish.name === "番茄炒蛋")
  check("番茄炒蛋 100%(番茄+鸡蛋都在)", m && m.coverage === 100, JSON.stringify(m?.coverage))
  check("using_urgent 含番茄(早批临期)", m && (m.using_urgent || []).includes("番茄"), JSON.stringify(m?.using_urgent))
  const earlyBatchID = batches[0].id
  check("matched_batch_ids 指向早批", m && (m.matched_batch_ids || []).includes(earlyBatchID), `want ${earlyBatchID}: ${JSON.stringify(m?.matched_batch_ids)}`)

  r = await fetch(B + `/fridge/batch/${earlyBatchID}`, { method: "DELETE", headers: H }).then(r => r.json())
  check("按批次移除早批", r.code === 0, JSON.stringify(r))
  r = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  const left = (r.data || []).filter(i => i.item_name === "番茄")
  check("剩新批(1袋,30天)", left.length === 1 && left[0].quantity === "1袋", JSON.stringify(left))
  r = await fetch(B + "/fridge/urgent", { headers: H }).then(r => r.json())
  check("移除后无临期番茄", !(r.data || []).some(i => i.item_name === "番茄"), JSON.stringify(r.data))

  const newID = left[0].id
  r = await fetch(B + `/fridge/batch/${newID}`, { method: "PUT", headers: H, body: JSON.stringify({ quantity: "5个", expiry_date: "2026-12-01" }) }).then(r => r.json())
  check("批次编辑成功", r.code === 0, JSON.stringify(r))
  r = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  const edited = (r.data || []).find(i => i.id === newID)
  check("编辑生效", edited && edited.quantity === "5个" && edited.expiry_date === "2026-12-01", JSON.stringify(edited))

  const afterAll = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  const seenNames = new Set()
  for (const it of afterAll.data || []) {
    if (seenNames.has(it.item_name)) continue
    seenNames.add(it.item_name)
    await fetch(B + "/fridge/" + encodeURIComponent(it.item_name), { method: "DELETE", headers: H })
  }
  for (const it of snap) await fetch(B + "/fridge", { method: "POST", headers: H, body: JSON.stringify(it) })
  const fin = await fetch(B + "/fridge", { headers: H }).then(r => r.json())
  check("恢复原库存", (fin.data || []).length === snap.length, `${(fin.data || []).length} vs ${snap.length}`)

  console.log(`
结果: ${ok} 通过, ${bad} 失败`)
  process.exit(bad > 0 ? 1 : 0)
})().catch(e => { console.error("异常:", e); process.exit(1) })
