import assert from "node:assert/strict"
import test from "node:test"
import { QueryClient } from "@tanstack/react-query"
import { hasPendingMealSelection, mealSelectionKey, mealSelectionMutationKey, mergeMealSelectionRecord, reconcileMealSelection, waitForMealSelectionRefresh } from "../src/lib/mealSelection.ts"

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const selection = { dish_id: 7, meal_date: "2026-11-07", meal_type: "lunch" }
const row = (id, status = "planned") => ({ id, dish_id: id, dish_name: `菜${id}`, meal_date: selection.meal_date, meal_type: "lunch", status })
const page = items => ({ items, total: items.length, page: 1, page_size: 100 })

test("同一事件连续点击只取得一次锁；午晚餐、日期和菜品各自独立", () => {
  const client = new QueryClient()
  const locks = new Set()
  const start = item => { const key = mealSelectionKey(item); if (locks.has(key) || hasPendingMealSelection(client, item)) return false; locks.add(key); return true }
  assert.equal(start(selection), true)
  assert.equal(start(selection), false)
  assert.equal(start({ ...selection, meal_type: "dinner" }), true)
  assert.equal(start({ ...selection, dish_id: 8 }), true)
  assert.equal(start({ ...selection, meal_date: "2026-11-08" }), true)
  locks.delete(mealSelectionKey(selection))
  assert.equal(start(selection), true)
  client.clear()
})

test("页面卸载重挂仍挡住未完成写入，并保持到权威读取完成", async () => {
  const client = new QueryClient()
  const write = deferred()
  const refresh = deferred()
  const mutation = client.getMutationCache().build(client, {
    mutationKey: mealSelectionMutationKey,
    mutationFn: () => write.promise,
    onSettled: () => refresh.promise,
  })
  const done = mutation.execute(selection)
  // 新页面得到全新的 ref，但共享 MutationCache 仍能识别原操作。
  assert.equal(hasPendingMealSelection(client, selection), true)
  assert.equal(hasPendingMealSelection(client, { ...selection, meal_type: "dinner" }), false)
  write.resolve(row(selection.dish_id))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(mutation.state.status, "pending")
  assert.equal(hasPendingMealSelection(client, selection), true)
  refresh.resolve()
  await done
  assert.equal(hasPendingMealSelection(client, selection), false)
  client.clear()
})

test("页面已卸载的缓存也重新读取，超时写入不能直接解锁旧状态", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queryKey = ["records", "today", selection.meal_date]
  let current = page([row(1)])
  await client.fetchQuery({ queryKey, queryFn: () => current })
  const query = client.getQueryCache().find({ queryKey, exact: true })
  assert.equal(query.getObserversCount(), 0)
  const refresh = deferred()
  query.setOptions({ ...query.options, queryFn: () => refresh.promise })
  const mutation = client.getMutationCache().build(client, {
    mutationKey: mealSelectionMutationKey,
    mutationFn: () => Promise.reject(new Error("response timed out")),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey, exact: true, refetchType: "all" })
      await waitForMealSelectionRefresh(client, queryKey)
    },
  })
  const done = mutation.execute(selection).catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hasPendingMealSelection(client, selection), true)
  assert.equal(client.getQueryState(queryKey).fetchStatus, "fetching")
  current = page([row(1, "cancelled")])
  refresh.resolve(current)
  await done
  assert.equal(hasPendingMealSelection(client, selection), false)
  assert.equal(client.getQueryData(queryKey).items[0].status, "cancelled")
  client.clear()
})

test("只合并服务端确认的行，保留其它菜的成功新增、取消和展示字段", () => {
  const original = page([{ ...row(1), dish_image_url: "one.webp" }, row(2)])
  let current = mergeMealSelectionRecord(original, row(3))
  current = mergeMealSelectionRecord(current, row(2, "cancelled"))
  current = mergeMealSelectionRecord(current, { ...row(1), portion_scale: 2 })
  assert.equal(current.total, 3)
  assert.equal(current.items.find(item => item.id === 1).dish_image_url, "one.webp")
  assert.equal(current.items.find(item => item.id === 1).portion_scale, 2)
  assert.equal(current.items.find(item => item.id === 2).status, "cancelled")
  assert.equal(current.items.find(item => item.id === 3).status, "planned")
  assert.equal(original.items.length, 2)
  assert.equal(original.items[1].status, "planned")
  assert.equal(mergeMealSelectionRecord(undefined, row(1)), undefined)
})

