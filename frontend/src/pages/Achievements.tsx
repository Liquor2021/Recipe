import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { achievementsApi } from "@/api"
import PageHeader from "@/components/PageHeader"
import type { Achievement } from "@/types"
import "@/styles/kitchen-achievements.css"

function formatUnlockedAt(value?: string | null) {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return `${d.getMonth() + 1}.${d.getDate()}`
}

export default function Achievements() {
  const navigate = useNavigate()

  const { data: rawAchievements } = useQuery({ queryKey: ["achievements"], queryFn: () => achievementsApi.list() })
  const achievements = Array.isArray(rawAchievements) ? rawAchievements : []

  const unlockedCount = achievements.filter((a: Achievement) => a.is_unlocked).length
  const autoCount = achievements.filter((a: Achievement) => a.condition === "auto").length
  const manualCount = achievements.length - autoCount
  const progress = achievements.length > 0 ? Math.round((unlockedCount / achievements.length) * 100) : 0
  const sortedAchievements = achievements.slice().sort((a: Achievement, b: Achievement) => {
    if (a.is_unlocked !== b.is_unlocked) return a.is_unlocked ? -1 : 1
    return a.id - b.id
  })

  return (
    <div className="animate-fadeUp">
      <PageHeader
        title="成就墙"
        subtitle="记录你们一起解锁的小目标"
        meta={`${unlockedCount}/${achievements.length}`}
        onBack={() => navigate(-1)}
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto">
        <section className="achievement-progress-card">
          <div className="flex items-end justify-between mb-2.5">
            <div>
              <h2 className="text-[13px] text-text2 mb-0.5">成就进度</h2>
              <div className="text-2xl font-extrabold tracking-tight">{progress}%</div>
            </div>
            <div className="text-right text-xs text-text2 leading-relaxed">
              <div>自动 {autoCount}</div>
              <div>手动 {manualCount}</div>
            </div>
          </div>
          <div className="h-2 rounded-full bg-bg overflow-hidden" role="progressbar" aria-label="成就进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </section>

        <div className="grid grid-cols-3 gap-3">
          {sortedAchievements.map((a: Achievement) => (
            <article
              key={a.id}
              className={`achievement-wall-card ${a.is_unlocked ? "is-unlocked" : "is-locked"}`}
            >
              <span className="achievement-wall-icon" aria-hidden="true">{a.icon}</span>
              <h3 className="text-xs font-semibold mb-0.5 line-clamp-2 leading-4 min-h-[32px]">{a.name}</h3>
              <p className="text-[11px] text-text2 leading-snug min-h-[28px]">{a.description}</p>
              <div className="achievement-wall-status">
                {a.is_unlocked ? `已解锁 ${formatUnlockedAt(a.unlocked_at)}` : a.condition === "auto" ? "自动检测" : "手动成就"}
              </div>
            </article>
          ))}
        </div>
        {achievements.length === 0 && (
          <div className="kitchen-empty text-sm">还没有成就</div>
        )}
      </div>
    </div>
  )
}
