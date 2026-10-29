import { useState } from "react"

// SafeImage 列表图片：默认懒加载（滚到附近才下载），加载失败或没有地址时显示 fallback，
// 不再出现破图标和溢出的 alt 文字。eager 用于首屏大图（如菜品详情头图）。
export default function SafeImage({ src, alt, className, fallback, eager }: {
  src: string | null | undefined
  alt: string
  className?: string
  fallback: React.ReactNode
  eager?: boolean
}) {
  // 记住失败的是哪个地址：同一个组件换了图片地址后重新尝试
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) return <>{fallback}</>
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailedSrc(src)}
    />
  )
}
