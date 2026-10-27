import { BrowserRouter, Routes, Route } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "react-hot-toast"
import { lazy, Suspense, useEffect } from "react"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import AppGate from "@/components/AppGate"
import OfflineBanner from "@/components/OfflineBanner"
import MainLayout from "@/layouts/MainLayout"
import AdminLayout from "@/layouts/AdminLayout"
import SubPageLayout from "@/layouts/SubPageLayout"

// 页面组件全部按需加载：首屏只拉当前路由 + 布局壳的代码
const Home = lazy(() => import("@/pages/Home"))
const DishList = lazy(() => import("@/pages/DishList"))
const DishDetail = lazy(() => import("@/pages/DishDetail"))
const History = lazy(() => import("@/pages/History"))
const Favorites = lazy(() => import("@/pages/Favorites"))
const PhotoWall = lazy(() => import("@/pages/PhotoWall"))
const More = lazy(() => import("@/pages/More"))
const Tomorrow = lazy(() => import("@/pages/Tomorrow"))
const Achievements = lazy(() => import("@/pages/Achievements"))
const CookMode = lazy(() => import("@/pages/CookMode"))
const Fridge = lazy(() => import("@/pages/Fridge"))
const Report = lazy(() => import("@/pages/Report"))

// 管理端按需加载：普通用户首屏不必下载后台代码
const AdminLogin = lazy(() => import("@/pages/admin/Login"))
const AdminDashboard = lazy(() => import("@/pages/admin/Dashboard"))
const AdminDishes = lazy(() => import("@/pages/admin/Dishes"))
const AdminDishEdit = lazy(() => import("@/pages/admin/DishEdit"))
const AdminSettings = lazy(() => import("@/pages/admin/Settings"))
const AdminAchievements = lazy(() => import("@/pages/admin/Achievements"))
const AdminQuotes = lazy(() => import("@/pages/admin/Quotes"))
const AdminRecords = lazy(() => import("@/pages/admin/Records"))

function RouteLoading() {
  return <div className="h-full flex items-center justify-center text-sm text-text3">加载中…</div>
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
})

export default function App() {
  const fetchAppInfo = useAppInfoStore((s) => s.fetch)
  const appName = useAppInfoStore((s) => s.appName)

  useEffect(() => { fetchAppInfo() }, [fetchAppInfo])
  useEffect(() => { document.title = appName }, [appName])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <OfflineBanner />
        <Routes>
          <Route element={<AppGate><Suspense fallback={<RouteLoading />}><MainLayout /></Suspense></AppGate>}>
            <Route path="/" element={<Home />} />
            <Route path="/dishes" element={<DishList />} />
            <Route path="/history" element={<History />} />
            <Route path="/photo-wall" element={<PhotoWall />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/more" element={<More />} />
          </Route>
          <Route element={<AppGate><Suspense fallback={<RouteLoading />}><SubPageLayout /></Suspense></AppGate>}>
            <Route path="/dishes/:id" element={<DishDetail />} />
            <Route path="/tomorrow" element={<Tomorrow />} />
            <Route path="/achievements" element={<Achievements />} />
            <Route path="/fridge" element={<Fridge />} />
            <Route path="/report" element={<Report />} />
          </Route>
          <Route path="/dishes/:id/cook" element={<AppGate><Suspense fallback={<RouteLoading />}><CookMode /></Suspense></AppGate>} />
          <Route
            path="/admin"
            element={
              <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
                <AdminLayout />
              </Suspense>
            }
          >
            <Route path="login" element={<AdminLogin />} />
            <Route path="dashboard" element={<AdminDashboard />} />
            <Route path="dishes" element={<AdminDishes />} />
            <Route path="dishes/new" element={<AdminDishEdit />} />
            <Route path="dishes/:id" element={<AdminDishEdit />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="achievements" element={<AdminAchievements />} />
          <Route path="quotes" element={<AdminQuotes />} />
          <Route path="records" element={<AdminRecords />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 2000,
          style: {
            borderRadius: "9999px",
            background: "#FFFFFF",
            color: "#1A1A2E",
            fontSize: "14px",
            padding: "10px 24px",
            boxShadow: "0 8px 32px rgba(0,0,0,.1)",
          },
        }}
      />
    </QueryClientProvider>
  )
}
