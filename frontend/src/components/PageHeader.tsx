import type { ButtonHTMLAttributes, ReactNode } from "react"
import { ArrowLeft, type LucideIcon } from "lucide-react"

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  icon?: LucideIcon
  meta?: ReactNode
  actions?: ReactNode
  onBack?: () => void
  centerTitle?: boolean
  className?: string
}

export function HeaderIconButton({ className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`kitchen-header-button ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export default function PageHeader({
  title,
  subtitle,
  icon: Icon,
  meta,
  actions,
  onBack,
  centerTitle = false,
  className = "",
}: PageHeaderProps) {
  return (
    <header className={`kitchen-page-header ${className}`}>
      <div className="kitchen-page-header-inner">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <HeaderIconButton onClick={onBack} aria-label="返回" className="shrink-0">
              <ArrowLeft size={18} strokeWidth={2.4} />
            </HeaderIconButton>
          )}
          {Icon && (
            <div className="kitchen-page-icon" aria-hidden="true">
              <Icon size={23} strokeWidth={2.45} />
            </div>
          )}
          <div className={`min-w-0 ${centerTitle ? "text-center" : ""}`}>
            <h1 className="kitchen-page-title">{title}</h1>
            {subtitle && <div className="mt-1 truncate text-[12px] font-medium leading-tight text-text3">{subtitle}</div>}
          </div>
        </div>
        <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-2">
          {meta && <div className="kitchen-page-meta">{meta}</div>}
          {actions}
        </div>
      </div>
    </header>
  )
}
