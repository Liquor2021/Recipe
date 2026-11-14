import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import "./styles/kitchen-fonts.css"
import "./styles/kitchen-shell.css"
import "./styles/kitchen-controls.css"
import App from "./App"
import ErrorBoundary from "./components/ErrorBoundary"

// Service Worker 仅生产环境注册（离线缓存静态资源），避免干扰开发热更新
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fullScreen>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
