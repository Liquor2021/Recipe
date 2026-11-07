// One editor owns one request generation. Any later intent (including a manual
// edit or unmount) invalidates the result and finally handler of older requests.
export function createTomorrowRequestGate() {
  let generation = 0
  let active = true
  return {
    activate() { active = true; generation++ },
    begin() { return ++generation },
    invalidate() { generation++ },
    dispose() { active = false; generation++ },
    current(token: number) { return active && token === generation },
    active() { return active },
  }
}

export function isMealPlanConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "response" in error
    && typeof error.response === "object" && error.response !== null
    && "status" in error.response && error.response.status === 409
}
