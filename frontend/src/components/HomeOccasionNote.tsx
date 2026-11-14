import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, CalendarHeart, X } from "lucide-react"
import { holidaysApi } from "@/api"
import { homeOccasion, occasionDismissalKey } from "@/lib/homeOccasion"
import "@/styles/kitchen-occasion.css"

const dismissalStorageKey = "home_occasion_dismissed"

export default function HomeOccasionNote({ today, active }: { today: string; active: boolean }) {
  const query = useQuery({
    queryKey: ["holidays", "upcoming", today],
    queryFn: holidaysApi.upcoming,
    enabled: active,
    staleTime: 60 * 60 * 1000,
    retry: false
  })
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissalStorageKey)
    } catch {
      return null
    }
  })
  const note = homeOccasion(query.data, today)
  if (!active || query.isPending || !note) return null
  const dismissalKey = occasionDismissalKey(today, note)
  if (dismissed === dismissalKey) return null
  return (
    <aside className="kitchen-occasion-note" aria-label="饭桌小提醒">
      <CalendarHeart
        className="kitchen-occasion-icon"
        size={19}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <Link to={`/history?date=${note.date}`} className="kitchen-occasion-link">
        <span className="kitchen-occasion-copy">{note.message}</span>
        <span className="kitchen-occasion-action">
          安排一餐 <ArrowRight size={12} aria-hidden="true" />
        </span>
      </Link>
      <button
        type="button"
        className="kitchen-icon-button"
        aria-label="关闭这条提醒"
        onClick={() => {
          setDismissed(dismissalKey)
          try {
            localStorage.setItem(dismissalStorageKey, dismissalKey)
          } catch {
            /* 存储不可用时本次关闭仍生效。 */
          }
        }}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  )
}
