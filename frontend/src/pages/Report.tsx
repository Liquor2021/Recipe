import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Download, Share2, Trophy, Salad, Flame, Utensils, Heart } from "lucide-react"
import toast from "react-hot-toast"
import { reportApi } from "@/api"
import PageHeader, { HeaderIconButton } from "@/components/PageHeader"
import KitchenSheet from "@/components/KitchenSheet"
import { renderReportImage } from "@/lib/reportImage"
import { DEFAULT_APP_NAME, useAppInfoStore } from "@/store/useAppInfoStore"
import { useKitchenTheme } from "@/store/useKitchenTheme"
import type { DietBalance, DietReport, ReportShare } from "@/types"
import "@/styles/kitchen-report.css"

const MOOD_EMOJI: Record<string, string> = { great: "😋", yum: "😋", ok: "😐", meh: "😕", no: "😒" }
const MOOD_LABEL: Record<string, string> = { great: "超满足", yum: "吃得美滋滋", ok: "还行", meh: "不太行", no: "不太满意" }

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

// 荤素搭配三段的配色（与分享长图一致）
const BALANCE_SEGMENTS = [
  { key: "mixed_count", label: "有荤有素", color: "bg-mint" },
  { key: "veg_count", label: "没有荤", color: "report-tone-amber" },
  { key: "meat_count", label: "全是荤", color: "bg-primary" },
] as const

