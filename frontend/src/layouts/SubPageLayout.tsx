import { Outlet } from "react-router-dom"
import { useEffect } from "react"
import { useKitchenTheme, watchKitchenTheme } from "@/store/useKitchenTheme"

export default function SubPageLayout() {
  const theme = useKitchenTheme((state) => state.theme)
  useEffect(watchKitchenTheme, [])
  return (
    <div className={`h-dvh kitchen-surface kitchen-${theme} overflow-y-auto overscroll-y-contain`} style={{ touchAction: "pan-y" }}>
      <Outlet />
    </div>
  )
}
