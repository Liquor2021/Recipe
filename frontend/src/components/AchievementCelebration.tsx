import type { CSSProperties } from "react"
import type { Achievement } from "@/types"
import type { KitchenTheme } from "@/store/useKitchenTheme"

const colors = ["var(--k-red)", "var(--k-green)", "var(--k-amber)", "#e8dcc6", "#fbf8f1"]

function confettiStyle(i: number): CSSProperties {
  const size = 6 + (i % 4) * 2
  return {
    left: `${8 + ((i * 17) % 84)}%`,
    width: `${size}px`,
    height: `${Math.max(4, size - 2)}px`,
    background: colors[i % colors.length],
    ["--drift" as string]: `${((i % 7) - 3) * 18}px`,
    ["--fall-delay" as string]: `${(i % 9) * 70}ms`,
    ["--fall-duration" as string]: `${1500 + (i % 5) * 180}ms`,
  }
}

export default function AchievementCelebration({ achievement, leaving, queueLen, theme }: {
  achievement: Achievement
  leaving: boolean
  queueLen: number
  theme: KitchenTheme
}) {
  return (
    <div className={`kitchen-surface kitchen-${theme} achievement-unlock-layer ${leaving ? "is-leaving" : ""}`} role="status" aria-live="polite">
      <div className="achievement-confetti-field" aria-hidden="true">
        {Array.from({ length: 32 }, (_, i) => <span key={i} className="achievement-confetti-piece" style={confettiStyle(i)} />)}
      </div>
      <div className="achievement-unlock-card">
        <span className="achievement-tape" aria-hidden="true" />
        <span className="achievement-corner-stamp" aria-hidden="true">达成</span>
        {[0, 1, 2].map(i => <div key={i} className={`achievement-glow-ring ${i === 1 ? "is-amber" : ""}`} style={{ animationDelay: `${i * .4}s` }} aria-hidden="true" />)}
        <div className="achievement-icon-wrap"><span className="achievement-icon" aria-hidden="true">{achievement.icon || "🏆"}</span></div>
        <div className="achievement-kicker">成就已解锁</div>
        <div className="achievement-title">{achievement.name}</div>
        <div className="achievement-desc">{achievement.description}</div>
        {queueLen > 0 && <div className="achievement-chain">连续解锁中 · 还剩 {queueLen} 个</div>}
      </div>
    </div>
  )
}
