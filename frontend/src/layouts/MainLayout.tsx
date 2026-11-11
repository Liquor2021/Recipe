import { NavLink, useLocation, useNavigate } from "react-router-dom"
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { CalendarDays, Heart, Home as HomeIcon, Images, Menu, UtensilsCrossed } from "lucide-react"
import { motionDuration } from "@/lib/gsap"
import { createTabStripMotion } from "@/lib/tabStripMotion"
import { useKitchenTheme, watchKitchenTheme } from "@/store/useKitchenTheme"
import "@/styles/kitchen-shell.css"

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
  const kitchenTheme = useKitchenTheme((state) => state.theme)
  useEffect(watchKitchenTheme, [])
  const [activeIdx, setActiveIdx] = useState(() =>
    tabs.findIndex((t) => t.path === location.pathname)
  )
  const stripRef = useRef<HTMLDivElement>(null)
  const didMountRef = useRef(false)
  const stripMotionRef = useRef<ReturnType<typeof createTabStripMotion> | null>(null)
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
    identifier: number
    startX: number
    startY: number
    startEdge: "left" | "right"
    directionDecided: boolean
    isHorizontal: boolean | null
  } | null>(null)

  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) return
    const motion = createTabStripMotion(el, STEP_PCT)
    stripMotionRef.current = motion
    return () => {
      motion.stop()
      stripMotionRef.current = null
      touchRef.current = null
      offsetXRef.current = 0
      didMountRef.current = false
    }
  }, [])

  const slideStripTo = useCallback((index: number, duration = 0.32) => {
    // 新的导航接管条带后，旧手指松开也不能再提交一次跳转。
    touchRef.current = null
    offsetXRef.current = 0
    stripMotionRef.current?.slideTo(index, motionDuration(duration))
  }, [])

  useLayoutEffect(() => {
    slideStripTo(activeIdx, didMountRef.current ? 0.32 : 0)
    didMountRef.current = true
  }, [activeIdx, slideStripTo])

  useEffect(() => {
    function cancelSwipe() {
      touchRef.current = null
      const hadOffset = offsetXRef.current !== 0
      offsetXRef.current = 0
      if (hadOffset) slideStripTo(stateRef.current.activeIdx, 0.18)
    }

    function onTouchStart(e: TouchEvent) {
      cancelSwipe()
      const s = stateRef.current
      if (stripMotionRef.current?.isAnimating || e.touches.length !== 1 || e.defaultPrevented) return
      const target = e.target
      // Portal 弹层不在页面条带里；输入、按钮等控件保留自己的触摸操作。
      if (!(target instanceof Element) || !stripRef.current?.contains(target)) return
      if (target.closest("input, textarea, select, button, a, label, [role='button'], [contenteditable]:not([contenteditable='false']), [role='dialog'], [aria-modal='true'], [data-no-swipe]")) return
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
        identifier: t.identifier,
        startX: x,
        startY: t.clientY,
        startEdge,
        directionDecided: false,
        isHorizontal: null,
      }
    }

    function onTouchMove(e: TouchEvent) {
      const ref = touchRef.current
      if (!ref) return
      if (e.touches.length !== 1 || e.touches[0].identifier !== ref.identifier || e.defaultPrevented) {
        cancelSwipe()
        return
      }

      const dx = e.touches[0].clientX - ref.startX
      const dy = e.touches[0].clientY - ref.startY

      if (!ref.directionDecided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        ref.directionDecided = true
        ref.isHorizontal = Math.abs(dx) > Math.abs(dy)
      }

      if (!ref.isHorizontal) {
        cancelSwipe()
        return
      }

      if ((ref.startEdge === "left" && dx < 0) || (ref.startEdge === "right" && dx > 0) || !e.cancelable) {
        cancelSwipe()
        return
      }

      // 方向确定且确实可切换相邻 tab 后，才接管横向手势。
      e.preventDefault()
      const vw = window.innerWidth
      const maxDx = vw * 0.35
      const clampedDx = Math.max(-maxDx, Math.min(maxDx, dx))

      const rubber = clampedDx * (1 - Math.abs(clampedDx) / (vw * 1.2))
      offsetXRef.current = rubber
      stripMotionRef.current?.dragTo(rubber)
    }

    function onTouchEnd(e: TouchEvent) {
      const ref = touchRef.current
      if (!ref) return
      if (e.touches.length > 0 || !ref.isHorizontal) {
        cancelSwipe()
        return
      }
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
        slideStripTo(s.activeIdx, 0.25)
      }
      touchRef.current = null
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchmove", onTouchMove, { passive: false })
    document.addEventListener("touchend", onTouchEnd, { passive: true })
    document.addEventListener("touchcancel", cancelSwipe, { passive: true })
    return () => {
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("touchend", onTouchEnd)
      document.removeEventListener("touchcancel", cancelSwipe)
    }
  }, [navigate, slideStripTo])

  return (
    <div className="h-dvh overflow-clip kitchen-shell" data-kitchen-theme={kitchenTheme}>
      {/* 视口不能被原生横向滚动或焦点滚动带偏；位置只交给条带动画。 */}
      <div className="h-full overflow-clip">
        <div
          ref={stripRef}
          className="flex h-full will-change-transform"
          style={{
            width: `${TAB_COUNT * 100}%`,
          }}
        >
          {tabs.map((tab, i) => (
            <div
              key={tab.path}
              data-tab-scroll={tab.path}
              aria-hidden={i !== activeIdx}
              inert={i !== activeIdx}
              className={`h-full overflow-y-auto overscroll-y-contain kitchen-surface kitchen-${kitchenTheme}`}
              style={{ width: `${STEP_PCT}%`, flexShrink: 0 }}
            >
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
        aria-label="主导航"
        className="kitchen-bookmarks"
      >
        <div className="kitchen-bookmarks-grid">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = activeIdx === tabs.indexOf(tab)
            return (
              <NavLink
                key={tab.path}
                to={tab.path}
                end={tab.exact}
                onClick={(e) => {
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                  e.preventDefault()
                  const idx = tabs.indexOf(tab)
                  if (idx !== activeIdx) {
                    setActiveIdx(idx)
                    navigate(tab.path)
                  }
                }}
                className={() =>
                  `kitchen-bookmark${isActive ? " is-active" : ""}`
                }
              >
                {() => (
                  <>
                    <span className="kitchen-bookmark-icon">
                      <Icon aria-hidden="true" size={18} strokeWidth={1.6} />
                    </span>
                    <span className="kitchen-bookmark-label">
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
