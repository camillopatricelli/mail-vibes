import { useEffect, useRef, useState } from 'react'
import type { ShownEvent } from './data'
import { canMove, dragged, type DragKind, type Spot } from './drag'

export const eventKey = (e: { accountId: string; calendarId: string; id: string }) => `${e.accountId}|${e.calendarId}|${e.id}`

/** Where events are dropped: day cells carry data-day; time-grid columns are also .time-grid__col. */
export type DropMode = 'timed' | 'days'

function spotAt(x: number, y: number, mode: DropMode, hourPx: number): Spot | undefined {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(mode === 'timed' ? '.time-grid__col[data-day]' : '[data-day][data-days]')
  if (!el) return undefined
  const day = Number(el.dataset.day)
  if (mode === 'days') return { day }
  return { day, minutes: ((y - el.getBoundingClientRect().top) / hourPx) * 60 }
}

interface Session {
  e: ShownEvent
  kind: DragKind
  mode: DropMode
  from: Spot
  x0: number
  y0: number
  pointerId: number
  touch: boolean
  active: boolean
  timer?: number
  scroller?: HTMLElement | null
  times?: { start: number; end: number }
}

export interface DragPreview {
  key: string
  start: number
  end: number
}

function activate(s: Session, setPreview: (p: DragPreview) => void) {
  s.active = true
  s.times = { start: s.e.start, end: s.e.end }
  document.body.classList.add('is-dragging-event')
  setPreview({ key: eventKey(s.e), ...s.times })
  if (s.touch) navigator.vibrate?.(10)
}

const HOLD_MS = 350
const MOUSE_SLOP = 4
const TOUCH_SLOP = 8

/**
 * Dragging events to move them (and, in the time grid, to resize them from the bottom edge).
 * A mouse drags after a few pixels; a finger first holds still for a moment, so that swiping
 * still scrolls the calendar. Escape cancels. `onDrop` gets the new times.
 */
export function useEventDrag(hourPx: number, onDrop: (e: ShownEvent, start: number, end: number) => void) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const session = useRef<Session | null>(null)
  const drop = useRef(onDrop)
  drop.current = onDrop

  useEffect(() => {
    const end = (commit: boolean) => {
      const s = session.current
      if (!s) return
      window.clearTimeout(s.timer)
      session.current = null
      document.body.classList.remove('is-dragging-event')
      if (!s.active) return
      setPreview(null)
      // The click that follows the pointer going up mustn't open the event or start a new one.
      const swallow = (ev: Event) => (ev.stopPropagation(), ev.preventDefault())
      window.addEventListener('click', swallow, { capture: true, once: true })
      // Touch browsers send that click a little later than mice do.
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400)
      if (commit && s.times && (s.times.start !== s.e.start || s.times.end !== s.e.end)) drop.current(s.e, s.times.start, s.times.end)
    }
    const onMove = (ev: PointerEvent) => {
      const s = session.current
      if (!s || ev.pointerId !== s.pointerId) return
      const far = Math.hypot(ev.clientX - s.x0, ev.clientY - s.y0)
      if (!s.active) {
        // A finger that moves before the hold is up is scrolling, not dragging.
        if (s.touch) return void (far > TOUCH_SLOP && end(false))
        if (far < MOUSE_SLOP) return
        activate(s, setPreview)
      }
      // Near the top or bottom of a scrolling time grid, scroll it along.
      const box = s.scroller?.getBoundingClientRect()
      if (box && s.scroller) {
        if (ev.clientY < box.top + 32) s.scroller.scrollTop -= 16
        else if (ev.clientY > box.bottom - 32) s.scroller.scrollTop += 16
      }
      const to = spotAt(ev.clientX, ev.clientY, s.mode, hourPx)
      if (!to) return
      s.times = dragged(s.e, s.kind, s.from, to)
      setPreview({ key: eventKey(s.e), ...s.times })
    }
    const onUp = (ev: PointerEvent) => session.current?.pointerId === ev.pointerId && end(true)
    const onCancel = (ev: PointerEvent) => session.current?.pointerId === ev.pointerId && end(false)
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && session.current?.active && end(false)
    // Once a finger drag has started, the page mustn't scroll under it.
    const onTouchMove = (ev: TouchEvent) => session.current?.active && ev.preventDefault()
    const onContextMenu = (ev: Event) => session.current && ev.preventDefault()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      end(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [hourPx])

  /** Pointer-down handler for an event (or its resize handle). */
  const start = (e: ShownEvent, kind: DragKind, mode: DropMode, scroller?: HTMLElement | null) => (ev: React.PointerEvent) => {
    if (!canMove(e) || (ev.pointerType === 'mouse' && ev.button !== 0) || session.current) return
    const from = spotAt(ev.clientX, ev.clientY, mode, hourPx)
    if (!from) return
    if (kind === 'resize') ev.stopPropagation()
    const s: Session = { e, kind, mode, from, x0: ev.clientX, y0: ev.clientY, pointerId: ev.pointerId, touch: ev.pointerType === 'touch', active: false, scroller }
    session.current = s
    if (s.touch) s.timer = window.setTimeout(() => session.current === s && activate(s, setPreview), HOLD_MS)
  }

  return { preview, start }
}