function BalanceCard({ balance }: { balance?: DietBalance }) {
  const total = balance ? balance.mixed_count + balance.meat_count + balance.veg_count : 0
  const vegetables = balance?.vegetables || []
  const shown = vegetables.slice(0, 12)
  return (
    <section className="report-paper-card">
      <h2 className="report-section-title"><Salad size={17} aria-hidden="true" />荤素搭配</h2>
      {!balance || total === 0 ? (
        <div className="py-3 text-center text-xs text-text3">这个周期还没有做饭记录</div>
      ) : (
        <>
          <div className="flex h-3 rounded-full overflow-hidden bg-bg mb-2.5">
            {BALANCE_SEGMENTS.map((s) => balance[s.key] > 0 && (
              <div key={s.key} className={s.color} style={{ width: `${(balance[s.key] / total) * 100}%` }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
            {BALANCE_SEGMENTS.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-xs text-text2">
                <span className={`w-2 h-2 rounded-full ${s.color}`} />
                {s.label} <span className="font-bold text-text">{balance[s.key]}</span> 道
              </span>
            ))}
          </div>
          <div className="text-[13px] text-text2">
            {balance.meals} 顿里有 <span className="font-bold text-mint">{balance.meals_with_veg}</span> 顿吃到了蔬菜
            {vegetables.length > 0 && <>，一共 <span className="font-bold text-text">{vegetables.length}</span> 种</>}
          </div>
          {shown.length > 0 && (
            <div className="report-vegetables">
              {shown.map((v) => (
                <span key={v.name} className="report-vegetable-chip">
                  {v.name}{v.count > 1 && <span className="ml-0.5 opacity-75">×{v.count}</span>}
                </span>
              ))}
              {vegetables.length > shown.length && (
                <span className="px-2.5 py-1 text-xs text-text3">等 {vegetables.length} 种</span>
              )}
            </div>
          )}
          {balance.meals >= 4 && balance.meals_with_veg * 2 < balance.meals && (
            <div className="report-advice">
              有一半以上的顿没吃到蔬菜，下次点菜可以加一道青菜
            </div>
          )}
          <div className="text-[11px] text-text3 mt-2.5">按菜谱主料算；蛋和豆腐不算荤，葱姜蒜、香菜、干辣椒不算一份蔬菜</div>
        </>
      )}
    </section>
  )
}

// 下载/分享用的文件名：应用名可在后台自定义，去掉文件名里不允许的字符
function reportFileName(report: DietReport, appName: string) {
  const safeName = (appName || DEFAULT_APP_NAME).replace(/[\\/:*?"<>|\s]+/g, "") || DEFAULT_APP_NAME
  return `${safeName}-${report.range === "month" ? "本月" : "本周"}饮食报告-${report.end_date || ""}.png`
}

// 分享长图弹层：内嵌 canvas 预览 + 保存图片 + 系统分享（支持的浏览器）
function ReportShareSheet({ report, appName, onClose }: { report: DietReport; appName: string; onClose: () => void }) {
  const theme = useKitchenTheme((state) => state.theme)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [shareFile, setShareFile] = useState<File | null>(null)
  const canShareFile = !!shareFile && typeof navigator.canShare === "function" && navigator.canShare({ files: [shareFile] })

  // 弹层打开后生成分享长图，并复制到预览画布
  useEffect(() => {
    const target = canvasRef.current
    if (!target) return
    let cancelled = false
    try {
      const rendered = renderReportImage(report, appName)
      target.width = rendered.width
      target.height = rendered.height
      const ctx = target.getContext("2d")
      if (ctx) ctx.drawImage(rendered, 0, 0)
      // 预先生成 PNG 文件：系统分享要在点击时同步调用，不能点了之后再等 toBlob
      rendered.toBlob((blob) => {
        if (!cancelled && blob) setShareFile(new File([blob], reportFileName(report, appName), { type: "image/png" }))
      }, "image/png")
    } catch (err) {
      // 生成失败不让弹层崩溃：提示用户并禁用保存
      console.error("生成分享图失败:", err)
      // 经微任务延后 setState：effect 内同步 setFailed 会触发 react-hooks 静态检查报错
      queueMicrotask(() => {
        setFailed(true)
        toast.error("生成图片失败，请重试")
      })
    }
    return () => { cancelled = true }
  }, [report, appName])

  // 系统分享（手机上可直接发给家人或存相册）；用户取消分享不算失败
  const handleShare = async () => {
    if (!shareFile) return
    try {
      await navigator.share({ files: [shareFile] })
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") toast.error("分享失败，可以先保存图片")
    }
  }

  // canvas.toBlob 导出 PNG，用临时 <a download> 触发下载
  const handleSave = () => {
    const canvas = canvasRef.current
    if (!canvas || saving) return
    setSaving(true)
    try {
      canvas.toBlob((blob) => {
        setSaving(false)
        if (!blob) {
          toast.error("生成图片失败，请重试")
          return
        }
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = reportFileName(report, appName)
        document.body.appendChild(a)
        a.click()
        a.remove()
        // 稍后释放临时 URL，等浏览器启动下载
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        toast.success("图片已保存")
      }, "image/png")
    } catch (err) {
      console.error("导出分享图失败:", err)
      setSaving(false)
      toast.error("保存失败，请重试")
    }
  }

  return (
    <KitchenSheet
      title="分享饮食报告"
      theme={theme}
      icon={<Share2 size={18} />}
      onClose={onClose}
      closeDisabled={saving}
      footer={<>
        <button onClick={onClose} disabled={saving}>关闭</button>
        <button onClick={handleSave} disabled={saving || failed} className="is-ink flex items-center justify-center gap-1.5 whitespace-nowrap">
          <Download size={16} className="shrink-0 max-[360px]:hidden" aria-hidden="true" />
          {saving ? "保存中…" : "保存图片"}
        </button>
        {canShareFile && !failed && (
          <button onClick={handleShare} disabled={saving} className="flex items-center justify-center gap-1.5">
            <Share2 size={16} aria-hidden="true" />分享
          </button>
        )}
      </>}
    >
      <p className="kitchen-sheet-hint mb-4">保存长图，分享这段时间的下厨成果</p>
      <div className="rounded border border-border bg-bg p-2">
        {failed ? (
          <p role="alert" className="w-full h-44 flex items-center justify-center text-sm text-text3">图片生成失败，请关闭后重试</p>
        ) : (
          <canvas ref={canvasRef} className="w-full rounded block" role="img" aria-label="饮食报告长图预览" />
        )}
      </div>
    </KitchenSheet>
  )
}

export default function Report() {
  const navigate = useNavigate()
  const appName = useAppInfoStore((s) => s.appName)
  const [range, setRange] = useState<"week" | "month">("week")
  const [shareOpen, setShareOpen] = useState(false)
  const { data: report, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: ["report", range],
    queryFn: () => reportApi.get(range),
  })

  const activityDelta = (report?.cook_days ?? 0) - (report?.prev_cook_days ?? 0)

  return (
    <div className="animate-fadeUp kitchen-report">
      <PageHeader
        title="饮食报告"
        subtitle="看看这段时间吃得怎么样"
        onBack={() => navigate(-1)}
        actions={
          <div className="flex items-center gap-2">
            {/* report 未加载完时禁用，避免空数据生成 */}
            <HeaderIconButton
              onClick={() => setShareOpen(true)}
              disabled={!report}
              aria-label="分享报告"
              className="disabled:opacity-40 disabled:pointer-events-none"
            >
              <Share2 size={17} strokeWidth={2.4} />
            </HeaderIconButton>
          </div>
        }
      />

      <div className="px-5 py-4 max-w-[640px] mx-auto pb-24">
        <div className="report-period-row">
          <div className="report-period-switch" role="group" aria-label="报告周期">
            {(["week", "month"] as const).map((r) => (
              <button type="button" key={r} onClick={() => setRange(r)} aria-pressed={range === r}>
                {r === "week" ? "本周" : "本月"}
              </button>
            ))}
          </div>
          {report && <span className="report-date-range">{report.start_date} — {report.end_date}</span>}
        </div>
        {isPending && (
          <div role="status" className="report-paper-card text-center">
            <div className="text-sm text-text3">正在读取{range === "week" ? "本周" : "本月"}饮食报告…</div>
          </div>
        )}
        {isError && (
          <div role="alert" className="report-paper-card text-center">
            <div className="text-[15px] font-bold mb-1">{report ? "报告暂时无法更新" : "饮食报告加载失败"}</div>
            <div className="text-xs text-text2">{report ? "下方保留上次读取的报告，可以重试更新。" : "请检查网络后重试，做饭记录不会丢失。"}</div>
            <button type="button" disabled={isFetching} onClick={() => { void refetch() }} className="text-sm font-bold text-primary mt-3 disabled:opacity-50">
              {isFetching ? "正在重试…" : "重新加载报告"}
            </button>
          </div>
        )}
        {report && (
          <>
            {/* 做饭活跃度 */}
            <section className="report-paper-card report-hero">
              <div className="flex items-end justify-between mb-1">
                <div>
                  <div className="text-[13px] text-text2 mb-0.5">这个{range === "week" ? "周" : "月"}下厨</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="report-cook-days">{report.cook_days}</span>
                    <span className="text-sm font-semibold text-text2">天</span>
                  </div>
                </div>
                <div className={`report-delta-stamp ${activityDelta > 0 ? "is-up" : ""}`}>
                  {activityDelta > 0 ? `↑ 比上${range === "week" ? "周" : "月"}多 ${activityDelta} 天` : activityDelta < 0 ? `↓ 比上${range === "week" ? "周" : "月"}少 ${-activityDelta} 天` : `和上${range === "week" ? "周" : "月"}持平`}
                </div>
              </div>
              <div className="text-[11px] text-text3 mt-1.5">
                共 {report.total_meals} 顿（午 {report.lunch_count} · 晚 {report.dinner_count}）· 做了 {report.distinct_dishes} 道不同的菜
              </div>
            </section>

            <div className="report-paper-card report-stats">
              <div>
                <div className="text-xl font-extrabold text-primary">{report.repeat_rate}%</div>
                <div className="text-[11px] text-text2 mt-0.5">复做率</div>
              </div>
              <div>
                <div className="text-xl font-extrabold text-mint">{report.new_dish_rate}%</div>
                <div className="text-[11px] text-text2 mt-0.5">新菜尝试</div>
              </div>
              <div>
                <div className="report-rating text-xl font-extrabold">
                  {report.avg_rating > 0 ? report.avg_rating.toFixed(1) : "-"}
                </div>
                <div className="text-[11px] text-text2 mt-0.5">平均评分</div>
              </div>
            </div>

            {/* 家常菜 Top */}
            <section className="report-paper-card">
              <h2 className="report-section-title"><Trophy size={17} aria-hidden="true" />最常做的菜</h2>
              {report.top_dishes.length === 0 ? (
                <div className="py-3 text-center text-xs text-text3">这个周期还没有做饭记录</div>
              ) : (
                <div className="flex flex-col">
                  {report.top_dishes.map((d, i) => (
                    <button
                      type="button"
                      key={d.dish_id}
                      onClick={() => navigate(`/dishes/${d.dish_id}`)}
                      className="report-top-dish"
                    >
                      <span className={`report-rank ${i < 3 ? "is-top" : ""}`}>
                        {i + 1}
                      </span>
                      <span className="report-dish-name">{d.dish_name}</span>
                      <span className="report-dot-leader" aria-hidden="true" />
                      <span className="text-xs font-bold text-primary shrink-0">{d.count} 次</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <BalanceCard balance={report.balance} />

            {/* 口味 & 分类分布 */}
            <section className="report-paper-card">
              <h2 className="report-section-title"><Flame size={17} aria-hidden="true" />口味偏好</h2>
              <ShareBars shares={report.taste_shares} tone="primary" />
            </section>

            <section className="report-paper-card">
              <h2 className="report-section-title"><Utensils size={17} aria-hidden="true" />菜系分布</h2>
              <ShareBars shares={report.category_shares} tone="mint" />
            </section>

            {/* 心情 */}
            {report.mood_shares.length > 0 && (
              <section className="report-paper-card">
                <h2 className="report-section-title"><Heart size={17} aria-hidden="true" />吃饭心情</h2>
                <div className="report-moods">
                  {report.mood_shares.map((m) => (
                    <div key={m.name} className="report-mood">
                      <div className="report-mood-icon" aria-hidden="true">{MOOD_EMOJI[m.name] || "🍽"}</div>
                      <div className="text-[11px] font-semibold text-text2">{MOOD_LABEL[m.name] || m.name}</div>
                      <div className="text-[11px] text-text3">{m.count} 天</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {shareOpen && report && (
        <ReportShareSheet report={report} appName={appName} onClose={() => setShareOpen(false)} />
      )}
    </div>
  )
}
