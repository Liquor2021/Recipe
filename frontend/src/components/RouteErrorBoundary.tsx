import type { ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import ErrorBoundary from "@/components/ErrorBoundary"

export default function RouteErrorBoundary({ children, fullScreen = false }: { children: ReactNode; fullScreen?: boolean }) {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <ErrorBoundary resetKey={location.key} fullScreen={fullScreen} onGoHome={() => navigate("/")}>
      {children}
    </ErrorBoundary>
  )
}
