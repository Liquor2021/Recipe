import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { reportApi } from "@/api"
import PageHeader from "@/components/PageHeader"
import { cardShadow } from "@/components/Card"
import type { ReportShare } from "@/types"

const MOOD_EMOJI: Record<string, string> = { yum: "😋", ok: "😐", no: "😒" }
const MOOD_LABEL: Record<string, string> = { yum: "吃得美滋滋", ok: "还行", no: "不太满意" }

function ShareBars({ shares, tone }: { shares: ReportShare[]; tone: "primary" | "mint" }) {
  const max = Math.max(...shares.map((s) => s.count), 1)
  if (shares.length === 0) {
    return <div className="py-3 text-center text-xs text-text3">这个周期还没有数据</div>
  }
  return (
    <div className="flex flex-col gap-2">
      {shares.map((s) => (
        <div key={s.name} className="flex items-center gap-2.5">
          <span className="w-16 flex-shrink-0 text-xs font-medium text-text2 truncate">{s.name}</span>
          <div className="flex-1 h-2 rounded-full bg-bg overflow-hidden">
            <div
              className={`h-full rounded-full ${tone === "primary" ? "bg-primary" : "bg-mint"} transition-all`}
              style={{ width: `${(s.count / max) * 100}%` }}
            />
          </div>
          <span className="w-6 flex-shrink-0 text-right text-xs font-bold text-text3">{s.count}</span>
        </div>
      ))}
    </div>
  )
}

export default function Report() {
  const navigate = useNavigate()
  const [range, setRange] = useState<"week" | "month">("week")
  const { data: report } = useQuery({
    queryKey: ["report", range],
    queryFn: () => reportApi.get(range),
  })

  const activityDelta = (report?.cook_days ?? 0) - (report?.prev_cook_days ?? 0)

  return (
    <div className="animate-fadeUp">
      <PageHeader
        title="饮食报告"
        subtitle="看看这段时间吃得怎么样"
        onBack={() => navigate(-1)}
        actions={
          <div className="flex rounded-full bg-bg border border-border p-0.5">
            {(["week", "month"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${range === r ? "bg-primary text-white" : "text-text2"}`}
              >
                {r === "week" ? "本周" : "本月"}
              </button>
            ))}
          </div>
        }
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto pb-24">
        {report && (
          <>
            {/* 做饭活跃度 */}
            <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-5 mb-3`}>
              <div className="flex items-end justify-between mb-1">
                <div>
                  <div className="text-[13px] text-text2 mb-0.5">这个{range === "week" ? "周" : "月"}下厨</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[34px] font-extrabold tracking-tight leading-none">{report.cook_days}</span>
                    <span className="text-sm font-semibold text-text2">天</span>
                  </div>
                </div>
                <div className={`text-right text-xs font-semibold px-2.5 py-1 rounded-full ${activityDelta > 0 ? "bg-mint-light text-mint" : activityDelta < 0 ? "bg-bg text-text3" : "bg-bg text-text3"}`}>
                  {activityDelta > 0 ? `↑ 比上期多 ${activityDelta} 天` : activityDelta < 0 ? `↓ 比上期少 ${-activityDelta} 天` : "和上期持平"}
                </div>
              </div>
              <div className="text-[11px] text-text3 mt-1.5">
                共 {report.total_meals} 顿（午 {report.lunch_count} · 晚 {report.dinner_count}）· 做了 {report.distinct_dishes} 道不同的菜
              </div>
            </div>

            {/* 四项指标 */}
            <div className="grid grid-cols-3 gap-2.5 mb-5">
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-3.5 text-center`}>
                <div className="text-xl font-extrabold text-primary">{report.repeat_rate}%</div>
                <div className="text-[11px] text-text2 mt-0.5">复做率</div>
              </div>
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-3.5 text-center`}>
                <div className="text-xl font-extrabold text-mint">{report.new_dish_rate}%</div>
                <div className="text-[11px] text-text2 mt-0.5">新菜尝试</div>
              </div>
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-3.5 text-center`}>
                <div className="flex items-center justify-center gap-1 text-xl font-extrabold text-[#C8A23C]">
                  {report.avg_rating > 0 ? report.avg_rating.toFixed(1) : "-"}
                </div>
                <div className="text-[11px] text-text2 mt-0.5">平均评分</div>
              </div>
            </div>

            {/* 家常菜 Top */}
            <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-4 mb-3`}>
              <div className="text-[15px] font-bold mb-3">🏆 最常做的菜</div>
              {report.top_dishes.length === 0 ? (
                <div className="py-3 text-center text-xs text-text3">这个周期还没有做饭记录</div>
              ) : (
                <div className="flex flex-col">
                  {report.top_dishes.map((d, i) => (
                    <div
                      key={d.dish_id}
                      onClick={() => navigate(`/dishes/${d.dish_id}`)}
                      className="flex items-center gap-3 py-2 cursor-pointer active:opacity-60 transition-opacity"
                    >
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${i < 3 ? "bg-primary text-white" : "bg-bg text-text3"}`}>
                        {i + 1}
                      </div>
                      <span className="flex-1 text-sm font-medium truncate">{d.dish_name}</span>
                      <span className="text-xs font-bold text-primary">{d.count} 次</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 口味 & 分类分布 */}
            <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-4 mb-3`}>
              <div className="text-[15px] font-bold mb-3">👅 口味偏好</div>
              <ShareBars shares={report.taste_shares} tone="primary" />
            </div>

            <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-4 mb-3`}>
              <div className="text-[15px] font-bold mb-3">🍽 菜系分布</div>
              <ShareBars shares={report.category_shares} tone="mint" />
            </div>

            {/* 心情 */}
            {report.mood_shares.length > 0 && (
              <div className={`bg-card rounded-2xl border border-border ${cardShadow} p-4`}>
                <div className="text-[15px] font-bold mb-3">💛 吃饭心情</div>
                <div className="flex gap-2.5">
                  {report.mood_shares.map((m) => (
                    <div key={m.name} className="flex-1 rounded-xl bg-bg py-3 text-center">
                      <div className="text-2xl mb-0.5">{MOOD_EMOJI[m.name] || "🍽"}</div>
                      <div className="text-[11px] font-semibold text-text2">{MOOD_LABEL[m.name] || m.name}</div>
                      <div className="text-[10px] text-text3">{m.count} 天</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
