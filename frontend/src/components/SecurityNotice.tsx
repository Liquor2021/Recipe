import { useQuery } from "@tanstack/react-query"
import { securityApi } from "@/api"
import { ShieldAlert } from "lucide-react"

const LABELS: Record<string, string> = {
  APP_PASSWORD: "应用密码",
  ADMIN_PASSWORD: "管理密码",
  JWT_SECRET: "登录签名密钥",
}

// SecurityNotice 管理后台提醒：口令/密钥还是默认值时显示，部署到局域网或公网前应改掉
export default function SecurityNotice() {
  const { data } = useQuery({ queryKey: ["admin", "security"], queryFn: () => securityApi.status(), staleTime: 300000 })
  const names = data?.insecure_defaults || []
  if (names.length === 0) return null
  return (
    <div className="k-admin-security" role="note">
      <div className="k-admin-security-title"><ShieldAlert size={18} aria-hidden="true" />{names.map((n) => LABELS[n] || n).join("、")}还是默认值</div>
      <div className="text-[12px] text-text2 leading-relaxed">
        默认值是公开的，别人知道就能进后台。部署到局域网或公网前，请在 .env 里设置 {names.join("、")} 后重启服务。
      </div>
    </div>
  )
}
