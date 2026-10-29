import { NavLink, useLocation, useNavigate } from "react-router-dom"
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { CalendarDays, Heart, Home as HomeIcon, Images, Menu, UtensilsCrossed } from "lucide-react"
import { gsap, motionDuration, useGSAP } from "@/lib/gsap"

// 六个 tab 页懒加载：首屏只下载当前页代码
const Home = lazy(() => import("@/pages/Home"))
const DishList = lazy(() => import("@/pages/DishList"))
const History = lazy(() => import("@/pages/History"))
const PhotoWall = lazy(() => import("@/pages/PhotoWall"))
const Favorites = lazy(() => import("@/pages/Favorites"))
const More = lazy(() => import("@/pages/More"))

const tabs = [
  { path: "/", Component: Home, icon: HomeIcon, label: "首页", exact: true },
  { path: "/dishes", Component: DishList, icon: UtensilsCrossed, label: "菜品" },
  { path: "/history", Component: History, icon: CalendarDays, label: "记录" },
  { path: "/photo-wall", Component: PhotoWall, icon: Images, label: "照片墙" },
  { path: "/favorites", Component: Favorites, icon: Heart, label: "收藏" },
  { path: "/more", Component: More, icon: Menu, label: "更多" },
]

const TAB_COUNT = tabs.length
const STEP_PCT = 100 / TAB_COUNT

const EDGE_ZONE = 36
const SWIPE_MIN = 30

function TabLoading() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-text3">加载中…</div>
  )
}

