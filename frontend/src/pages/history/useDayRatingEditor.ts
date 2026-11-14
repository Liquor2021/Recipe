import { useState, useRef, useEffect } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { dayRatingApi, uploadApi, getUploadErrorMessage } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import toast from "react-hot-toast"
import type { MealMood } from "@/lib/mealRating"
import {
  type DayRatingSession,
  type DayRatingConflict,
  isDayRatingConflict,
  parsePhotos
} from "@/pages/history/model"
import { createHistoryCache } from "@/pages/history/cache"
export function useDayRatingEditor({
  selectedDateKey,
  canRateSelectedDay
}: {
  selectedDateKey: string
  canRateSelectedDay: boolean
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const isAdminLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const { ratingWritePending, syncSavedDayRating } = createHistoryCache(qc)
  const [showMealRating, setShowMealRating] = useState(false)
  const [mealRatingDate, setMealRatingDate] = useState("")
  const [mealRatingMood, setMealRatingMood] = useState<string>("")
  const [mealRatingRemark, setMealRatingRemark] = useState("")
  const [mealPhotos, setMealPhotos] = useState<string[]>([])
  const mealSession = useRef<DayRatingSession | null>(null)
  const [mealUploadRemaining, setMealUploadRemaining] = useState(0)
  const [mealSaving, setMealSaving] = useState(false)
  const [mealNotice, setMealNotice] = useState("")
  const [mealReading, setMealReading] = useState(false)
  const [mealReady, setMealReady] = useState(false)
  const [mealReadError, setMealReadError] = useState("")
  const [mealConflict, setMealConflict] = useState<DayRatingConflict | null>(null)
  const dayRatingMut = useMutation({
    mutationKey: ["history-rating", "day"],
    scope: { id: "history-day-rating" },
    mutationFn: ({
      data
    }: {
      data: {
        meal_date: string
        expected_version: string
        mood: string
        remark: string
        photos: string
      }
      session: DayRatingSession
    }) => dayRatingApi.create(data),
    onSuccess: async (saved, { session }) => {
      await syncSavedDayRating(saved)
      qc.invalidateQueries({ queryKey: ["day-rating"] })
      qc.invalidateQueries({ queryKey: ["day-ratings"] })
      qc.invalidateQueries({ queryKey: ["photo-wall"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      if (mealSession.current !== session) return
      toast.success("今日评价已保存")
      closeMealRating()
    },
    onError: async (error, { session }) => {
      if (mealSession.current !== session) return
      setMealConflict({
        latest: null,
        reason: isDayRatingConflict(error) ? "changed" : "unconfirmed"
      })
      await readMealRating(session, false)
      if (mealSession.current === session) setMealNotice("评价未确认，草稿已保留，请核对后继续")
    },
    onSettled: (_data, _err, { session }) => {
      session.saving = false
      if (mealSession.current === session) setMealSaving(false)
    }
  })
  function openMealRating(initialMood?: MealMood) {
    if (!canRateSelectedDay) return
    if (ratingWritePending("day", selectedDateKey)) {
      toast("这天的评价或照片正在保存，请稍后再打开")
      return
    }
    const session: DayRatingSession = {
      target: selectedDateKey,
      photos: [],
      version: "",
      readToken: 0,
      uploading: false,
      saving: false,
      initialMood
    }
    mealSession.current = session
    setMealNotice("")
    setMealRatingDate(selectedDateKey)
    setMealUploadRemaining(0)
    setMealSaving(false)
    setMealConflict(null)
    setMealReady(false)
    setMealRatingMood("")
    setMealRatingRemark("")
    setMealPhotos([])
    setShowMealRating(true)
    void readMealRating(session, true)
  }
  async function readMealRating(session: DayRatingSession, initialize: boolean) {
    const token = ++session.readToken
    setMealReading(true)
    setMealReadError("")
    try {
      const latest = await dayRatingApi.getFresh(session.target)
      if (!latest || latest.meal_date !== session.target || latest.version?.length !== 64)
        throw new Error("评价数据不完整，请刷新后重试")
      if (mealSession.current !== session || session.readToken !== token) return
      if (initialize) {
        session.version = latest.version
        session.photos = parsePhotos(latest.photos)
        setMealRatingMood(session.initialMood ?? latest.mood ?? "")
        setMealRatingRemark(latest.remark || "")
        setMealPhotos(session.photos)
        setMealReady(true)
      } else {
        setMealConflict((current) => (current ? { ...current, latest } : null))
      }
    } catch (error) {
      if (mealSession.current === session && session.readToken === token) {
        setMealReadError(getUploadErrorMessage(error, "最新评价读取失败，请重试"))
      }
    } finally {
      if (mealSession.current === session && session.readToken === token) setMealReading(false)
    }
  }
  function resolveMealConflict(keepDraft: boolean) {
    const session = mealSession.current
    const latest = mealConflict?.latest
    if (!session || !latest || mealReading || session.saving) return
    session.version = latest.version
    if (!keepDraft) {
      session.photos = parsePhotos(latest.photos)
      setMealRatingMood(latest.mood || "")
      setMealRatingRemark(latest.remark || "")
      setMealPhotos(session.photos)
    }
    setMealConflict(null)
    setMealReadError("")
    setMealNotice(keepDraft ? "已核对最新内容，请检查草稿后再保存" : "已载入最新评价")
  }
  function closeMealRating() {
    mealSession.current = null
    setShowMealRating(false)
    setMealPhotos([])
    setMealUploadRemaining(0)
    setMealSaving(false)
    setMealReading(false)
    setMealReady(false)
    setMealReadError("")
    setMealConflict(null)
  }
  function submitMealRating() {
    const session = mealSession.current
    if (
      !mealRatingMood ||
      !session ||
      !session.version ||
      mealReading ||
      mealReadError ||
      mealConflict ||
      session.uploading ||
      session.saving ||
      ratingWritePending("day", session.target)
    )
      return
    session.saving = true
    setMealSaving(true)
    setMealNotice("")
    dayRatingMut.mutate({
      session,
      data: {
        meal_date: session.target,
        expected_version: session.version,
        mood: mealRatingMood,
        remark: mealRatingRemark,
        photos: JSON.stringify(session.photos)
      }
    })
  }
  function handlePhotoUpload() {
    const session = mealSession.current
    if (
      !session ||
      !session.version ||
      mealReading ||
      mealReadError ||
      mealConflict ||
      session.uploading ||
      session.saving
    )
      return
    if (!isAdminLoggedIn) {
      toast.error("上传照片需要先进入管理模式")
      navigate("/admin/login")
      return
    }
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.accept = "image/jpg,image/jpeg,image/png,image/webp"
    input.onchange = async () => {
      const files = Array.from(input.files || [])
      if (
        files.length === 0 ||
        mealSession.current !== session ||
        session.uploading ||
        session.saving
      )
        return
      const remaining = 9 - session.photos.length
      if (remaining <= 0) {
        setMealNotice("最多上传9张照片")
        return
      }
      const toUpload = files.slice(0, remaining)
      setMealNotice("")
      if (files.length > remaining) {
        setMealNotice(`已选${files.length}张，仅上传前${remaining}张`)
      }
      // 同一草稿一次只处理一批文件；同步占用上传状态，避免连点绕过 9 张限制。
      session.uploading = true
      setMealUploadRemaining(toUpload.length)
      let failed = 0
      let lastErrMsg = ""
      try {
        for (const [index, file] of toUpload.entries()) {
          if (mealSession.current !== session) return
          try {
            const res = await uploadApi.image(file)
            if (mealSession.current !== session) return
            const url = res.data.data.url
            if (url) {
              session.photos = [...session.photos, url]
              setMealPhotos(session.photos)
            } else {
              failed++
            }
          } catch (err) {
            if (mealSession.current !== session) return
            failed++
            lastErrMsg = getUploadErrorMessage(err)
          }
          setMealUploadRemaining(toUpload.length - index - 1)
        }
        if (failed > 0 && mealSession.current === session)
          setMealNotice(lastErrMsg || `${failed}张上传失败`)
      } finally {
        session.uploading = false
        if (mealSession.current === session) setMealUploadRemaining(0)
      }
    }
    input.click()
  }
  function removeMealPhoto(idx: number) {
    const session = mealSession.current
    if (!session || session.saving || mealReading || mealReadError || mealConflict) return
    session.photos = session.photos.filter((_, i) => i !== idx)
    setMealPhotos(session.photos)
  }
  useEffect(
    () => () => {
      mealSession.current = null
      setShowMealRating(false)
      setMealUploadRemaining(0)
      setMealSaving(false)
      setMealReading(false)
      setMealReady(false)
      setMealReadError("")
      setMealConflict(null)
    },
    [location.pathname]
  )
  return {
    showMealRating,
    mealRatingDate,
    mealRatingMood,
    setMealRatingMood,
    mealRatingRemark,
    setMealRatingRemark,
    mealPhotos,
    mealSession,
    mealUploadRemaining,
    mealSaving,
    mealNotice,
    mealReading,
    mealReady,
    mealReadError,
    mealConflict,
    openMealRating,
    readMealRating,
    resolveMealConflict,
    closeMealRating,
    submitMealRating,
    handlePhotoUpload,
    removeMealPhoto
  }
}
