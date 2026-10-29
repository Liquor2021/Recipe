import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { backupApi, settingsApi, shoppingCategoriesApi } from "@/api"
import SecurityNotice from "@/components/SecurityNotice"
import { asString } from "@/lib/utils"
import { useAppInfoStore } from "@/store/useAppInfoStore"
import type { FamilyMember, ShoppingCategoryOverride } from "@/types"
import toast from "react-hot-toast"

const shoppingCategories = ["蔬菜", "肉类", "配料", "其他"]

const FAMILY_TAGS = ["辣", "香菜", "海鲜", "牛肉", "羊肉", "猪肉", "内脏", "芹菜", "青椒", "洋葱"]

// DislikeMode 忌口推荐模式：avoid=温和降权（默认），strict=严格过滤
type DislikeMode = "avoid" | "strict"

const DISLIKE_MODES: { value: DislikeMode; icon: string; label: string }[] = [
  { value: "avoid", icon: "🛡", label: "温和降权" },
  { value: "strict", icon: "⛔", label: "严格过滤" },
]

// 兜底：接口未返回或返回非法值时按温和降权处理
function parseDislikeMode(raw: unknown): DislikeMode {
  return raw === "strict" ? "strict" : "avoid"
}

const DISLIKE_MODE_DESC: Record<DislikeMode, string> = {
  avoid: "温和降权：命中忌口的菜被抽中的概率降到普通菜的约 1/3，排序类推荐里排到最后，可选的菜不够时仍会出现。",
  strict: "严格过滤：命中忌口的菜绝不出现；如果所有菜都被过滤，宁可返回空推荐。",
}

