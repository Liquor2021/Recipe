import { useEffect, useState } from "react"
import { WifiOff } from "lucide-react"

// 离线提示横幅：监听 online/offline 事件，离线时固定在页面顶部展示一条
// 不可交互的提示（点击穿透，不影响下层内容），恢复在线后自动隐藏。
export default function OfflineBanner() {
  // 初始即离线（如断网状态下打开应用）也要第一时间展示
  const [offline, setOffline] = useState(() => !navigator.onLine)

  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => setOffline(false)
    window.addEventListener("offline", goOffline)
    window.addEventListener("online", goOnline)
    return () => {
      window.removeEventListener("offline", goOffline)
      window.removeEventListener("online", goOnline)
    }
  }, [])

  if (!offline) return null

  return (
    // pointer-events-none：横幅不可交互，点击穿透到下层；z-[150] 高于内容（z-[100] 的顶栏/底栏）、低于弹层（z-[200]+）
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[150]"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex items-center justify-center gap-1.5 bg-text/88 px-4 py-1.5 text-xs font-medium text-white backdrop-blur-sm select-none">
        <WifiOff size={13} strokeWidth={2.4} aria-hidden />
        <span>当前离线，展示的是最近一次的数据</span>
      </div>
    </div>
  )
}
