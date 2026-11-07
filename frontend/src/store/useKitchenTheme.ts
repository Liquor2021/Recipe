import { create } from "zustand"

export type KitchenTheme = "day" | "night"

const STORAGE_KEY = "ninimenu_kitchen_theme"
const SYSTEM_QUERY = "(prefers-color-scheme: dark)"

function asTheme(value: string | null): KitchenTheme | null {
  return value === "day" || value === "night" ? value : null
}

function storedTheme(): { available: boolean; value: KitchenTheme | null } {
  try { return { available: true, value: asTheme(localStorage.getItem(STORAGE_KEY)) } }
  catch { return { available: false, value: null } }
}

function systemTheme(): KitchenTheme {
  return typeof window !== "undefined" && window.matchMedia(SYSTEM_QUERY).matches ? "night" : "day"
}

interface KitchenThemeState {
  theme: KitchenTheme
  preference: KitchenTheme | null
  setTheme: (theme: KitchenTheme) => void
  toggleTheme: () => void
}

const preference = storedTheme().value

export const useKitchenTheme = create<KitchenThemeState>((set, get) => ({
  theme: preference ?? systemTheme(),
  preference,
  setTheme: (theme) => {
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* 本次选择在隐私模式下仍然生效。 */ }
    set({ theme, preference: theme })
  },
  toggleTheme: () => get().setTheme(get().theme === "day" ? "night" : "day"),
}))

// 只有未手动选择时才跟随系统；监听由布局持有，卸载时清理。
export function watchKitchenTheme(): () => void {
  const media = window.matchMedia(SYSTEM_QUERY)
  const syncStoredTheme = () => {
    const stored = storedTheme()
    if (!stored.available) return
    useKitchenTheme.setState({ preference: stored.value, theme: stored.value ?? systemTheme() })
  }
  const onSystemChange = () => {
    if (useKitchenTheme.getState().preference === null) {
      useKitchenTheme.setState({ theme: media.matches ? "night" : "day" })
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    // sessionStorage 的同名事件不属于主题偏好；重读当前值也避免迟到的事件倒退选择。
    try { if (event.storageArea !== window.localStorage) return } catch { return }
    syncStoredTheme()
  }
  // 去详情/后台会卸载主布局；返回时补上期间可能发生的跨标签修改。
  syncStoredTheme()
  onSystemChange()
  media.addEventListener("change", onSystemChange)
  window.addEventListener("storage", onStorage)
  return () => {
    media.removeEventListener("change", onSystemChange)
    window.removeEventListener("storage", onStorage)
  }
}
