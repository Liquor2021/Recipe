import { useEffect, useId, useRef } from "react"
import type { PointerEvent, ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import "@/styles/kitchen-sheet.css"

interface KitchenSheetProps {
  title: string
  theme: "day" | "night"
  onClose: () => void
  children: ReactNode
  className?: string
  hideHeading?: boolean
}

function isBackdrop(event: PointerEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false
  const bounds = event.currentTarget.getBoundingClientRect()
  return event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom
}

// The parent mounts this sheet while open. Native modal dialogs keep keyboard
// focus inside the sheet and make the rest of the page inert.
export default function KitchenSheet({ title, theme, onClose, children, className = "", hideHeading = false }: KitchenSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const backdropPointerDown = useRef(false)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    return () => {
      dialog.close()
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`kitchen-surface kitchen-${theme} kitchen-sheet ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onPointerDown={(event) => { backdropPointerDown.current = isBackdrop(event) }}
      onPointerUp={(event) => {
        const shouldClose = backdropPointerDown.current && isBackdrop(event)
        backdropPointerDown.current = false
        if (shouldClose) onClose()
      }}
      onPointerCancel={() => { backdropPointerDown.current = false }}
    >
      <header className="kitchen-sheet-heading">
        <h2 id={titleId} className={hideHeading ? "sr-only" : undefined}>{title}</h2>
        <button type="button" className="kitchen-icon-button" aria-label="关闭" onClick={onClose} autoFocus>
          <X size={20} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  )
}
