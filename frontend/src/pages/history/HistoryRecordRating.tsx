import KitchenSheet from "@/components/KitchenSheet"
import { Star } from "lucide-react"
import "@/styles/kitchen-memories.css"
import { moodOptions } from "@/pages/history/model"
import type { useRecordRatingEditor } from "@/pages/history/useRecordRatingEditor"
type Props = {
  editor: Pick<
    ReturnType<typeof useRecordRatingEditor>,
    | "closeRating"
    | "submitRating"
    | "ratingMood"
    | "ratingUploading"
    | "ratingSaving"
    | "ratingRecord"
    | "ratingNotice"
    | "setRatingMood"
    | "setRatingStars"
    | "ratingStars"
    | "ratingRemark"
    | "setRatingRemark"
    | "ratingPhoto"
    | "removeRatingPhoto"
    | "handleRatingPhotoUpload"
  >
  theme: "day" | "night"
  isAdminLoggedIn: boolean
}
export default function HistoryRecordRating({ editor, theme, isAdminLoggedIn }: Props) {
  const {
    closeRating,
    submitRating,
    ratingMood,
    ratingUploading,
    ratingSaving,
    ratingRecord,
    ratingNotice,
    setRatingMood,
    setRatingStars,
    ratingStars,
    ratingRemark,
    setRatingRemark,
    ratingPhoto,
    removeRatingPhoto,
    handleRatingPhotoUpload
  } = editor
  if (!ratingRecord) return null
  return (
    <KitchenSheet
      title="这道菜怎么样？"
      theme={theme}
      icon={<Star size={19} />}
      onClose={closeRating}
      className="kitchen-rating-sheet"
      footer={
        <button
          onClick={submitRating}
          disabled={!ratingMood || ratingUploading || ratingSaving}
          className="is-ink"
        >
          {ratingUploading ? "照片上传中…" : ratingSaving ? "正在保存…" : "保存评价"}
        </button>
      }
    >
      <p className="kitchen-sheet-context">
        <strong>{ratingRecord.dish_name}</strong>
        <span>
          {ratingRecord.meal_date} · {ratingRecord.meal_type === "lunch" ? "午市" : "晚市"}
        </span>
      </p>
      {ratingNotice && (
        <p role="alert" className="kitchen-sheet-hint mb-3 text-red">
          {ratingNotice}
        </p>
      )}
      <div className="grid grid-cols-3 gap-2 mb-5">
        {moodOptions.map((m) => (
          <button
            key={m.key}
            onClick={() => setRatingMood(m.key)}
            disabled={ratingSaving}
            className={`flex flex-col items-center gap-1.5 py-3 px-1 rounded border-2 transition-all active:scale-90 ${ratingMood === m.key ? "border-primary bg-primary-light" : "border-transparent bg-bg"}`}
          >
            <span className="text-3xl">{m.emoji}</span>
            <span
              className={`text-xs font-medium ${ratingMood === m.key ? "text-primary" : "text-text2"}`}
            >
              {m.label}
            </span>
          </button>
        ))}
      </div>
      <div className="mb-5">
        <div className="text-xs text-text2 font-semibold mb-2">打分（可选，再点一次取消）</div>
        <div className="flex items-center gap-1.5">
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              type="button"
              aria-label={`${s} 星`}
              disabled={ratingSaving}
              onClick={() => setRatingStars((cur) => (cur === s ? 0 : s))}
              className="w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90"
            >
              <Star
                size={24}
                className={s <= ratingStars ? "text-yellow fill-yellow" : "text-text4"}
              />
            </button>
          ))}
          {ratingStars > 0 && (
            <span className="ml-1 text-xs font-semibold text-text2">{ratingStars} 分</span>
          )}
        </div>
      </div>
      <div className="mb-5">
        <div className="text-xs text-text2 font-semibold mb-2">备注（可选）</div>
        <textarea
          value={ratingRemark}
          disabled={ratingSaving}
          onChange={(e) => setRatingRemark(e.target.value)}
          placeholder="这道菜怎么样..."
          rows={2}
          className="w-full p-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm resize-none focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition-all"
        />
      </div>
      <div className="mb-5">
        <div className="text-xs text-text2 font-semibold mb-2">成品照（可选，限1张）</div>
        {ratingPhoto ? (
          <div className="relative w-20 h-20 rounded-[10px] overflow-hidden border border-border">
            <img src={ratingPhoto} alt="" className="w-full h-full object-cover" />
            <button
              onClick={removeRatingPhoto}
              aria-label="移除成品照"
              disabled={ratingSaving}
              className="absolute top-0.5 right-0.5 w-6 h-6 rounded-full bg-black/50 text-white text-xs flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="上传成品照"
            onClick={handleRatingPhotoUpload}
            disabled={ratingUploading || ratingSaving}
            className={`w-20 h-20 rounded-[10px] border-2 border-dashed border-border2 flex flex-col items-center justify-center cursor-pointer transition-all active:border-primary active:text-primary disabled:opacity-50 ${isAdminLoggedIn ? "text-text3" : "text-text4 bg-bg/60"}`}
          >
            <span className="text-xl leading-none">+</span>
            <span className="text-[11px]" role="status">
              {ratingUploading ? "上传中…" : "添加"}
            </span>
          </button>
        )}
      </div>
    </KitchenSheet>
  )
}
