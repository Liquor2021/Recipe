import { Component, type ErrorInfo, type ReactNode } from "react"
import "@/styles/kitchen-error.css"

interface ErrorBoundaryProps {
  children: ReactNode
  fullScreen?: boolean
  resetKey?: string
  onGoHome?: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
  resetKey?: string
}

// 全局兜底不依赖路由、查询或业务 store，它们自身出错时也能显示恢复入口。
function fallbackTheme() {
  try {
    const stored = window.localStorage.getItem("ninimenu_kitchen_theme")
    if (stored === "day" || stored === "night") return stored
  } catch { /* 存储不可用时仍然显示错误页。 */ }
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day" }
  catch { return "day" }
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState) {
    // 只清除错误状态，不给健康页面换 key；保留页签状态、滚动位置和查询缓存。
    return props.resetKey !== state.resetKey ? { hasError: false, resetKey: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("页面错误已隔离", error, info.componentStack)
  }

  private retry = () => this.setState({ hasError: false })

  private goHome = () => {
    if (this.props.onGoHome) this.props.onGoHome()
    else window.location.assign("/")
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const fullScreen = this.props.fullScreen
    return (
      <section
        role="alert"
        aria-label="页面出错"
        className={`kitchen-error${fullScreen ? ` kitchen-error-screen kitchen-surface kitchen-${fallbackTheme()}` : ""}`}
      >
        <div className="kitchen-error-note">
          <span className="kitchen-error-stamp" aria-hidden="true">灶</span>
          <h1>这页暂时出错了</h1>
          <p>重试一下，或先回首页。</p>
          <div className="kitchen-error-actions">
            <button type="button" className="is-primary" onClick={this.retry}>重试</button>
            <button type="button" onClick={this.goHome}>回首页</button>
          </div>
          {/* lazy 模块加载失败会被 React 缓存；完整刷新才能重新请求模块。 */}
          <button type="button" className="kitchen-error-reload" onClick={() => window.location.reload()}>仍有问题？刷新页面</button>
        </div>
      </section>
    )
  }
}
