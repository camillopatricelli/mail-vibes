import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { iconPaths, type IconName } from './icons.generated'

export type { IconName }

export function Icon({
  name,
  filled,
  size = 24,
  className,
  label,
}: {
  name: IconName
  filled?: boolean
  size?: number
  className?: string
  /** If set, the icon is announced; otherwise it is decorative. */
  label?: string
}) {
  const key = (filled ? `${name}_fill` : name) as IconName
  const d = iconPaths[key] ?? iconPaths[name]
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={d} />
    </svg>
  )
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>

export const IconButton = forwardRef<
  HTMLButtonElement,
  BtnProps & { icon: IconName; label: string; filled?: boolean; selected?: boolean; variant?: 'standard' | 'tonal' }
>(function IconButton({ icon, label, filled, selected, variant = 'standard', className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      className={['icon-btn', `icon-btn--${variant}`, selected && 'is-selected', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon name={icon} filled={filled || selected} />
    </button>
  )
})

export function Button({
  variant = 'filled',
  icon,
  children,
  className,
  ...rest
}: BtnProps & { variant?: 'filled' | 'tonal' | 'outlined' | 'text'; icon?: IconName }) {
  return (
    <button
      type="button"
      className={['btn', `btn--${variant}`, icon && 'btn--with-icon', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} />}
      <span>{children}</span>
    </button>
  )
}

export function FilterChip({
  selected,
  onToggle,
  children,
  color,
  title,
}: {
  selected: boolean
  onToggle: () => void
  children: ReactNode
  color?: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={selected}
      title={title}
      className={['chip', selected && 'is-selected'].filter(Boolean).join(' ')}
      onClick={onToggle}
    >
      {color && <span className="chip__dot" style={{ background: color, opacity: selected ? 1 : 0.35 }} />}
      {selected && !color && <Icon name="check" size={18} />}
      <span className="chip__label">{children}</span>
    </button>
  )
}

export function AccountBadge({ color, label, size = 20 }: { color: string; label: string; size?: number }) {
  const initial = label.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="account-badge"
      style={{ background: color, width: size, height: size, fontSize: size * 0.55 }}
      title={label}
      aria-label={label}
    >
      {initial}
    </span>
  )
}

export function EmptyState({ icon, title, body }: { icon: IconName; title: string; body?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={48} />
      <p className="title-medium">{title}</p>
      {body && <p className="body-medium muted">{body}</p>}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={['card', className].filter(Boolean).join(' ')}>{children}</section>
}
