import test from 'node:test'
import assert from 'node:assert/strict'
import { planDateShortcuts } from '../src/lib/planDate.ts'

test('周日的下周一是明天，快捷选择仍保留各自标签', () => {
  assert.deepEqual(planDateShortcuts(new Date(2026, 10, 8, 23)), [
    { label: '明天', date: '2026-11-09' },
    { label: '后天', date: '2026-11-10' },
    { label: '下周一', date: '2026-11-09' },
  ])
})
test('周一选下周一需前进七天，跨年快捷日期有效', () => {
  assert.equal(planDateShortcuts(new Date(2026, 10, 9))[2].date, '2026-11-16')
  assert.equal(planDateShortcuts(new Date(2026, 11, 31))[0].date, '2027-01-01')
  assert.equal(planDateShortcuts(new Date(2026, 11, 31))[1].date, '2027-01-02')
})
