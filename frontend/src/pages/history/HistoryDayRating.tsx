import KitchenSheet from "@/components/KitchenSheet"
import { NotebookPen } from "lucide-react"
import "@/styles/kitchen-memories.css"
import { thumbUrl } from "@/lib/dishImage"
import { mealMoodOptions } from "@/lib/mealRating"
import { parsePhotos } from "@/pages/history/model"
import type { useDayRatingEditor } from "@/pages/history/useDayRatingEditor"
type Props = {
  review: Pick<
    ReturnType<typeof useDayRatingEditor>,
    | "closeMealRating"
    | "submitMealRating"
    | "mealReady"
    | "mealRatingMood"
    | "mealUploadRemaining"
    | "mealSaving"
    | "mealReading"
    | "mealReadError"
    | "mealConflict"
    | "mealRatingDate"
    | "mealNotice"
    | "mealSession"
    | "readMealRating"
    | "resolveMealConflict"
    | "setMealRatingMood"
    | "mealRatingRemark"
    | "setMealRatingRemark"
    | "handlePhotoUpload"
    | "mealPhotos"
    | "removeMealPhoto"
  >
  theme: "day" | "night"
  isAdminLoggedIn: boolean
}
export default function HistoryDayRating({ review, theme, isAdminLoggedIn }: Props) {
  const {
    closeMealRating,
    submitMealRating,
    mealReady,
    mealRatingMood,
    mealUploadRemaining,
    mealSaving,
    mealReading,
    mealReadError,
    mealConflict,
    mealRatingDate,
    mealNotice,
    mealSession,
    readMealRating,
    resolveMealConflict,
    setMealRatingMood,
    mealRatingRemark,
    setMealRatingRemark,
    handlePhotoUpload,
    mealPhotos,
    removeMealPhoto
  } = review
  return (
    <KitchenSheet
      title="这天吃得怎么样？"
      theme={theme}
      icon={<NotebookPen size={19} />}
      onClose={closeMealRating}
      className="kitchen-rating-sheet"
      footer={
        <button
          onClick={submitMealRating}
          disabled={
            !mealReady ||
            !mealRatingMood ||
            mealUploadRemaining > 0 ||
            mealSaving ||
            mealReading ||
            !!mealReadError ||
            !!mealConflict
          }
          className="is-ink"
        >
          {mealConflict
            ? "核对最新评价后继续"
            : mealUploadRemaining > 0
              ? "照片上传中…"
              : mealSaving
                ? "正在保存…"
                : "保存评价"}
        </button>
      }
    >
      <div className="text-center mb-3 text-[13px] text-text2">
        评价 {mealRatingDate} 的整体用餐感受
      </div>
      {mealNotice && (
        <p role="status" className="kitchen-sheet-hint mb-3">
          {mealNotice}
        </p>
      )}
      {mealReading && (
        <p role="status" className="mb-4 text-center text-sm text-text3">
          正在读取最新评价…
        </p>
      )}
      {mealReadError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-border bg-bg p-3 text-sm text-text2"
        >
          <p>{mealReadError}</p>
          <button
            disabled={mealReading}
            onClick={() => {
              const session = mealSession.current
              if (session) void readMealRating(session, !session.version)
            }}
            className="mt-2 min-h-11 rounded-full bg-card px-4 font-semibold text-primary disabled:opacity-50"
          >
            重新读取评价
          </button>
        </div>
      )}
      {mealConflict && (
        <section
          role="alert"
          className="mb-4 rounded-xl border border-yellow/40 bg-yellow-light p-3 text-sm text-text2"
        >
          <p className="font-semibold text-text">
            {mealConflict.reason === "changed"
              ? "评价或照片已变化，草稿已保留"
              : "保存结果未确认，草稿已保留"}
          </p>
          <p className="mt-1">请核对最新内容，再决定继续编辑草稿或载入最新评价。</p>
          {mealConflict.latest && (
            <>
              <p className="mt-2">
                最新评价：
                {mealMoodOptions.find((option) => option.key === mealConflict.latest!.mood)
                  ?.label || "未评价"}
              </p>
              <p className="mt-1 break-words">最新备注：{mealConflict.latest.remark || "未填写"}</p>
              <p className="mt-1">最新照片：{parsePhotos(mealConflict.latest.photos).length} 张</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {parsePhotos(mealConflict.latest.photos).map((photo, index) => (
                  <img
                    key={`${photo}-${index}`}
                    src={thumbUrl(photo)}
                    alt={`最新照片 ${index + 1}`}
                    className="h-12 w-12 rounded-md object-cover"
                  />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  disabled={mealSaving || mealReading}
                  onClick={() => resolveMealConflict(true)}
                  className="min-h-11 rounded-full bg-primary px-4 font-semibold text-white disabled:opacity-50"
                >
                  保留草稿继续编辑
                </button>
                <button
                  disabled={mealSaving || mealReading}
                  onClick={() => resolveMealConflict(false)}
                  className="min-h-11 rounded-full border border-border bg-card px-4 font-semibold disabled:opacity-50"
                >
                  载入最新评价
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {mealReady && (
        <fieldset
          disabled={mealSaving || mealReading || !!mealReadError || !!mealConflict}
          className="min-w-0"
        >
          <div className="grid grid-cols-3 gap-2 mb-5">
            {mealMoodOptions.map((m) => (
              <button
                key={m.key}
                onClick={() => setMealRatingMood(m.key)}
                disabled={mealSaving}
                className={`flex flex-col items-center gap-1.5 py-3 px-1 rounded border-2 transition-all active:scale-90 ${mealRatingMood === m.key ? "border-primary bg-primary-light" : "border-transparent bg-bg"}`}
              >
                <span className="text-3xl">{m.emoji}</span>
                <span
                  className={`text-xs font-medium ${mealRatingMood === m.key ? "text-primary" : "text-text2"}`}
                >
                  {m.label}
                </span>
              </button>
            ))}
          </div>
          <div className="mb-5">
            <div className="text-xs text-text2 font-semibold mb-2">备注（可选）</div>
            <textarea
              value={mealRatingRemark}
              disabled={mealSaving}
              onChange={(e) => setMealRatingRemark(e.target.value)}
              placeholder="今天这顿饭的整体感受..."
              rows={2}
              className="w-full p-3 rounded-[10px] border-[1.5px] border-border bg-bg text-sm resize-none focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition-all"
            />
          </div>
          <div className="mb-5">
            <div className="text-xs text-text2 font-semibold mb-2">上传照片（可选，最多9张）</div>
            <div className="flex gap-2 items-start">
              <button
                type="button"
                aria-label="上传用餐照片"
                onClick={handlePhotoUpload}
                disabled={mealUploadRemaining > 0 || mealSaving || mealPhotos.length >= 9}
                className={`w-16 h-16 rounded-[10px] border-2 border-dashed border-border2 flex flex-col items-center justify-center cursor-pointer transition-all active:border-primary active:text-primary flex-shrink-0 disabled:opacity-50 ${isAdminLoggedIn ? "text-text3" : "text-text4 bg-bg/60"}`}
              >
                <span className="text-xl leading-none">+</span>
                <span className="text-[11px]" role="status">
                  {mealUploadRemaining > 0 ? "上传中…" : "添加"}
                </span>
              </button>
              <div className="flex gap-2 flex-wrap">
                {mealPhotos.map((p, i) => (
                  <div
                    key={i}
                    className="w-16 h-16 rounded-[10px] overflow-hidden relative bg-bg flex items-center justify-center border border-border"
                  >
                    <img
                      src={thumbUrl(p)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeMealPhoto(i)
                      }}
                      aria-label={`移除第 ${i + 1} 张用餐照片`}
                      disabled={mealSaving}
                      className="absolute top-0.5 right-0.5 w-6 h-6 rounded-full bg-black/50 text-white text-xs flex items-center justify-center active:bg-red"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </fieldset>
      )}
    </KitchenSheet>
  )
}
