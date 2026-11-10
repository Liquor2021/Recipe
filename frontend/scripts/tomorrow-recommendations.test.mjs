import assert from "node:assert/strict"
import test from "node:test"
import { createTomorrowRecommendations, InsufficientTomorrowDishesError } from "../src/lib/tomorrowRecommendations.ts"

const dishes = (...ids) => ids.map(id => ({ id }))
const ids = items => items.map(dish => dish.id)

test("单道替换后换一批、再重新生成，同时排除当前两餐并传递最近换掉的菜", async () => {
  const requests = []
  const responses = [dishes(5), dishes(6, 7), dishes(8, 9), dishes(10, 11)]
  const picks = createTomorrowRecommendations(async data => {
    requests.push(data)
    return { dishes: responses.shift() }
  })
  const original = dishes(1, 2, 3, 4)
  const swapped = await picks.pick({ meal: "lunch", count: 1, profile: "balanced", current: original })
  picks.remember(original)
  const afterSwap = [...swapped, ...dishes(2, 3, 4)]
  const batch = await picks.pick({ meal: "lunch", count: 2, profile: "balanced", current: afterSwap })
  picks.remember(afterSwap)
  const afterBatch = [...batch, ...dishes(3, 4)]
  const lunch = await picks.pick({ meal: "lunch", count: 2, profile: "quick", current: afterBatch })
  const dinner = await picks.pick({ meal: "dinner", count: 2, profile: "quick", current: [...afterBatch, ...lunch] })
  assert.deepEqual(ids([...lunch, ...dinner]), [8, 9, 10, 11])
  assert.deepEqual(requests.map(r => r.exclude_ids), [[1, 2, 3, 4], [5, 2, 3, 4], [6, 7, 3, 4], [6, 7, 3, 4, 8, 9]])
  assert.deepEqual(requests.map(r => r.avoid_ids), [[], [1], [1, 5, 2], [1, 5, 2]])
  assert.equal(requests[3].meal_type, "dinner")
  assert.equal(requests[3].profile, "quick")
})

test("换一批不足时拒绝半份结果；补菜可返回部分，旧服务返回的当前菜和重复项也会被过滤", async () => {
  const picks = createTomorrowRecommendations(async () => ({ dishes: dishes(1, 2, 5, 5) }))
  const input = { meal: "lunch", count: 2, profile: "balanced", current: dishes(1, 2) }
  await assert.rejects(picks.pick(input), InsufficientTomorrowDishesError)
  assert.deepEqual(ids(await picks.pick({ ...input, allowPartial: true })), [5])
})

test("无候选和请求故障区分处理；零道菜不发请求", async () => {
  let calls = 0
  const picks = createTomorrowRecommendations(async () => {
    calls++
    throw { response: { status: 404 } }
  })
  const input = { meal: "dinner", count: 1, profile: "favorite", current: [] }
  await assert.rejects(picks.pick(input), InsufficientTomorrowDishesError)
  assert.deepEqual(await picks.pick({ ...input, allowPartial: true }), [])
  assert.deepEqual(await picks.pick({ ...input, count: 0 }), [])
  assert.equal(calls, 2)
  const failure = new Error("network")
  const broken = createTomorrowRecommendations(async () => { throw failure })
  await assert.rejects(broken.pick(input), error => error === failure)
})

test("历史有界且只在采纳时记入，新日期编辑器不继承历史", async () => {
  const requests = []
  const request = async data => { requests.push(data); return { dishes: dishes(100) } }
  const picks = createTomorrowRecommendations(request)
  picks.remember(dishes(...Array.from({ length: 45 }, (_, i) => i + 1)))
  picks.remember(dishes(6, 6))
  const input = { meal: "lunch", count: 1, profile: "balanced", current: dishes(45) }
  await picks.pick(input)
  await picks.pick(input)
  assert.equal(requests[0].avoid_ids.length, 39)
  assert.equal(requests[0].avoid_ids.includes(1), false)
  assert.equal(requests[0].avoid_ids.at(-1), 6)
  assert.deepEqual(requests[0], requests[1])
  await createTomorrowRecommendations(request).pick(input)
  assert.deepEqual(requests[2].avoid_ids, [])
})
