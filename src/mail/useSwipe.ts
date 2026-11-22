import { useRef, useState, type MouseEvent, type PointerEvent } from 'react'

/** How far (share of the row's width) a swipe must go to count. */
const THRESHOLD = 0.35
const LONG_PRESS_MS = 500
/** Movement that turns a touch into a swipe or a scroll, and cancels a long press. */
const SLOP = 10

/**
 * Touch gestures on a list row: swipe left or right (the row follows the finger and slides away
 * past a threshold) and long press. Mouse and pen input are left alone. The row needs
 * `touch-action: pan-y`, so vertical scrolling stays with the browser.
 */
export function useSwipe({ onLeft, onRight, onLongPress }: { onLeft?: () => void; onRight?: () => void; onLongPress?: () => void }) {
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  const start = useRef<{ x: number; y: number; id: number; width: number; swiping: boolean } | null>(null)
  const offset = useRef(0)
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** A gesture just ended: the click that follows must not open the row. */
  const handled = useRef(false)

  const move = (x: number) => {
    offset.current = x
    setDx(x)
  }
  const cancelPress = () => clearTimeout(press.current)

  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch') return
      handled.current = false
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, width: e.currentTarget.offsetWidth, swiping: false }
      if (onLongPress)
        press.current = setTimeout(() => {
          handled.current = true
          start.current = null
          navigator.vibrate?.(20)
          onLongPress()
        }, LONG_PRESS_MS)
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = start.current
      if (!s || e.pointerId !== s.id) return
      let d = e.clientX - s.x
      const dy = e.clientY - s.y
      if (!s.swiping) {
        if (Math.abs(d) < SLOP && Math.abs(dy) < SLOP) return
        cancelPress()
        // Mostly vertical: a scroll, which the browser handles.
        if (Math.abs(dy) >= Math.abs(d) || (!onLeft && !onRight)) {
          start.current = null
          return
        }
        s.swiping = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      // A direction with no action only gives a little.
      if ((d < 0 && !onLeft) || (d > 0 && !onRight)) d /= 4
      setSettling(false)
      move(d)
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      cancelPress()
      const s = start.current
      start.current = null
      if (!s?.swiping || e.pointerId !== s.id) return
      handled.current = true
      const d = offset.current
      const action = d < 0 ? onLeft : onRight
      setSettling(true)
      if (action && Math.abs(d) > s.width * THRESHOLD) {
        move(Math.sign(d) * s.width)
        // Let the row slide out before the list drops it; if it comes back (the action failed), put it in place.
        setTimeout(action, 180)
        setTimeout(() => {
          setSettling(false)
          move(0)
        }, 1500)
      } else move(0)
    },
    onPointerCancel: () => {
      cancelPress()
      start.current = null
      setSettling(true)
      move(0)
    },
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!handled.current) return
      handled.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      // A long press on a phone would otherwise also open the browser's menu.
      if (onLongPress && (e.nativeEvent as globalThis.PointerEvent).pointerType !== 'mouse' && handled.current) e.preventDefault()
    },
  }
  return { dx, settling, handlers }
}
