import { useState } from "react"
import { Award, ChevronRight } from "lucide-react"
import KitchenSheet from "@/components/KitchenSheet"
import { useKitchenTheme } from "@/store/useKitchenTheme"
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
  const [selected, setSelected] = useState<Achievement | null>(null)

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

        <p className="achievement-wall-guide">点开卡片，看看离下一枚有多近</p>
        <div className="grid grid-cols-3 gap-3">
          {sortedAchievements.map((a: Achievement) => (
            <button
              type="button"
              aria-label={"查看成就：" + a.name}
              onClick={() => setSelected(a)}
              key={a.id}
              className={`achievement-wall-card ${a.is_unlocked ? "is-unlocked" : "is-locked"}`}
            >
              <span className="achievement-wall-icon" aria-hidden="true">{a.icon}</span>
              <h3 className="text-xs font-semibold mb-0.5 line-clamp-2 leading-4 min-h-[32px]">{a.name}</h3>
              <p className="text-[11px] text-text2 leading-snug min-h-[28px]">{a.description}</p>
              <div className="achievement-wall-status">
                {a.is_unlocked ? `已解锁 ${formatUnlockedAt(a.unlocked_at)}` : a.condition === "auto" ? "自动检测" : "手动成就"}
              </div>
            </button>
          ))}
        </div>
        {achievements.length === 0 && (
          <div className="kitchen-empty text-sm">还没有成就</div>
        )}
      </div>
      {selected && <AchievementDetail key={selected.id} achievement={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}


function AchievementDetail({ achievement, onClose }: { achievement: Achievement; onClose: () => void }) {
  const theme = useKitchenTheme((state) => state.theme)
  const navigate = useNavigate()
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["achievements", "detail", achievement.id],
    queryFn: () => achievementsApi.details(achievement.id),
    staleTime: 0,
  })
  const unlocked = data?.is_unlocked ?? achievement.is_unlocked
  const progress = data?.progress
  const remaining = progress ? Math.max(0, progress.target - progress.current) : 0
  const series = data?.series ?? []
  const seriesUnlocked = series.filter((item) => item.is_unlocked).length
  return <KitchenSheet title={achievement.name} theme={theme} icon={<Award size={19} />} onClose={onClose} className="achievement-detail" footer={
    unlocked ? <button className="is-ink" onClick={onClose}>收好这枚成就</button> : <button className="is-ink" onClick={() => { onClose(); navigate("/dishes") }}>去记录一顿</button>
  }>
    <div className="achievement-detail-banner">
      <span className="achievement-detail-icon" aria-hidden="true">{achievement.icon}</span>
      <span className={"achievement-detail-status " + (unlocked ? "is-unlocked" : "is-locked")}>{unlocked ? "已解锁 · " + formatUnlockedAt(data?.unlocked_at ?? achievement.unlocked_at) : "尚未解锁"}</span>
    </div>
    <dl className="achievement-condition"><dt>解锁条件</dt><dd>{achievement.description}</dd></dl>
    {isPending ? <p role="status" className="kitchen-sheet-hint">正在翻开成就账本…</p> : isError ? <div role="alert" className="kitchen-empty"><p>暂时无法读取进度</p><button onClick={() => void refetch()}>重新读取</button></div> : <>
      {progress && <section className="achievement-progress-detail">
        <div><span>{unlocked ? "当前进度" : "已积累"}</span><strong>{progress.current} / {progress.target} <small>{progress.unit}</small></strong></div>
        <div className="achievement-meter" role="progressbar" aria-label={achievement.name + "进度"} aria-valuemin={0} aria-valuemax={progress.target} aria-valuenow={Math.min(progress.current, progress.target)} aria-valuetext={progress.current + " / " + progress.target + progress.unit}>
          <span style={{ width: Math.min(100, progress.current / progress.target * 100) + "%" }} />
        </div>
        {!unlocked && <p>{remaining > 0 ? "还差 " + remaining + " " + progress.unit + "，慢慢来，每一点都算数。" : "已达到条件，正在等待成就同步。"}</p>}
        {!unlocked && (data?.estimate ? <p className="kitchen-sheet-hint">近 {data.estimate.window_days} 天记录 {data.estimate.recent_records} 道，照这个节奏约 {data.estimate.days} 天。仅供参考。</p> : <p className="kitchen-sheet-hint">{progress.series === "下厨记录" ? "近期记录还不够，先积累几天再估算。" : "这枚成就按实际条件累计，不估算达成日期。"}</p>)}
        {unlocked && remaining > 0 && <p className="kitchen-sheet-hint">当前记录有变化，已解锁的成就仍为你保留。</p>}
      </section>}
      {!progress && <p className="kitchen-sheet-hint">{achievement.condition === "auto" ? "这枚成就暂不提供数值进度。" : "这是手动成就，按条件确认后解锁。"}</p>}
      {unlocked && <section className="achievement-source">
        <h3>这顿解锁</h3>
        {data?.source ? <>
          <button disabled={!data.source.available} onClick={() => { onClose(); navigate("/history?date=" + data.source!.meal_date + "&record=" + data.source!.record_id) }}>
            <span><strong>{data.source.dish_name}</strong><small>{data.source.meal_date} · {data.source.meal_type === "lunch" ? "午市" : "晚市"}</small></span><ChevronRight size={16} aria-hidden="true" />
          </button>
          {!data.source.available && <p className="kitchen-sheet-hint">原记录已变更或删除，这里保留解锁时的出处。</p>}
        </> : <p className="kitchen-sheet-hint">这枚成就没有保存对应饭局，解锁时间仍为你保留。</p>}
      </section>}
      {series.length > 1 && <section className="achievement-series">
        <h3>{progress?.series} · {seriesUnlocked === series.length ? "已集齐" : "连成串中"}</h3>
        <p className="kitchen-sheet-hint">已解锁 {seriesUnlocked} / {series.length} 枚{seriesUnlocked < series.length ? " · 还剩 " + (series.length - seriesUnlocked) + " 个" : ""}</p>
        <ol>{series.map((item) => <li key={item.id} className={item.is_unlocked ? "is-unlocked" : ""} aria-current={item.id === achievement.id ? "true" : undefined}><span aria-hidden="true" /><small>{item.name}</small></li>)}</ol>
      </section>}
    </>}
  </KitchenSheet>
}
