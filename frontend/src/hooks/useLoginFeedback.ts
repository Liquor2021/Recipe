import { useCallback, useEffect, useState } from "react"
import { getLoginLockMessage, getLoginRetrySeconds, type LoginError } from "@/lib/loginError"

export function useLoginFeedback() {
  const [error, setError] = useState<LoginError | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState(0)

  const showError = useCallback((feedback: LoginError) => {
    setError(feedback)
    setRemainingSeconds(getLoginRetrySeconds(feedback.retryAt, Date.now()))
  }, [])

  const clearError = useCallback(() => {
    // 编辑输入框不能抹掉服务器给出的锁定时间。
    setError((current) => current?.retryAt === undefined ? null : current)
  }, [])

  const retryAt = error?.retryAt
  useEffect(() => {
    if (retryAt === undefined) return
    const timer = window.setInterval(() => {
      // 按截止时间计算，后台标签页/休眠后不会继续等漏掉的 tick。
      const seconds = getLoginRetrySeconds(retryAt, Date.now())
      setRemainingSeconds(seconds)
      if (seconds === 0) {
        setError((current) => current?.retryAt === retryAt ? null : current)
        window.clearInterval(timer)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [retryAt])

  return {
    error,
    isLocked: remainingSeconds > 0,
    message: remainingSeconds > 0 ? getLoginLockMessage(remainingSeconds) : error?.message,
    showError,
    clearError,
  }
}
