import { useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { isAxiosError } from "axios"
import { AlertCircle, ArrowRight, LoaderCircle, Moon, Soup, Sun } from "lucide-react"
import { authApi } from "@/api"
import { APP_TOKEN_KEY } from "@/api/client"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import { useKitchenTheme, watchKitchenTheme } from "@/store/useKitchenTheme"
import AchievementUnlockOverlay from "@/components/AchievementUnlockOverlay"
import toast from "react-hot-toast"
import "@/styles/kitchen-login.css"

function KitchenLogin({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [shake, setShake] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const appName = useAppInfoStore((s) => s.appName)
  const theme = useKitchenTheme((s) => s.theme)
  const toggleTheme = useKitchenTheme((s) => s.toggleTheme)
  const isNight = theme === "night"
  const today = new Date()
  const dateLabel = `${today.getMonth() + 1}月${today.getDate()}日 · 周${"日一二三四五六"[today.getDay()]}`

  useEffect(watchKitchenTheme, [])

  const loginMut = useMutation({
    mutationFn: authApi.appLogin,
    onSuccess: (_data, submittedPassword) => {
      localStorage.setItem(APP_TOKEN_KEY, submittedPassword)
      setPassword("")
      onUnlock()
      toast.success("手账已翻开")
    },
    onError: (cause) => {
      const wrongPassword = isAxiosError(cause) && cause.response?.status === 401
      setError(wrongPassword
        ? "口令不对，再想想～"
        : isAxiosError(cause) && !cause.response
          ? "暂时连不上小灶，请检查网络后重试。"
          : "暂时没能打开手账，请稍后再试。")
      setShake(wrongPassword)
      inputRef.current?.focus()
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password || loginMut.isPending) return
    setError("")
    setShake(false)
    loginMut.mutate(password)
  }

  return (
    <main className={`kitchen-surface kitchen-login${isNight ? " kitchen-night" : ""}`}>
      <div className="kitchen-login-stage">
        <section className="kitchen-login-cover" aria-labelledby="kitchen-login-title">
          <span className="kitchen-login-spine" aria-hidden="true" />
          <span className="kitchen-login-margin" aria-hidden="true">今天也好好吃饭</span>
          <button className="kitchen-login-theme" type="button" onClick={toggleTheme}
            aria-label={isNight ? "切换到日间主题" : "切换到夜间主题"}>
            {isNight ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
            <span>{isNight ? "日间" : "夜间"}</span>
          </button>

          <header className="kitchen-login-heading">
            {isNight ? (
              <div className="kitchen-login-lamp" aria-hidden="true"><span /></div>
            ) : (
              <div className="kitchen-login-polaroid" aria-hidden="true">
                <div className="kitchen-login-picture"><Soup size={39} strokeWidth={1.3} /></div>
                <span>一餐一饭</span>
              </div>
            )}
            {isNight ? <p className="kitchen-login-night-label">深夜厨房</p> : <div className="kitchen-login-seal" aria-hidden="true">灶</div>}
            <h1 id="kitchen-login-title">{appName}</h1>
            <p className="kitchen-login-subtitle">{isNight ? "想吃点热的再睡" : "把家常的一餐，记成喜欢的日子"}</p>
            <span className="kitchen-login-date">{dateLabel}</span>
          </header>

          <form className="kitchen-login-form" onSubmit={handleSubmit} noValidate aria-busy={loginMut.isPending}>
            <div className={`kitchen-login-field${shake ? " is-shaking" : ""}`} onAnimationEnd={() => setShake(false)}>
              <label htmlFor="kitchen-login-password">{isNight ? "深夜暗号" : "今天的口令"}</label>
              <input
                ref={inputRef}
                id="kitchen-login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                readOnly={loginMut.isPending}
                aria-invalid={!!error}
                aria-describedby={error ? "kitchen-login-error" : undefined}
                placeholder={isNight ? "压低声音，对上暗号…" : "写下口令，翻开手账…"}
                onChange={(event) => { setPassword(event.target.value); setError("") }}
              />
            </div>
            <button className="kitchen-login-submit" type="submit" disabled={!password || loginMut.isPending}>
              {loginMut.isPending ? <LoaderCircle size={17} className="kitchen-login-spinner" aria-hidden="true" /> : null}
              <span>{loginMut.isPending ? "对暗号中…" : isNight ? "掀开锅盖" : "翻开手账"}</span>
              {!loginMut.isPending ? <ArrowRight size={17} aria-hidden="true" /> : null}
            </button>
            <div id="kitchen-login-error" className="kitchen-login-message" aria-live="polite" aria-atomic="true">
              {error ? <p className="kitchen-login-error"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></p> : null}
            </div>
          </form>
          <footer className="kitchen-login-footer">
            <span>NINI · {today.getFullYear()}</span>
            <span>{isNight ? "夜深了，锅还温着" : "手账只属于家里那几个人"}</span>
          </footer>
        </section>
      </div>
    </main>
  )
}

export default function AppGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => !!localStorage.getItem(APP_TOKEN_KEY))

  useEffect(() => {
    const onExpired = () => setUnlocked(false)
    window.addEventListener("app-auth-expired", onExpired)
    return () => window.removeEventListener("app-auth-expired", onExpired)
  }, [])

  if (!unlocked) return <KitchenLogin onUnlock={() => setUnlocked(true)} />

  return <>{children}<AchievementUnlockOverlay /></>
}
