import { useState, useMemo } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { photoWallApi } from "@/api"
import PhotoViewer from "@/components/PhotoViewer"
import PageHeader from "@/components/PageHeader"
import type { PhotoWallDay } from "@/types"
import { Images } from "lucide-react"
import { thumbUrl } from "@/lib/dishImage"
import "@/styles/kitchen-memories.css"

const moodEmojiMap: Record<string, string> = { yum: "😋", ok: "😐", no: "😵", great: "😋", meh: "😕" }
const moodLabelMap: Record<string, string> = { yum: "好吃", ok: "一般", no: "不想再吃", great: "超满足", meh: "不太行" }
const dayMoodLabelMap: Record<string, string> = { great: "超满足的一天", ok: "还行的一天", meh: "不太行的一天" }
const homeMoodEmojiMap: Record<string, string> = { happy: "😊", tired: "😫", lazy: "😌", spicy: "🤤", healthy: "🌿" }
const homeMoodLabelMap: Record<string, string> = { happy: "开心", tired: "疲惫", lazy: "想偷懒", spicy: "想吃辣", healthy: "想养生" }

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

function formatDate(dateStr: string): { month: string; day: string; year: string; weekday: string } {
  const [y, m, d] = dateStr.split("-").map(Number)
  const wd = new Date(y, m - 1, d).getDay()
  return {
    year: String(y),
    month: String(m).padStart(2, "0"),
    day: String(d).padStart(2, "0"),
    weekday: weekdays[wd] || "",
  }
}

// 给每张照片一个轻微、稳定的倾斜角度，营造手贴照片的回忆感
function tiltFor(seed: number): number {
  const angles = [-2.5, 1.8, -1.2, 2.2, -2, 1.4, -1.6, 2.6]
  return angles[seed % angles.length]
}

