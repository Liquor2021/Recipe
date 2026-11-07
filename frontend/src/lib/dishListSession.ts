import { create } from "zustand"
import { useAuthStore } from "@/store/useAuthStore"

export interface DishListSession {
  date: string
  search: string
  activeCategory: string
  activeTaste: string
  scrollTop: number
  categoryScrollTop: number
  tasteScrollLeft: number
}

function emptySession(date: string): DishListSession {
  return { date, search: "", activeCategory: "全部", activeTaste: "全部", scrollTop: 0, categoryScrollTop: 0, tasteScrollLeft: 0 }
}

// Only browsing state lives here. Recipe pages remain in React Query, and no
// credentials or meal records are written to browser storage.
export const useDishListSession = create<{ generation: number; value: DishListSession | null }>(() => ({
  generation: 0,
  value: null,
}))

export function readDishListSession(date: string): DishListSession {
  const saved = useDishListSession.getState().value
  return saved?.date === date ? saved : emptySession(date)
}

export function saveDishListSession(date: string, values: Partial<Omit<DishListSession, "date">>) {
  useDishListSession.setState({ value: { ...readDishListSession(date), ...values } })
}

function resetSession() {
  useDishListSession.setState((state) => ({ generation: state.generation + 1, value: null }))
}

const unsubscribeAuth = useAuthStore.subscribe((state, previous) => {
  if (state.token !== previous.token) resetSession()
})
window.addEventListener("app-auth-expired", resetSession)
window.addEventListener("admin-auth-expired", resetSession)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeAuth()
    window.removeEventListener("app-auth-expired", resetSession)
    window.removeEventListener("admin-auth-expired", resetSession)
  })
}
