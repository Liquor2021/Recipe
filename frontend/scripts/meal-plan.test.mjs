import test from 'node:test'
import assert from 'node:assert/strict'
import { planSelections, planWeekStart, shiftPlanDate, validPlanDate } from '../src/lib/mealPlan.ts'

test('周导航在周日和跨年仍定位正确的一周', () => {
  assert.equal(planWeekStart('2026-11-08'), '2026-11-02')
  assert.equal(planWeekStart('2027-01-03'), '2026-12-28')
  assert.equal(shiftPlanDate('2026-12-28', 7), '2027-01-04')
  assert.equal(validPlanDate('2026-02-30'), null)
  assert.equal(validPlanDate('2028-02-29'), '2028-02-29')
})

test('计划序列化保留已吃菜与钉住标记，不携带评分和库存字段', () => {
  assert.deepEqual(planSelections([
    { dish_id: 3, meal_type: 'lunch', status: 'completed', rating: 5, inventory_applied: true },
    { dish_id: 7, meal_type: 'dinner', status: 'planned', plan_pinned: true },
  ]), [
    { dish_id: 3, meal_type: 'lunch', pinned: false },
    { dish_id: 7, meal_type: 'dinner', pinned: true },
  ])
})
