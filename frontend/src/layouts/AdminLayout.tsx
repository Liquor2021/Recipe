import { Link, Outlet, useNavigate, useLocation } from "react-router-dom"
import { useEffect, useRef } from "react"
import { LogOut, Moon, Sun } from "lucide-react"
import { useAuthStore } from "@/store/useAuthStore"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import { useKitchenTheme, watchKitchenTheme } from "@/store/useKitchenTheme"
import "@/styles/kitchen-admin.css"

const navItems = [
  { path: "/admin/dashboard", label: "概览" },
  { path: "/admin/dishes", label: "菜品" },
  { path: "/admin/records", label: "记录" },
  { path: "/admin/quotes", label: "语录" },
  { path: "/admin/achievements", label: "成就" },
  { path: "/admin/settings", label: "设置" },
]

export default function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { isLoggedIn, logout } = useAuthStore()
  const leavingAdmin = useRef(false)
  const appName = useAppInfoStore((s) => s.appName)
  const { theme, toggleTheme } = useKitchenTheme()
  useEffect(watchKitchenTheme, [])

  useEffect(() => {
    if (location.pathname !== "/admin/login" && !isLoggedIn && !leavingAdmin.current) {
      navigate("/admin/login", { replace: true })
    }
  }, [isLoggedIn, location.pathname, navigate])

  const handleLogout = () => {
    // 主动退出先标记离开，避免身份更新触发的登录守卫覆盖回首页的导航。
    leavingAdmin.current = true
    logout()
    navigate("/")
  }

  const isActive = (path: string) => location.pathname === path || (path !== "/admin/dashboard" && location.pathname.startsWith(path))

  return (
    <div className={`h-dvh flex flex-col overflow-hidden kitchen-shell kitchen-surface kitchen-${theme} kitchen-admin`} data-kitchen-theme={theme}>
      {location.pathname !== "/admin/login" && (
        <>
          <header className="k-admin-header">
            <div className="k-admin-header-inner">
              <Link to="/" className="k-admin-brand" aria-label="返回首页">灶</Link>
              <h1>{appName}<span> · 管理</span></h1>
              <button type="button" onClick={toggleTheme} className="k-admin-icon-button" aria-label={theme === "day" ? "切换到深夜厨房" : "切换到白日厨房"}>
                {theme === "day" ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}
              </button>
              <button type="button" onClick={handleLogout} className="k-admin-icon-button" aria-label="退出管理登录"><LogOut size={17} aria-hidden="true" /></button>
            </div>
          </header>
          <nav className="k-admin-nav" aria-label="管理导航">
            <div className="k-admin-nav-inner scrollbar-none">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={isActive(item.path) ? "page" : undefined}
                >
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          </nav>
        </>
      )}
      <div className="k-admin-content flex-1 overflow-y-auto overscroll-y-contain">
        <Outlet />
      </div>
    </div>
  )
}
