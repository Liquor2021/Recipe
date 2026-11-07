import { create } from "zustand"

interface AuthState {
  token: string | null
  isLoggedIn: boolean
  sessionVersion: number
  login: (token: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem("token"),
  isLoggedIn: !!localStorage.getItem("token"),
  sessionVersion: 0,
  login: (token: string) => {
    localStorage.setItem("token", token)
    set((state) => ({ token, isLoggedIn: true, sessionVersion: state.sessionVersion + 1 }))
  },
  logout: () => {
    localStorage.removeItem("token")
    set((state) => ({ token: null, isLoggedIn: false, sessionVersion: state.sessionVersion + 1 }))
  },
}))
