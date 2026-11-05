import type { Dish } from "@/types"
import { getDishEmoji, getDishImageUrl, thumbUrl } from "@/lib/dishImage"
import SafeImage from "@/components/SafeImage"

interface DishImageProps {
  dish: Dish
  className?: string
  imgClassName?: string
  emojiSize?: string
  // 默认用列表缩略图；整宽的大卡片（首页推荐、盲盒、转盘结果）传 full 用原图
  full?: boolean
}

export default function DishImage({ dish, className, imgClassName, emojiSize = "text-4xl", full }: DishImageProps) {
  const original = getDishImageUrl(dish)
  const url = full ? original : thumbUrl(original)
  const emoji = (
    <div className={`w-full h-full flex items-center justify-center ${emojiSize}`}>
      {getDishEmoji(dish)}
    </div>
  )
  if (!url) {
    return <div className={`${className} flex items-center justify-center ${emojiSize}`}>{getDishEmoji(dish)}</div>
  }
  // 图片懒加载；加载失败（如图片文件丢了）时退回 emoji
  return (
    <div className={className}>
      <SafeImage src={url} alt={dish.name} className={`w-full h-full object-cover ${imgClassName || ""}`} fallback={emoji} />
    </div>
  )
}
