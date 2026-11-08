import { useState, useEffect, useId } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation } from "@tanstack/react-query"
import { authApi } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import toast from "react-hot-toast"

export default function AdminLogin() {
  const navigate = useNavigate()
  const { isLoggedIn, login } = useAuthStore()
  const appName = useAppInfoStore((s) => s.appName)
  const [password, setPassword] = useState("")
  const passwordId = useId()

  useEffect(() => {
    if (isLoggedIn) navigate("/admin/dashboard", { replace: true })
  }, [isLoggedIn, navigate])

  const loginMut = useMutation({
    mutationFn: () => authApi.login(password),
    onSuccess: (data) => {
      login(data.token)
      toast.success("✅ 登录成功")
      navigate("/admin/dashboard")
    },
    onError: () => toast.error("密码错误"),
  })

  return (
    <div className="k-admin-login">
      <form className="k-admin-login-paper" onSubmit={(event) => {
        event.preventDefault()
        if (password && !loginMut.isPending) loginMut.mutate()
      }}>
        <div className="k-admin-login-seal" aria-hidden="true">灶</div>
        <h1>{appName} · 管理</h1>
        <p className="k-admin-login-note">输入管理密码，翻开厨房手账</p>
        <div className="mb-4">
          <label htmlFor={passwordId} className="block text-[13px] font-semibold mb-1.5 text-text2">管理密码</label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="请输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="k-admin-login-input"
          />
        </div>
        <button type="submit" disabled={loginMut.isPending} className="k-admin-login-submit">{loginMut.isPending ? "正在进入…" : "进入管理"}</button>
        <button type="button" onClick={() => navigate("/")} className="k-admin-login-cancel">返回厨房</button>
      </form>
    </div>
  )
}