test("取消失败不会回滚其它菜的成功操作，失败请求也等待状态重新读取", async () => {
  const client = new QueryClient()
  const queryKey = ["records", "today", selection.meal_date]
  client.setQueryData(queryKey, page([row(1), row(2)]))
  const failedWrite = deferred()
  const refresh = deferred()
  const mutation = client.getMutationCache().build(client, {
    mutationKey: mealSelectionMutationKey,
    mutationFn: () => failedWrite.promise,
    onSettled: () => refresh.promise,
  })
  const done = mutation.execute(selection).catch(error => error)
  // 别道菜先成功；失败取消没有乐观删除，也没有旧快照可覆盖这次成功。
  client.setQueryData(queryKey, current => mergeMealSelectionRecord(current, row(2, "cancelled")))
  failedWrite.reject(new Error("cancel failed"))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hasPendingMealSelection(client, selection), true)
  assert.equal(client.getQueryData(queryKey).items.find(item => item.id === 1).status, "planned")
  assert.equal(client.getQueryData(queryKey).items.find(item => item.id === 2).status, "cancelled")
  refresh.resolve()
  assert.equal((await done).message, "cancel failed")
  assert.equal(hasPendingMealSelection(client, selection), false)
  client.clear()
})

test("并发操作替换正在进行的刷新时，等待新刷新后才允许解锁", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queryKey = ["records", "today", selection.meal_date]
  client.setQueryData(queryKey, page([row(1)]))
  const first = deferred()
  const second = deferred()
  const firstRead = client.fetchQuery({ queryKey, queryFn: () => first.promise }).catch(() => undefined)
  let settled = false
  const waiting = waitForMealSelectionRefresh(client, queryKey).then(() => { settled = true })
  // 与另一 mutation 的 invalidate 行为一致：同步取消旧查询、立刻开始新查询。
  const cancelling = client.cancelQueries({ queryKey, exact: true })
  const secondRead = client.fetchQuery({ queryKey, queryFn: () => second.promise })
  await cancelling
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  second.resolve(page([row(1), row(2)]))
  await secondRead
  await waiting
  assert.equal(settled, true)
  assert.equal(client.getQueryData(queryKey).items.length, 2)
  first.resolve(page([row(1)]))
  await firstRead
  assert.equal(client.getQueryData(queryKey).items.length, 2)
  client.clear()
})

test("三个真实 mutation 经异步 onSuccess/onSettled 替换刷新时，首个操作仍等最终读取", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queryKey = ["records", "today", selection.meal_date]
  await client.fetchQuery({ queryKey, queryFn: () => page([row(1)]) })
  const reads = []
  const query = client.getQueryCache().find({ queryKey, exact: true })
  query.setOptions({ ...query.options, queryFn: () => {
    const read = deferred()
    reads.push(read)
    return read.promise
  } })
  const requests = [
    { ...selection, dish_id: 1, result: row(1, "cancelled") },
    { ...selection, dish_id: 1, meal_type: "dinner", result: { ...row(2), dish_id: 1, meal_type: "dinner" } },
    { ...selection, dish_id: 3, result: row(3) },
  ]
  const writes = requests.map(() => deferred())
  const mutations = writes.map(write => client.getMutationCache().build(client, {
    mutationKey: mealSelectionMutationKey,
    mutationFn: () => write.promise,
    // Real Mutation.execute awaits onSuccess before invoking onSettled. The
    // cancel/merge/refetch transition must never straddle this await boundary.
    onSuccess: async () => { await Promise.resolve() },
    onSettled: (saved, _error, request) => reconcileMealSelection(client, request.meal_date, saved),
  }))
  const done = mutations.map((mutation, index) => mutation.execute(requests[index]))
  writes[0].resolve(requests[0].result)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads.length, 1)
  assert.equal(hasPendingMealSelection(client, requests[0]), true)

  writes[1].resolve(requests[1].result)
  writes[2].resolve(requests[2].result)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads.length, 3)
  reads[0].resolve(page([requests[0].result]))
  reads[1].resolve(page([requests[0].result, requests[1].result]))
  await new Promise(resolve => setImmediate(resolve))
  for (const request of requests) assert.equal(hasPendingMealSelection(client, request), true)
  assert.equal(client.getQueryState(queryKey).fetchStatus, "fetching")

  reads[2].resolve(page(requests.map(request => request.result)))
  await Promise.all(done)
  for (const request of requests) assert.equal(hasPendingMealSelection(client, request), false)
  assert.deepEqual(client.getQueryData(queryKey).items.map(item => [item.id, item.status]), [[1, "cancelled"], [2, "planned"], [3, "planned"]])
  client.clear()
})

test("刷新失败会结束等待并保留错误状态，由页面要求显式重读", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queryKey = ["records", "today", selection.meal_date]
  client.setQueryData(queryKey, page([row(1)]))
  const read = deferred()
  const fetching = client.fetchQuery({ queryKey, queryFn: () => read.promise }).catch(() => undefined)
  const waiting = waitForMealSelectionRefresh(client, queryKey)
  read.reject(new Error("offline"))
  await fetching
  await waiting
  assert.equal(client.getQueryState(queryKey).status, "error")
  assert.equal(client.getQueryData(queryKey).items.length, 1)
  client.clear()
})