function parseFamilyMembers(raw: unknown): FamilyMember[] {
  // GET /settings 会把合法 JSON 内联成真对象，写入时是字符串——两种形态都要兼容
  let v = raw
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v.filter((m) => m && typeof m.name === "string" && m.name) : []
}

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`w-11 h-6 rounded-xl relative cursor-pointer transition-all flex-shrink-0 ${value ? "bg-primary" : "bg-border2"}`}
    >
      <div className={`absolute top-[2px] w-5 h-5 rounded-full bg-white shadow-sm transition-all ${value ? "left-[22px]" : "left-[2px]"}`} />
    </button>
  )
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// BackupCard 数据备份：服务端每天自动备份数据库；这里看备份情况、手动下载一份当前数据库
function BackupCard() {
  const { data } = useQuery({ queryKey: ["admin", "backups"], queryFn: () => backupApi.list() })
  const [downloading, setDownloading] = useState(false)
  const download = async () => {
    setDownloading(true)
    try {
      await backupApi.download()
    } catch {
      toast.error("下载失败，稍后再试")
    } finally {
      setDownloading(false)
    }
  }
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="text-[13px] font-semibold text-text2 mb-1">数据备份</div>
      <div className="text-[11px] text-text3 mb-3 leading-relaxed">
        {data && data.keep > 0
          ? `每天自动备份一次数据库，保留最近 ${data.keep} 份（${data.dir}）。不含上传的图片，图片原图另在上传备份目录。`
          : "自动备份已关闭（DB_BACKUP_KEEP=0）。"}
        恢复时停止服务，用备份文件替换数据库文件即可（步骤见 README_DEV）。
      </div>
      <button
        onClick={download}
        disabled={downloading}
        className="w-full py-2.5 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-60"
      >
        {downloading ? "正在导出…" : "下载当前数据库"}
      </button>
      {data && data.files.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {data.files.map((f) => (
            <div key={f.name} className="flex items-center justify-between text-[12px] text-text2">
              <span className="truncate">{f.name}</span>
              <span className="flex-shrink-0 text-text3">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border/60 last:border-b-0">
      <div className="text-sm font-medium text-text">{label}</div>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  )
}

// FamilyMembersCard 家庭成员忌口编辑：每次改动即时保存；
// 顶部可切换推荐模式——温和降权（少出现）或严格过滤（绝不出现）
function FamilyMembersCard({ members, mode, onModeChange, onSave, saving, newMemberName, setNewMemberName }: {
  members: FamilyMember[]
  mode: DislikeMode
  onModeChange: (mode: DislikeMode) => void
  onSave: (members: FamilyMember[]) => void
  saving: boolean
  newMemberName: string
  setNewMemberName: (v: string) => void
}) {
  function toggleTag(memberIdx: number, tag: string) {
    const next = members.map((m, i) => {
      if (i !== memberIdx) return m
      const dislikes = m.dislikes.includes(tag)
        ? m.dislikes.filter((d) => d !== tag)
        : [...m.dislikes, tag]
      return { ...m, dislikes }
    })
    onSave(next)
  }

  function removeMember(memberIdx: number) {
    onSave(members.filter((_, i) => i !== memberIdx))
  }

  function addMember() {
    const name = newMemberName.trim()
    if (!name) { toast.error("先填成员名字"); return }
    if (members.some((m) => m.name === name)) { toast.error("已经有这位成员啦"); return }
    onSave([...members, { name, dislikes: [] }])
    setNewMemberName("")
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 mt-4">
      <div className="text-[13px] font-semibold text-text2 mb-2">家庭成员忌口</div>

      {/* 模式切换：温和降权 / 严格过滤，存 settings key family_dislike_mode */}
      <div className="flex gap-1.5 mb-2">
        {DISLIKE_MODES.map((m) => {
          const active = mode === m.value
          return (
            <button
              key={m.value}
              onClick={() => { if (!active) onModeChange(m.value) }}
              disabled={saving}
              className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-all active:scale-95 disabled:opacity-60 ${active ? "border-primary/40 bg-primary-light text-primary" : "border-border2 bg-card text-text3"}`}
            >
              {m.icon} {m.label}
            </button>
          )
        })}
      </div>
      <div className="text-[11px] text-text3 mb-3">{DISLIKE_MODE_DESC[mode]}</div>

      {members.length === 0 && (
        <div className="py-3 text-center text-xs text-text3">还没有添加成员</div>
      )}

      <div className="flex flex-col gap-3">
        {members.map((m, mi) => (
          <div key={m.name} className="rounded-xl bg-bg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold">{m.name}</span>
              <button
                onClick={() => removeMember(mi)}
                className="text-[11px] text-text3 hover:text-red transition-colors"
              >
                移除
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FAMILY_TAGS.map((tag) => {
                const active = m.dislikes.includes(tag)
                return (
                  <button
                    key={tag}
                    onClick={() => toggleTag(mi, tag)}
                    disabled={saving}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all active:scale-95 disabled:opacity-60 ${active ? "border-red/30 bg-red-light text-red" : "border-border2 bg-card text-text3"}`}
                  >
                    不吃{tag}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-3">
        <input
          value={newMemberName}
          onChange={(e) => setNewMemberName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addMember() }}
          placeholder="成员名字，如：爸爸"
          className="flex-1 h-9 rounded-xl border-[1.5px] border-border bg-bg px-3 text-sm outline-none transition-all focus:border-primary"
        />
        <button
          onClick={addMember}
          disabled={saving}
          className="px-4 rounded-xl text-xs font-bold bg-primary text-white transition-all active:scale-95 disabled:opacity-60"
        >
          + 添加成员
        </button>
      </div>
    </div>
  )
}

export default function AdminSettings() {
  const qc = useQueryClient()
  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => settingsApi.get() })

  const [repeatDays, setRepeatDays] = useState<string | null>(null)
  const [lunchPerDay, setLunchPerDay] = useState<string | null>(null)
  const [dinnerPerDay, setDinnerPerDay] = useState<string | null>(null)
  const [appName, setAppName] = useState<string | null>(null)
  const [shoppingItemName, setShoppingItemName] = useState("")
  const [shoppingCategory, setShoppingCategory] = useState("蔬菜")
  const [newMemberName, setNewMemberName] = useState("")
  const storedAppName = useAppInfoStore((s) => s.appName)
  const updateAppName = useAppInfoStore((s) => s.setAppName)

  const updateMut = useMutation({
    mutationFn: (s: Record<string, string>) => settingsApi.update(s),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      // 忌口、每餐道数等设置会改变推荐与周菜单：相关缓存一起失效，回到前台立刻按新设置展示
      for (const key of ["week-plan", "dishes", "pick", "fridge-recipes"]) {
        qc.invalidateQueries({ queryKey: [key] })
      }
      if (variables.app_name !== undefined) {
        updateAppName(variables.app_name || "NiniMenu")
      }
      toast.success("已保存")
    },
    // 忌口模式等开关型设置失败时按钮会静默弹回，必须给用户明确反馈
    onError: () => toast.error("保存失败"),
  })

  const { data: categoryOverrides = [] } = useQuery({
    queryKey: ["shopping-categories"],
    queryFn: () => shoppingCategoriesApi.list(),
  })

  const saveCategoryMut = useMutation({
    mutationFn: (data: { item_name: string; category: string }) => shoppingCategoriesApi.save(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shopping-categories"] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      setShoppingItemName("")
      toast.success("分类已保存")
    },
    onError: () => toast.error("分类保存失败"),
  })

  const deleteCategoryMut = useMutation({
    mutationFn: (itemName: string) => shoppingCategoriesApi.delete(itemName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shopping-categories"] })
      qc.invalidateQueries({ queryKey: ["shopping-list"] })
      toast.success("已恢复智能识别")
    },
    onError: () => toast.error("删除失败"),
  })

  function saveShoppingCategory() {
    const itemName = shoppingItemName.trim()
    if (!itemName) {
      toast.error("请输入食材名称")
      return
    }
    saveCategoryMut.mutate({ item_name: itemName, category: shoppingCategory })
  }

  if (isLoading) return <div className="p-8 text-center text-text2">加载中...</div>

  return (
    <div className="px-5 py-4 max-w-[640px] mx-auto pb-20 space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-[13px] font-semibold text-text2 mb-1">基本设置</div>
        <div className="text-[11px] text-text3 mb-2">应用名称与显示偏好</div>

        <SettingRow label="应用名称">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={appName !== null ? appName : asString(settings?.app_name, storedAppName)}
              onChange={(e) => setAppName(e.target.value)}
              placeholder="NiniMenu"
              className="w-28 py-2 px-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary text-right"
            />
            <button
              onClick={() => updateMut.mutate({ app_name: (appName !== null ? appName : asString(settings?.app_name, "NiniMenu")) || "NiniMenu" })}
              disabled={updateMut.isPending}
              className="px-3 rounded-full text-xs font-semibold bg-primary text-white disabled:opacity-60"
            >
              保存
            </button>
          </div>
        </SettingRow>

        <SettingRow label="推荐去重天数">
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={repeatDays !== null ? repeatDays : asString(settings?.repeat_days, "")}
              onChange={(e) => setRepeatDays(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="3"
              className="w-16 py-2 px-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary text-right"
            />
            <span className="text-xs text-text3 whitespace-nowrap">天内不重复</span>
            <button
              onClick={() => {
                const v = repeatDays !== null ? repeatDays : asString(settings?.repeat_days, "")
                if (!v || Number(v) < 1) { toast.error("至少需要1天"); return }
                updateMut.mutate({ repeat_days: v })
              }}
              disabled={updateMut.isPending}
              className="px-3 rounded-full text-xs font-semibold bg-primary text-white disabled:opacity-60"
            >
              保存
            </button>
          </div>
        </SettingRow>

        <SettingRow label="语音播报">
          <Toggle
            value={settings?.voice_enabled !== "0"}
            onChange={() => updateMut.mutate({ voice_enabled: settings?.voice_enabled === "1" ? "0" : "1" })}
          />
        </SettingRow>

        <SettingRow label="盲盒功能">
          <Toggle
            value={settings?.blind_box_enabled !== "0"}
            onChange={() => updateMut.mutate({ blind_box_enabled: settings?.blind_box_enabled === "1" ? "0" : "1" })}
          />
        </SettingRow>
      </div>

      {/* 家庭成员忌口：模式（温和降权/严格过滤）与成员即时保存 */}
      <FamilyMembersCard
        members={parseFamilyMembers(settings?.family_members)}
        mode={parseDislikeMode(settings?.family_dislike_mode)}
        onModeChange={(m) => updateMut.mutate({ family_dislike_mode: m })}
        onSave={(members) => updateMut.mutate({ family_members: JSON.stringify(members) })}
        saving={updateMut.isPending}
        newMemberName={newMemberName}
        setNewMemberName={setNewMemberName}
      />

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-[13px] font-semibold text-text2 mb-1">一周菜单</div>
        <div className="text-[11px] text-text3 mb-2">设定每日午/晚餐推荐菜品数量</div>

        <SettingRow label="每日午餐数量">
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={lunchPerDay !== null ? lunchPerDay : asString(settings?.lunch_dishes_per_day, "")}
              onChange={(e) => setLunchPerDay(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1"
              className="w-16 py-2 px-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary text-right"
            />
            <span className="text-xs text-text3">道菜</span>
            <button
              onClick={() => {
                const v = lunchPerDay !== null ? lunchPerDay : asString(settings?.lunch_dishes_per_day, "")
                if (!v || Number(v) < 1) { toast.error("至少需要1道菜"); return }
                updateMut.mutate({ lunch_dishes_per_day: v })
              }}
              disabled={updateMut.isPending}
              className="px-3 rounded-full text-xs font-semibold bg-primary text-white disabled:opacity-60"
            >
              保存
            </button>
          </div>
        </SettingRow>

        <SettingRow label="每日晚餐数量">
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={dinnerPerDay !== null ? dinnerPerDay : asString(settings?.dinner_dishes_per_day, "")}
              onChange={(e) => setDinnerPerDay(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="1"
              className="w-16 py-2 px-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary text-right"
            />
            <span className="text-xs text-text3">道菜</span>
            <button
              onClick={() => {
                const v = dinnerPerDay !== null ? dinnerPerDay : asString(settings?.dinner_dishes_per_day, "")
                if (!v || Number(v) < 1) { toast.error("至少需要1道菜"); return }
                updateMut.mutate({ dinner_dishes_per_day: v })
              }}
              disabled={updateMut.isPending}
              className="px-3 rounded-full text-xs font-semibold bg-primary text-white disabled:opacity-60"
            >
              保存
            </button>
          </div>
        </SettingRow>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-[13px] font-semibold text-text2 mb-1">买菜分类修正</div>
        <div className="text-[11px] text-text3 mb-3">识别不准时，在这里固定食材分类；删除后恢复智能识别。</div>
        <div className="flex gap-2 mb-3">
          <input
            value={shoppingItemName}
            onChange={(e) => setShoppingItemName(e.target.value)}
            placeholder="食材名称，如番茄"
            className="flex-1 min-w-0 py-2.5 px-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary"
          />
          <select
            value={shoppingCategory}
            onChange={(e) => setShoppingCategory(e.target.value)}
            className="w-20 py-2.5 px-2 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary"
          >
            {shoppingCategories.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
          <button
            onClick={saveShoppingCategory}
            disabled={saveCategoryMut.isPending}
            className="px-4 rounded-full text-xs font-semibold bg-primary text-white disabled:opacity-60"
          >
            保存
          </button>
        </div>
        {categoryOverrides.length === 0 ? (
          <div className="text-xs text-text3 py-2">暂无手动修正</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {categoryOverrides.map((item: ShoppingCategoryOverride) => (
              <div key={item.item_name} className="flex items-center gap-2 py-1.5 border-t border-border first:border-t-0">
                <span className="text-sm font-medium text-text">{item.item_name}</span>
                <span className="text-[11px] text-primary bg-primary-light px-2 py-0.5 rounded-full">{item.category}</span>
                <button
                  onClick={() => {
                    setShoppingItemName(item.item_name)
                    setShoppingCategory(item.category)
                  }}
                  className="ml-auto text-[11px] text-text2 px-2 py-1 rounded-full bg-bg active:scale-95"
                >
                  修改
                </button>
                <button
                  onClick={() => deleteCategoryMut.mutate(item.item_name)}
                  disabled={deleteCategoryMut.isPending}
                  className="text-[11px] text-red px-2 py-1 rounded-full bg-bg active:scale-95 disabled:opacity-60"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <BackupCard />

      <SecurityNotice />

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-[13px] font-semibold text-text2 mb-1">密码来源</div>
        <div className="text-xs text-text3 leading-relaxed">
          应用密码由环境变量 APP_PASSWORD 控制，管理密码由 ADMIN_PASSWORD 控制。修改后重启服务生效。
        </div>
      </div>
    </div>
  )
}