function MemoryDay({ day, onOpen }: { day: PhotoWallDay; onOpen: (photos: string[], idx: number) => void }) {
  const navigate = useNavigate()
  const f = formatDate(day.meal_date)
  const photos = day.photos || []
  const records = day.records || []
  const cover = photos.slice(0, 3)
  const extra = photos.length - cover.length

  return (
    <article className="memory-day">
      {/* 时间线圆点 */}
      <span className="memory-timeline-dot" aria-hidden="true" />

      {/* 日期标题 */}
      <div className="memory-date-row">
        <time dateTime={day.meal_date} className="memory-date">{f.month}.{f.day}</time>
        <span className="memory-weekday">{f.year} · {f.weekday}</span>
        {(day.home_mood || day.day_mood) && (
          <div className="memory-moods">
            {day.home_mood && (
              <span className="memory-mood-stamp">
                <span className="text-sm">{homeMoodEmojiMap[day.home_mood] || "😃"}</span>
                {homeMoodLabelMap[day.home_mood] || "心情"}
              </span>
            )}
            {day.day_mood && (
              <span className="memory-mood-stamp">
                <span className="text-sm">{moodEmojiMap[day.day_mood] || "🍚"}</span>
                {dayMoodLabelMap[day.day_mood] || "记录"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 照片拼贴卡片 */}
      <div className="memory-day-content">
        <div className={`memory-photos ${cover.length === 1 ? "is-single" : ""}`}>
          {cover.map((p, i) => (
            <button
              key={i}
              onClick={() => onOpen(photos, i)}
              aria-label={`${day.meal_date} 第 ${i + 1} 张照片${i === cover.length - 1 && extra > 0 ? `，另有 ${extra} 张` : ""}`}
              className="memory-polaroid"
              style={{ transform: `rotate(${tiltFor(day.meal_date.length + i)}deg)` }}
            >
                <span className="memory-photo-frame">
                  <img src={thumbUrl(p)} alt="" className="w-full h-full object-cover" loading="lazy" />
                  {i === cover.length - 1 && extra > 0 && <span className="memory-more-photos">+{extra}</span>}
                </span>
                <span className="memory-photo-caption">{f.month}.{f.day} · {String(i + 1).padStart(2, "0")}</span>
            </button>
          ))}
        </div>

        {/* 当日整体备注 */}
        {day.day_remark && (
          <blockquote className="memory-day-quote">“{day.day_remark}”</blockquote>
        )}

        {/* 当日菜品评价 */}
        {records.length > 0 && (
          <div className="memory-meal-ledger">
            {records.map((r, i) => (
              <button
                key={i}
                onClick={() => navigate(`/dishes/${r.dish_id}`)}
                className="memory-meal-row"
              >
                <span className="memory-meal-type">{r.meal_type === "lunch" ? "午市" : "晚市"}</span>
                <strong>{r.dish_name}</strong>
                <span className="memory-dot-leader" aria-hidden="true" />
                {r.mood && (
                  <span className="memory-meal-mood">
                    <span className="text-sm">{moodEmojiMap[r.mood]}</span>
                    <span className="text-[11px] text-text3">{moodLabelMap[r.mood]}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export default function PhotoWall() {
  const navigate = useNavigate()
  const { data, isPending, isError, isFetching, refetch } = useQuery({ queryKey: ["photo-wall"], queryFn: () => photoWallApi.get() })

  const [viewerPhotos, setViewerPhotos] = useState<string[]>([])
  const [viewerIdx, setViewerIdx] = useState(0)
  const [showViewer, setShowViewer] = useState(false)

  function openViewer(photos: string[], idx: number) {
    setViewerPhotos(photos)
    setViewerIdx(idx)
    setShowViewer(true)
  }

  const days = useMemo(() => data?.days || [], [data])

  return (
    <div className="kitchen-photo-wall animate-fadeUp">
      <PageHeader
        title="照片墙"
        icon={Images}
        meta={data && data.total_photos > 0 ? `${data.total_days} 天 · ${data.total_photos} 张` : undefined}
      />

      <div className="kitchen-memory-body">
        {isError && (
          <div role="alert" className="memory-error">
            <div className="text-sm font-semibold text-text mb-1">{data ? "照片刷新失败" : "照片暂时加载失败"}</div>
            <div className="text-[13px] text-text2 mb-3">{data ? "仍保留上次加载的内容，可以稍后重试。" : "请检查网络后重试。"}</div>
            <button
              onClick={() => { void refetch() }}
              disabled={isFetching}
              className="memory-ink-button"
            >{isFetching ? "正在重试…" : "重新加载"}</button>
          </div>
        )}
        {isPending ? (
          <div role="status" aria-label="正在加载照片" className="flex flex-col gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="pl-12">
                <div className="skeleton h-5 w-28 rounded-md mb-3" />
                <div className="skeleton h-44 w-full rounded-2xl" />
              </div>
            ))}
          </div>
        ) : days.length === 0 ? (isError ? null : (
          <div className="text-center py-20">
            <span className="text-[56px] block mb-4 animate-float">📷</span>
            <div className="text-base font-semibold mb-1.5">还没有回忆照片</div>
            <div className="text-[13px] text-text2 mb-6">在「记录」里给每天的饭菜拍张照<br />日子久了，这里就是你们的回忆墙~</div>
            <button
              onClick={() => navigate("/history")}
              className="memory-ink-button"
            >去记录今天</button>
          </div>
        )) : (
          <>
            <p className="memory-album-intro">「每一餐，都是我们一起走过的日子」</p>
            {/* 时间线 */}
            <div className="memory-timeline">
              <div className="flex flex-col">
                {days.map((day) => (
                  <MemoryDay key={day.meal_date} day={day} onOpen={openViewer} />
                ))}
              </div>
            </div>
            <div className="text-center text-[12px] text-text3 py-6 flex items-center justify-center gap-2">
              <span className="w-8 h-px bg-border2" />
              到这里啦
              <span className="w-8 h-px bg-border2" />
            </div>
          </>
        )}
      </div>

      {showViewer && viewerPhotos.length > 0 && createPortal(
        <PhotoViewer photos={viewerPhotos} idx={viewerIdx} setIdx={setViewerIdx} onClose={() => setShowViewer(false)} />,
        document.body
      )}
    </div>
  )
}
