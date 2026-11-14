import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { dayRatingApi } from "@/api"
import { useAuthStore } from "@/store/useAuthStore"
import type { DayRating } from "@/types"
import toast from "react-hot-toast"
import { isDayRatingConflict, parsePhotos } from "@/pages/history/model"
import { createHistoryCache } from "@/pages/history/cache"
export function useHistoryDayPhotos(selectedDateKey: string) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isAdminLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const { ratingWritePending, syncSavedDayRating } = createHistoryCache(qc)
  const [dayPhotoError, setDayPhotoError] = useState<{
    date: string
    message: string
    ready: boolean
  } | null>(null)
  const [dayPhotoReading, setDayPhotoReading] = useState(false)
  const updateDayPhotosMut = useMutation({
    mutationKey: ["history-rating", "day"],
    mutationFn: (data: { meal_date: string; expected_version: string; photos: string }) =>
      dayRatingApi.create(data),
    onMutate: async (data) => {
      const key = ["day-rating", data.meal_date]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<DayRating>(key)
      qc.setQueryData(key, (old: unknown) => {
        if (!old || typeof old !== "object" || old === null) return old
        const r = old as DayRating
        return { ...r, photos: data.photos }
      })
      return { prev, key }
    },
    onSuccess: async (saved, data) => {
      await syncSavedDayRating(saved)
      qc.invalidateQueries({ queryKey: ["day-rating", data.meal_date] })
      qc.invalidateQueries({ queryKey: ["day-ratings"] })
      qc.invalidateQueries({ queryKey: ["photo-wall"] })
      qc.invalidateQueries({ queryKey: ["achievements"] })
      setDayPhotoError((current) => (current?.date === data.meal_date ? null : current))
      toast.success("照片已删除")
    },
    onError: (error, data, context) => {
      if (context?.prev)
        qc.setQueryData<DayRating>(context.key, (current) =>
          current?.photos === data.photos ? { ...current, photos: context.prev!.photos } : current
        )
      const message = isDayRatingConflict(error)
        ? "照片已变化，已保留最新内容，请重新确认要删除的照片"
        : "照片删除未确认，请重新读取后再操作"
      setDayPhotoError({ date: data.meal_date, message, ready: false })
      toast.error(message)
    },
    // 失败也重新核对服务端（包括已保存但响应丢失），核对完才释放同日写锁。
    onSettled: async (_saved, _err, data) => {
      try {
        const latest = await dayRatingApi.getFresh(data.meal_date)
        await syncSavedDayRating(latest)
        setDayPhotoError((current) =>
          current?.date === data.meal_date
            ? { ...current, message: "照片已更新，请重新确认要删除的照片", ready: true }
            : current
        )
      } catch {
        setDayPhotoError({
          date: data.meal_date,
          message: "最新照片读取失败，重新读取成功后再删除",
          ready: false
        })
      }
    }
  })
  function removeDayPhoto(idx: number, displayed: DayRating) {
    if (dayPhotoReading || (dayPhotoError?.date === selectedDateKey && !dayPhotoError.ready)) return
    if (ratingWritePending("day", selectedDateKey)) {
      toast("这天的评价或照片正在保存，请稍后再试")
      return
    }
    if (!isAdminLoggedIn) {
      toast.error("删除照片需要先进入管理模式")
      navigate("/admin/login")
      return
    }
    if (!displayed.version) {
      setDayPhotoError({
        date: selectedDateKey,
        message: "请先重新读取照片，再确认要删除的照片",
        ready: false
      })
      return
    }
    // 用用户实际看到的照片列表及其版本；缓存更新早于重绘时也不能删错另一张。
    const dayPhotos = parsePhotos(displayed.photos)
    if (idx < 0 || idx >= dayPhotos.length) return
    const updated = dayPhotos.filter((_, i) => i !== idx)
    updateDayPhotosMut.mutate({
      meal_date: selectedDateKey,
      expected_version: displayed.version,
      photos: JSON.stringify(updated)
    })
  }
  async function reloadDayPhotos() {
    const date = selectedDateKey
    if (dayPhotoReading || ratingWritePending("day", date)) return
    setDayPhotoReading(true)
    try {
      const latest = await dayRatingApi.getFresh(date)
      await syncSavedDayRating(latest)
      setDayPhotoError((current) =>
        current?.date === date
          ? { date, message: "照片已更新，请重新确认要删除的照片", ready: true }
          : current
      )
    } catch {
      setDayPhotoError({ date, message: "最新照片读取失败，请重试", ready: false })
    } finally {
      setDayPhotoReading(false)
    }
  }
  return { dayPhotoError, dayPhotoReading, updateDayPhotosMut, removeDayPhoto, reloadDayPhotos }
}
