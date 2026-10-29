import type { Dish } from "@/types"
import { getDishEmoji, getDishImageUrl } from "@/lib/dishImage"
import SafeImage from "@/components/SafeImage"

interface DishImageProps {
  dish: Dish
  className?: string
  imgClassName?: string
  emojiSize?: string
}

export default function DishImage({ dish, className, imgClassName, emojiSize = "text-4xl" }: DishImageProps) {
  const url = getDishImageUrl(dish)
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
