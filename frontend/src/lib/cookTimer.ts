export type CookTimerStatus = "idle" | "running" | "paused" | "elapsed"

export interface CookTimerState {
  totalMs: number
  remainingMs: number
  status: CookTimerStatus
  deadlineMs: number | null
}

function clampMs(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

export function createCookTimer(totalMs: number): CookTimerState {
  const total = clampMs(totalMs)
  return { totalMs: total, remainingMs: total, status: "idle", deadlineMs: null }
}

export function remainingCookTimerMs(state: CookTimerState, nowMs: number) {
  if (state.status !== "running" || state.deadlineMs === null) return state.remainingMs
  return Math.min(state.totalMs, Math.max(0, state.deadlineMs - nowMs))
}

export function syncCookTimer(state: CookTimerState, nowMs: number): CookTimerState {
  if (state.status !== "running" || state.deadlineMs === null) return state
  const remainingMs = remainingCookTimerMs(state, nowMs)
  if (remainingMs <= 0) return { ...state, remainingMs: 0, status: "elapsed", deadlineMs: null }
  return { ...state, remainingMs }
}

export function startCookTimer(state: CookTimerState, nowMs: number): CookTimerState {
  const synced = syncCookTimer(state, nowMs)
  const remainingMs = synced.status === "elapsed" ? synced.totalMs : synced.remainingMs
  if (remainingMs <= 0) return { ...synced, remainingMs: 0, status: "elapsed", deadlineMs: null }
  return { ...synced, remainingMs, status: "running", deadlineMs: nowMs + remainingMs }
}

export function pauseCookTimer(state: CookTimerState, nowMs: number): CookTimerState {
  const synced = syncCookTimer(state, nowMs)
  if (synced.status !== "running") return synced
  return { ...synced, status: "paused", deadlineMs: null }
}
