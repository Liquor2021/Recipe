import assert from "node:assert/strict"
import test from "node:test"
import { wheelLabelRotation } from "../src/lib/wheelLabel.ts"

test("label flipping includes the wheel's current rotation", () => {
  assert.equal(wheelLabelRotation(-67.5, 0), 0)
  assert.equal(wheelLabelRotation(-67.5, 225), 180)
  assert.equal(wheelLabelRotation(157.5, 0), 180)
  assert.equal(wheelLabelRotation(157.5, 180), 0)
})

test("every label stays upright through full spins with one to eight dishes", () => {
  for (let count = 1; count <= 8; count++) {
    for (let index = 0; index < count; index++) {
      const sectorAngle = (index + 0.5) * 360 / count - 90
      for (let rotation = -720; rotation <= 2160; rotation += 2.5) {
        const screenAngle = sectorAngle + rotation + wheelLabelRotation(sectorAngle, rotation)
        assert.ok(Math.cos(screenAngle * Math.PI / 180) >= -1e-10,
          `upside-down label: count=${count}, index=${index}, rotation=${rotation}`)
      }
    }
  }
})

test("cumulative turns and batch resets preserve the correct orientation", () => {
  for (const sectorAngle of [-90, -67.5, 90, 157.5, 247.5, 270]) {
    for (const rotation of [0, 22.5, 67.5, 180, 292.5, 337.5]) {
      const expected = wheelLabelRotation(sectorAngle, rotation)
      assert.equal(wheelLabelRotation(sectorAngle, rotation + 360 * 25), expected)
      assert.equal(wheelLabelRotation(sectorAngle, rotation - 360 * 25), expected)
    }
  }
  assert.equal(wheelLabelRotation(157.5, 0), 180)
  assert.equal(wheelLabelRotation(90, 0), 0)
  assert.equal(wheelLabelRotation(270, 0), 0)
})