export default function MainLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [activeIdx, setActiveIdx] = useState(() =>
    tabs.findIndex((t) => t.path === location.pathname)
  )
  const stripRef = useRef<HTMLDivElement>(null)
  const didMountRef = useRef(false)
  const animatingRef = useRef(false)
  const offsetXRef = useRef(0)
  // 路由变化（后退/前进、其他页面跳转）时同步当前 tab：在渲染中按"上一次的路径"调整，
  // 比在 effect 里 setState 少一次以旧 tab 渲染的中间态
  const [syncedPath, setSyncedPath] = useState(location.pathname)
  if (syncedPath !== location.pathname) {
    setSyncedPath(location.pathname)
    const idx = tabs.findIndex((t) => t.path === location.pathname)
    if (idx >= 0 && idx !== activeIdx) setActiveIdx(idx)
  }

  // 六个 tab 按需挂载：过去打开 App 时六页一起挂载、一起拉数据（冷启动 17 个请求，没打开的页
  // 也在加载）。现在只挂当前页，空闲一会儿再挂相邻页，边缘滑动开始时也先挂相邻页——拖动时露出
  // 的那一页已经在了，不会闪白。挂过的页一直保留（数据和滚动位置都在）。
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<number>>(() => new Set(activeIdx >= 0 ? [activeIdx] : []))
  const mountTabs = useCallback((idxs: number[]) => {
    setMountedTabs((prev) => {
      const add = idxs.filter((i) => i >= 0 && i < TAB_COUNT && !prev.has(i))
      return add.length === 0 ? prev : new Set([...prev, ...add])
    })
  }, [])
  if (activeIdx >= 0 && !mountedTabs.has(activeIdx)) {
    setMountedTabs(new Set([...mountedTabs, activeIdx]))
  }
  useEffect(() => {
    const timer = window.setTimeout(() => mountTabs([activeIdx - 1, activeIdx + 1]), 1200)
    return () => window.clearTimeout(timer)
  }, [activeIdx, mountTabs])

  // 触摸事件处理函数（document 上的原生监听）读最新 tab：提交后同步写入，不在渲染中写 ref
  const stateRef = useRef({ activeIdx, mountTabs })
  useLayoutEffect(() => {
    stateRef.current = { activeIdx, mountTabs }
  }, [activeIdx, mountTabs])

  const touchRef = useRef<{
    startX: number
    startY: number
    startEdge: "left" | "right"
    directionDecided: boolean
    isHorizontal: boolean | null
  } | null>(null)

  useGSAP(() => {
    const el = stripRef.current
    if (!el) return
    const duration = didMountRef.current ? motionDuration(0.32) : 0
    didMountRef.current = true
    offsetXRef.current = 0
    animatingRef.current = duration > 0
    gsap.to(el, {
      xPercent: -activeIdx * STEP_PCT,
      x: 0,
      duration,
      ease: "power3.out",
      force3D: true,
      onComplete: () => {
        animatingRef.current = false
      },
    })
  }, { dependencies: [activeIdx], scope: stripRef })

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      const s = stateRef.current
      if (animatingRef.current) return
      const t = e.touches[0]
      const x = t.clientX
      const vw = window.innerWidth
      let startEdge: "left" | "right" | null = null
      if (x < EDGE_ZONE) startEdge = "left"
      else if (x > vw - EDGE_ZONE) startEdge = "right"
      if (!startEdge) return
      if (startEdge === "left" && s.activeIdx === 0) return
      if (startEdge === "right" && s.activeIdx === tabs.length - 1) return
      // 开始边缘滑动：先把要露出来的相邻页挂上
      s.mountTabs([startEdge === "left" ? s.activeIdx - 1 : s.activeIdx + 1])
      touchRef.current = {
        startX: x,
        startY: t.clientY,
        startEdge,
        directionDecided: false,
        isHorizontal: null,
      }
    }

    function onTouchMove(e: TouchEvent) {
      const ref = touchRef.current
      if (!ref) {
        const t = e.touches[0]
        const x = t.clientX
        const vw = window.innerWidth
        if (x < EDGE_ZONE || x > vw - EDGE_ZONE) e.preventDefault()
        return
      }
      e.preventDefault()

      const dx = e.touches[0].clientX - ref.startX
      const dy = e.touches[0].clientY - ref.startY

      if (!ref.directionDecided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        ref.directionDecided = true
        ref.isHorizontal = Math.abs(dx) > Math.abs(dy)
      }

      if (!ref.isHorizontal) {
        touchRef.current = null
        offsetXRef.current = 0
        gsap.to(stripRef.current, { x: 0, duration: motionDuration(0.18), ease: "power2.out" })
        return
      }

      let clampedDx = dx
      if (ref.startEdge === "left") {
        if (dx < 0) {
          touchRef.current = null
          offsetXRef.current = 0
          gsap.to(stripRef.current, { x: 0, duration: motionDuration(0.18), ease: "power2.out" })
          return
        }
      } else {
        if (dx > 0) {
          touchRef.current = null
          offsetXRef.current = 0
          gsap.to(stripRef.current, { x: 0, duration: motionDuration(0.18), ease: "power2.out" })
          return
        }
      }

      const vw = window.innerWidth
      const maxDx = vw * 0.35
      clampedDx = Math.max(-maxDx, Math.min(maxDx, clampedDx))

      const rubber = clampedDx * (1 - Math.abs(clampedDx) / (vw * 1.2))
      offsetXRef.current = rubber
      gsap.set(stripRef.current, { x: rubber, force3D: true })
    }

    function onTouchEnd() {
      const ref = touchRef.current
      if (!ref) return
      const s = stateRef.current
      const dx = offsetXRef.current
      if (ref.startEdge === "left" && dx > SWIPE_MIN && s.activeIdx > 0) {
        offsetXRef.current = 0
        setActiveIdx(s.activeIdx - 1)
        navigate(tabs[s.activeIdx - 1].path)
      } else if (ref.startEdge === "right" && dx < -SWIPE_MIN && s.activeIdx < tabs.length - 1) {
        offsetXRef.current = 0
        setActiveIdx(s.activeIdx + 1)
        navigate(tabs[s.activeIdx + 1].path)
      } else {
        if (stripRef.current) {
          offsetXRef.current = 0
          animatingRef.current = true
          gsap.to(stripRef.current, {
            xPercent: -s.activeIdx * STEP_PCT,
            x: 0,
            duration: motionDuration(0.25),
            ease: "power3.out",
            onComplete: () => {
              animatingRef.current = false
            },
          })
        }
      }
      touchRef.current = null
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchmove", onTouchMove, { passive: false })
    document.addEventListener("touchend", onTouchEnd, { passive: true })
    return () => {
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("touchend", onTouchEnd)
    }
  }, [navigate])

  return (
    <div className="h-dvh bg-bg overflow-hidden" style={{ touchAction: "pan-y" }}>
      <div className="h-full overflow-hidden">
        <div
          ref={stripRef}
          className="flex h-full will-change-transform"
          style={{
            width: `${TAB_COUNT * 100}%`,
          }}
        >
          {tabs.map((tab, i) => (
            <div key={tab.path} className="h-full overflow-y-auto overscroll-y-contain pb-[calc(60px+env(safe-area-inset-bottom))]" style={{ width: `${STEP_PCT}%`, flexShrink: 0 }}>
              {mountedTabs.has(i) ? (
                <Suspense fallback={<TabLoading />}>
                  <tab.Component />
                </Suspense>
              ) : (
                <TabLoading />
              )}
            </div>
          ))}
        </div>
      </div>

      <nav
        className="fixed bottom-0 left-0 right-0 z-[100] border-t border-white/70 bg-white/92 backdrop-blur-2xl shadow-[0_-10px_30px_rgba(26,26,46,.07)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto grid h-[58px] max-w-[640px] grid-cols-6 items-center px-2">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = activeIdx === tabs.indexOf(tab)
            return (
              <NavLink
                key={tab.path}
                to={tab.path}
                end={tab.exact}
                onClick={(e) => {
                  e.preventDefault()
                  const idx = tabs.indexOf(tab)
                  if (idx !== activeIdx) {
                    setActiveIdx(idx)
                    navigate(tab.path)
                  }
                }}
                className={() =>
                  `group relative flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-[13px] text-[10px] font-semibold transition-all active:scale-95 ${isActive ? "text-primary" : "text-text3 hover:text-text2"}`
                }
              >
                {() => (
                  <>
                    <span className={`flex h-6 w-8 items-center justify-center rounded-full transition-all ${isActive ? "bg-primary-light text-primary shadow-[inset_0_0_0_1px_rgba(232,115,74,.10)]" : "text-text3 group-hover:bg-bg"}`}>
                      <Icon size={18} strokeWidth={isActive ? 2.6 : 2.1} />
                    </span>
                    <span className={`max-w-full truncate leading-none transition-colors ${isActive ? "text-primary" : "text-text3"}`}>
                      {tab.label}
                    </span>
                  </>
                )}
              </NavLink>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
