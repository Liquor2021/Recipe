import { create } from "zustand"
import axios from "axios"

interface AppInfoState {
  appName: string
  loaded: boolean
  fetch: () => Promise<void>
  setAppName: (name: string) => void
}

const APP_NAME_KEY = "ninimenu_app_name"
export const DEFAULT_APP_NAME = "小灶手账"

export function appDisplayName(name: string): string {
  const value = name.trim()
  return !value || value === "NiniMenu" ? DEFAULT_APP_NAME : value
}

function getStoredName(): string {
  return appDisplayName(localStorage.getItem(APP_NAME_KEY) || "")
}

export const useAppInfoStore = create<AppInfoState>((set) => ({
  appName: getStoredName(),
  loaded: false,
  fetch: async () => {
    try {
      const res = await axios.get("/api/app-info")
      if (res.data?.code === 0 && res.data?.data?.app_name) {
        const name = appDisplayName(res.data.data.app_name as string)
        localStorage.setItem(APP_NAME_KEY, name)
        set({ appName: name, loaded: true })
        document.title = name
      } else {
        set({ loaded: true })
      }
    } catch {
      set({ loaded: true })
    }
  },
  setAppName: (value: string) => {
    const name = appDisplayName(value)
    localStorage.setItem(APP_NAME_KEY, name)
    set({ appName: name })
    document.title = name
  },
}))
