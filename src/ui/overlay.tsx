import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon, IconButton, type IconName } from './components'

/** Modal dialog built on the native <dialog> element (focus trap, Escape, backdrop). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  fullscreen,
  className,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  actions?: ReactNode
  fullscreen?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const { t } = useTranslation()
  useEffect(() => {
    const d = ref.current
    if (!open || !d) return
    // The dialog leaves the page without close(), so the browser can't return focus itself: do it here.
    const before = document.activeElement as HTMLElement | null
    if (!d.open) d.showModal()
    return () => {
      if (d.open) d.close()
      if (before?.isConnected) before.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <dialog
      ref={ref}
      className={['dialog', fullscreen && 'dialog--fullscreen', className].filter(Boolean).join(' ')}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="dialog__surface">
        {title !== undefined && (
          <header className="dialog__head">
            <h2 className="title-large">{title}</h2>
            <IconButton icon="close" label={t('banner.dismiss')} onClick={onClose} />
          </header>
        )}
        <div className="dialog__body">{children}</div>
        {actions && <footer className="dialog__actions">{actions}</footer>}
      </div>
    </dialog>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  icon?: IconName
  /** A picture in place of the icon (e.g. a site's logo) */
  media?: ReactNode
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

/** Simple popup menu anchored to a trigger button. */
export function Menu({
  trigger,
  items,
  label,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode
  items: MenuItem[]
  label: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const r = anchor.current.getBoundingClientRect()
    const w = 240
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
    const below = r.bottom + 4
    const h = Math.min(items.length * 48 + 16, window.innerHeight - 16)
    const top = below + h > window.innerHeight ? Math.max(8, r.top - h - 4) : below
    setPos({ top, left })
  }, [open, items.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      anchor.current?.querySelector<HTMLElement>('button')?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={anchor} className="menu-anchor">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open &&
        pos &&
        createPortal(
          <div ref={menu} className="menu" role="menu" aria-label={label} style={{ top: pos.top, left: pos.left }}>
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={['menu__item', it.danger && 'menu__item--danger'].filter(Boolean).join(' ')}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
              >
                {it.media ?? (it.icon && <Icon name={it.icon} size={20} />)}
                <span>{it.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  )
}

export function Spinner({ size = 24, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} role="progressbar" aria-label={label}>
      <svg viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="20" fill="none" strokeWidth="4" />
      </svg>
    </span>
  )
}
