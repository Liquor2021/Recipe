import { useState, useRef, useEffect } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { recordsApi, uploadApi, getUploadErrorMessage } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import type { MealRecord } from "@/types"
import toast from "react-hot-toast"
import { type RatingSession } from "@/pages/history/model"
import { createHistoryCache } from "@/pages/history/cache"
export function useRecordRatingEditor() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const isAdminLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const { refreshMealQueries, ratingWritePending, syncSavedRecord } = createHistoryCache(qc)
  const [ratingRecord, setRatingRecord] = useState<MealRecord | null>(null)
  const [ratingMood, setRatingMood] = useState<string>("")
  // 1-5 星，0 = 未打分（报告的平均评分、菜品详情的评分趋势用它）
  const [ratingStars, setRatingStars] = useState(0)
  const [ratingRemark, setRatingRemark] = useState("")
  const [ratingPhoto, setRatingPhoto] = useState("")
  const ratingSession = useRef<RatingSession | null>(null)
  const [ratingUploading, setRatingUploading] = useState(false)
  const [ratingSaving, setRatingSaving] = useState(false)
  const [ratingNotice, setRatingNotice] = useState("")
  const updateMut = useMutation({
    mutationKey: ["history-rating", "record"],
    scope: { id: "history-record-rating" },
    mutationFn: ({ id, data }: { id: number; data: Partial<MealRecord>; session: RatingSession }) =>
      recordsApi.update(id, data),
    onSuccess: async (saved, { session }) => {
      await syncSavedRecord(saved)
      void refreshMealQueries()
      if (ratingSession.current !== session) return
      toast.success("评价已保存")
      closeRating()
    },
    onError: (error, { session }) => {
      if (ratingSession.current === session)
        setRatingNotice(getUploadErrorMessage(error, "评价失败，草稿已保留，请重试"))
    },
    onSettled: (_data, _err, { session }) => {
      session.saving = false
      if (ratingSession.current === session) setRatingSaving(false)
    }
  })
  function openRating(r: MealRecord) {
    if (r.status !== "completed") return
    if (ratingWritePending("record", String(r.id))) {
      toast("这条评价正在保存，请稍后再打开")
      return
    }
    // 即使缓存通知尚未触发列表重绘，也以刚保存的实际响应初始化。
    r = qc.getQueryData<MealRecord>(["record", r.id]) || r
    ratingSession.current = {
      target: String(r.id),
      photos: r.photo ? [r.photo] : [],
      uploading: false,
      saving: false
    }
    setRatingNotice("")
    setRatingUploading(false)
    setRatingSaving(false)
    setRatingRecord(r)
    setRatingMood(r.mood || "")
    setRatingStars(r.rating || 0)
    setRatingRemark(r.remark || "")
    setRatingPhoto(r.photo || "")
  }
  function closeRating() {
    ratingSession.current = null
    setRatingRecord(null)
    setRatingUploading(false)
    setRatingSaving(false)
  }
  function submitRating() {
    const session = ratingSession.current
    if (
      !ratingRecord ||
      !ratingMood ||
      !session ||
      session.target !== String(ratingRecord.id) ||
      session.uploading ||
      session.saving ||
      ratingWritePending("record", session.target)
    )
      return
    session.saving = true
    setRatingSaving(true)
    setRatingNotice("")
    updateMut.mutate({
      id: ratingRecord.id,
      session,
      data: {
        mood: ratingMood,
        rating: ratingStars,
        remark: ratingRemark,
        photo: session.photos[0] || ""
      }
    })
  }
  function handleRatingPhotoUpload() {
    const session = ratingSession.current
    if (!session || session.uploading || session.saving) return
    if (!isAdminLoggedIn) {
      toast.error("上传照片需要先进入管理模式")
      navigate("/admin/login")
      return
    }
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/jpg,image/jpeg,image/png,image/webp"
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file || ratingSession.current !== session || session.uploading || session.saving) return
      session.uploading = true
      setRatingUploading(true)
      setRatingNotice("")
      try {
        const res = await uploadApi.image(file)
        if (ratingSession.current !== session) return
        const url = res.data.data.url
        if (url) {
          session.photos = [url]
          setRatingPhoto(url)
        } else setRatingNotice("上传返回异常，请重试")
      } catch (err) {
        if (ratingSession.current === session) setRatingNotice(getUploadErrorMessage(err))
      } finally {
        session.uploading = false
        if (ratingSession.current === session) setRatingUploading(false)
      }
    }
    input.click()
  }
  function removeRatingPhoto() {
    const session = ratingSession.current
    if (!session || session.uploading || session.saving) return
    session.photos = []
    setRatingPhoto("")
  }
  useEffect(
    () => () => {
      ratingSession.current = null
      setRatingRecord(null)
      setRatingUploading(false)
      setRatingSaving(false)
    },
    [location.pathname]
  )
  return {
    ratingRecord,
    ratingMood,
    setRatingMood,
    ratingStars,
    setRatingStars,
    ratingRemark,
    setRatingRemark,
    ratingPhoto,
    ratingUploading,
    ratingSaving,
    ratingNotice,
    openRating,
    closeRating,
    submitRating,
    handleRatingPhotoUpload,
    removeRatingPhoto
  }
}
