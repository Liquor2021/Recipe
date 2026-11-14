import { useState, useEffect, useId, useRef } from "react"
import type { FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { AlertCircle } from "lucide-react"
import { authApi } from "@/api"
import { getLoginError } from "@/lib/loginError"
import { useLoginFeedback } from "@/hooks/useLoginFeedback"
import { useAuthStore } from "@/store/useAuthStore"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import toast from "react-hot-toast"

export default function AdminLogin() {
  const navigate = useNavigate()
  const { isLoggedIn, login } = useAuthStore()
  const appName = useAppInfoStore((s) => s.appName)
  const [password, setPassword] = useState("")
  const { error, isLocked, message, showError, clearError } = useLoginFeedback()
  const inputRef = useRef<HTMLInputElement>(null)
  const passwordId = useId()
  const errorId = useId()

  useEffect(() => {
    if (isLoggedIn) navigate("/admin/dashboard", { replace: true })
  }, [isLoggedIn, navigate])

  const loginMut = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data) => {
      login(data.token)
      setPassword("")
      toast.success("已进入管理模式")
      navigate("/admin/dashboard", { replace: true })
    },
    onError: (cause) => {
      showError(getLoginError(cause, "admin"))
      inputRef.current?.focus()
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password || loginMut.isPending || isLocked) return
    clearError()
    loginMut.mutate(password)
  }

  return (
    <div className="k-admin-login">
      <form className="k-admin-login-paper" onSubmit={handleSubmit} noValidate aria-busy={loginMut.isPending}>
        <div className="k-admin-login-seal" aria-hidden="true">灶</div>
        <h1>{appName} · 管理</h1>
        <p className="k-admin-login-note">输入管理密码，翻开厨房手账</p>
        <div className="mb-4">
          <label htmlFor={passwordId} className="block text-[13px] font-semibold mb-1.5 text-text2">管理密码</label>
          <input
            ref={inputRef}
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="请输入密码"
            value={password}
            readOnly={loginMut.isPending}
            aria-invalid={error?.invalidPassword ?? false}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => { setPassword(e.target.value); clearError() }}
            className="k-admin-login-input"
          />
        </div>
        <button type="submit" disabled={!password || loginMut.isPending || isLocked} data-login-locked={isLocked || undefined} className="k-admin-login-submit">{isLocked ? "已锁定" : loginMut.isPending ? "正在进入…" : "进入管理"}</button>
        <div id={errorId} className="k-admin-login-message" aria-live="polite" aria-atomic="true">
          {message && <p><AlertCircle size={15} aria-hidden="true" /><span>{message}</span></p>}
        </div>
        <button type="button" onClick={() => navigate("/")} className="k-admin-login-cancel">返回厨房</button>
      </form>
    </div>
  )
}
