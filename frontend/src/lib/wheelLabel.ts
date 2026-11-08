export function wheelLabelRotation(sectorAngle: number, wheelRotation: number): 0 | 180 {
  const screenAngle = ((sectorAngle + wheelRotation) % 360 + 360) % 360
  return screenAngle > 90 && screenAngle < 270 ? 180 : 0
}
