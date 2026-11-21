import type { TFunction } from 'i18next'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { describe, describeOn, isLastOfMonth, nthOfMonth, sameRule, type Freq, type Recurrence } from '../lib/recurrence'
import { useSettings } from '../settings/store'
import { Button, Icon, IconButton } from '../ui/components'
import { addDays, fromDateKey, startOfDay, toDateKey, weekStartOf } from './dates'
import { dateLocale } from './format'
import { newPlacesSession, suggestPlaces, type PlaceSuggestion } from './places'

// ---------- Repeat ----------

type Preset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'monthlyNth' | 'monthlyLast' | 'yearly' | 'custom'

function presetRule(p: Preset, start: number): Recurrence | null {
  const day = new Date(start).getDay()
  switch (p) {
    case 'daily':
      return { freq: 'daily', interval: 1 }
    case 'weekdays':
      return { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] }
    case 'weekly':
      return { freq: 'weekly', interval: 1, days: [day] }
    case 'monthly':
      return { freq: 'monthly', interval: 1 }
    case 'monthlyNth':
      return { freq: 'monthly', interval: 1, nth: Math.min(nthOfMonth(start), 4), days: [day] }
    case 'monthlyLast':
      return { freq: 'monthly', interval: 1, nth: -1, days: [day] }
    case 'yearly':
      return { freq: 'yearly', interval: 1 }
    default:
      return null
  }
}

/** The preset a rule matches (ignoring its end), or 'custom'. */
function presetOf(r: Recurrence | null, start: number, presets: Preset[]): Preset {
  if (!r) return 'none'
  const open = { ...r, until: undefined, count: undefined }
  return presets.find((p) => p !== 'none' && p !== 'custom' && sameRule(presetRule(p, start), open, start)) ?? 'custom'
}

const weekdayName = (d: number, style: 'long' | 'short' = 'long') =>
  new Intl.DateTimeFormat(dateLocale(), { weekday: style }).format(new Date(2026, 10, 15 + d))

/**
 * Repeat rule editor: the common choices in a menu, plus "Customâ€¦" for every N days, weeks,
 * months or years, chosen weekdays, and when the series ends.
 */
export function RecurrenceField({
  value,
  onChange,
  start,
  exact = true,
  disabled,
}: {
  value: Recurrence | null
  onChange: (r: Recurrence | null) => void
  /** The first occurrence (sets the default weekday and day of the month) */
  start: number
  /** False when the current rule has parts this editor can't show */
  exact?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const weekStart = weekStartOf(useSettings((s) => s.weekStart))
  const nth = nthOfMonth(start)
  const presets: Preset[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly', ...(nth <= 4 ? (['monthlyNth'] as const) : []), ...(isLastOfMonth(start) ? (['monthlyLast'] as const) : []), 'yearly', 'custom']
  const [customOpen, setCustomOpen] = useState(false)
  const preset = customOpen ? 'custom' : presetOf(value, start, presets)
  const locale = dateLocale()

  const label = (p: Preset) => {
    const r = presetRule(p, start)
    if (p === 'none') return t('recurrence.none')
    if (p === 'custom') return t('recurrence.custom')
    return describe(r!, start, t, locale)
  }

  const set = (patch: Partial<Recurrence>) => value && onChange({ ...value, ...patch })
  const pick = (p: Preset) => {
    if (p === 'custom') {
      setCustomOpen(true)
      if (!value) onChange({ freq: 'weekly', interval: 1, days: [new Date(start).getDay()] })
      return
    }
    setCustomOpen(false)
    const r = presetRule(p, start)
    // Keep the end of the series when switching between rules.
    onChange(r && value ? { ...r, until: value.until, count: value.count } : r)
  }

  const order = Array.from({ length: 7 }, (_, i) => (i + weekStart) % 7)
  const days = value?.days?.length ? value.days : [new Date(start).getDay()]
  const endKind = value?.count ? 'count' : value?.until !== undefined ? 'until' : 'never'

  return (
    <div className="repeat-field">
      <select className="select" value={preset} disabled={disabled} onChange={(e) => pick(e.target.value as Preset)} aria-label={t('calendar.repeat')}>
        {presets.map((p) => (
          <option key={p} value={p}>
            {label(p)}
          </option>
        ))}
      </select>
      {value && !customOpen && preset === 'custom' && <span className="body-small muted">{describe(value, start, t, locale)}</span>}
      {!exact && <p className="body-small muted">{t('recurrence.notExact')}</p>}
      {value && (customOpen || preset === 'custom') && (
        <div className="repeat-field__custom">
          <span className="repeat-field__line">
            <span className="body-medium">{t('recurrence.every')}</span>
            <input
              type="number"
              className="select repeat-field__num"
              min={1}
              max={99}
              value={value.interval}
              disabled={disabled}
              aria-label={t('recurrence.interval')}
              onChange={(e) => set({ interval: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
            />
            <select
              className="select"
              value={value.freq}
              disabled={disabled}
              aria-label={t('recurrence.unit')}
              onChange={(e) => {
                const freq = e.target.value as Freq
                onChange({ freq, interval: value.interval, until: value.until, count: value.count, ...(freq === 'weekly' && { days: [new Date(start).getDay()] }) })
              }}
            >
              {(['daily', 'weekly', 'monthly', 'yearly'] as Freq[]).map((f) => (
                <option key={f} value={f}>
                  {t(`recurrence.unit_${f}`, { count: value.interval })}
                </option>
              ))}
            </select>
          </span>
          {value.freq === 'weekly' && (
            <span className="repeat-field__days" role="group" aria-label={t('recurrence.onWhichDays')}>
              {order.map((d) => {
                const on = days.includes(d)
                return (
                  <button
                    key={d}
                    type="button"
                    className={['day-toggle', on && 'is-on'].filter(Boolean).join(' ')}
                    aria-pressed={on}
                    title={weekdayName(d)}
                    disabled={disabled}
                    onClick={() => {
                      const next = on ? days.filter((x) => x !== d) : [...days, d]
                      if (next.length) set({ days: next })
                    }}
                  >
                    <span aria-hidden>{weekdayName(d, 'short').slice(0, 2)}</span>
                    <span className="visually-hidden">{weekdayName(d)}</span>
                  </button>
                )
              })}
            </span>
          )}
          {(value.freq === 'monthly' || value.freq === 'yearly') && (
            <span className="repeat-field__line" role="radiogroup">
              {[undefined, ...(nth <= 4 ? [Math.min(nth, 4)] : []), ...(isLastOfMonth(start) ? [-1] : [])].map((n) => {
                const r: Recurrence = { freq: value.freq, interval: 1, nth: n, days: n ? [new Date(start).getDay()] : undefined }
                const text = describeOn(r, start, t, locale)
                return (
                  <label key={String(n)} className="checkbox">
                    <input type="radio" name="repeat-month" disabled={disabled} checked={(value.nth ?? undefined) === n} onChange={() => set({ nth: n, days: n ? [new Date(start).getDay()] : undefined })} />
                    {text}
                  </label>
                )
              })}
            </span>
          )}
        </div>
      )}
      {value && (
        <span className="repeat-field__line" role="radiogroup" aria-label={t('recurrence.ends')}>
          <span className="body-medium">{t('recurrence.ends')}</span>
          <label className="checkbox">
            <input type="radio" name="repeat-end" disabled={disabled} checked={endKind === 'never'} onChange={() => set({ until: undefined, count: undefined })} />
            {t('recurrence.never')}
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="repeat-end"
              disabled={disabled}
              checked={endKind === 'until'}
              onChange={() => set({ count: undefined, until: value.until ?? addDays(startOfDay(start), value.freq === 'daily' ? 30 : value.freq === 'weekly' ? 91 : 365) })}
            />
            {t('recurrence.endOn')}
          </label>
          {endKind === 'until' && (
            <input
              type="date"
              className="select"
              value={value.until !== undefined ? toDateKey(value.until) : ''}
              min={toDateKey(start)}
              disabled={disabled}
              aria-label={t('calendar.until')}
              onChange={(e) => {
                const d = fromDateKey(e.target.value)
                if (d !== undefined) set({ until: d })
              }}
            />
          )}
          <label className="checkbox">
            <input type="radio" name="repeat-end" disabled={disabled} checked={endKind === 'count'} onChange={() => set({ until: undefined, count: value.count ?? 10 })} />
            {t('recurrence.after')}
          </label>
          {endKind === 'count' && (
            <span className="repeat-field__line">
              <input
                type="number"
                className="select repeat-field__num"
                min={1}
                max={999}
                value={value.count}
                disabled={disabled}
                aria-label={t('recurrence.occurrences')}
                onChange={(e) => set({ count: Math.min(999, Math.max(1, Number(e.target.value) || 1)) })}
              />
              <span className="body-medium">{t('recurrence.occurrences')}</span>
            </span>
          )}
        </span>
      )}
    </div>
  )
}

// ---------- Reminders ----------

const UNITS = [
  { id: 'weeks', minutes: 7 * 24 * 60 },
  { id: 'days', minutes: 24 * 60 },
  { id: 'hours', minutes: 60 },
  { id: 'minutes', minutes: 1 },
] as const
type Unit = (typeof UNITS)[number]['id']

/** A lead in minutes as a number and the largest unit that divides it. */
export function splitLead(minutes: number): { n: number; unit: Unit } {
  if (minutes === 0) return { n: 0, unit: 'minutes' }
  const u = UNITS.find((x) => minutes % x.minutes === 0)!
  return { n: minutes / u.minutes, unit: u.id }
}

/** "10 minutes before", "1 day before", "When it starts" */
export function leadText(minutes: number, t: TFunction) {
  if (minutes === 0) return t('reminders.atStart')
  const { n, unit } = splitLead(minutes)
  return t(`reminders.before_${unit}`, { count: n })
}

const when = (t: number) =>
  new Intl.DateTimeFormat(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t)

/** Reminders as minutes before the start: number + unit for each, with the resulting time shown. */
export function RemindersField({
  value,
  onChange,
  start,
  max,
  maxMinutes,
}: {
  value: number[]
  onChange: (v: number[]) => void
  /** When the event starts (to show when each reminder rings) */
  start: number
  max: number
  maxMinutes: number
}) {
  const { t } = useTranslation()
  // Rows keep their own unit while typing (e.g. "2 hours" stays in hours).
  const [units, setUnits] = useState<Unit[]>(() => value.map((m) => splitLead(m).unit))
  useEffect(() => {
    if (units.length !== value.length) setUnits(value.map((m) => splitLead(m).unit))
  }, [value, units.length])
  const factor = (u: Unit) => UNITS.find((x) => x.id === u)!.minutes
  const setAt = (i: number, minutes: number, unit: Unit) => {
    onChange(value.map((m, j) => (j === i ? Math.min(maxMinutes, Math.max(0, minutes)) : m)))
    setUnits(units.map((u, j) => (j === i ? unit : u)))
  }

  return (
    <div className="reminders-field">
      {value.map((m, i) => {
        const unit = units[i] ?? splitLead(m).unit
        const n = Math.round((m / factor(unit)) * 100) / 100
        return (
          <span key={i} className="reminders-field__row">
            <input
              type="number"
              className="select repeat-field__num"
              min={0}
              value={n}
              aria-label={t('reminders.amount')}
              onChange={(e) => setAt(i, Math.round((Number(e.target.value) || 0) * factor(unit)), unit)}
            />
            <select className="select" value={unit} aria-label={t('reminders.unit')} onChange={(e) => setAt(i, Math.round(n * factor(e.target.value as Unit)), e.target.value as Unit)}>
              {[...UNITS].reverse().map((u) => (
                <option key={u.id} value={u.id}>
                  {t(`reminders.unit_${u.id}`, { count: n })}
                </option>
              ))}
            </select>
            <span className="body-small muted">{t('reminders.beforeAt', { time: when(start - m * 60_000) })}</span>
            <IconButton icon="close" label={t('reminders.remove')} onClick={() => {
              onChange(value.filter((_, j) => j !== i))
              setUnits(units.filter((_, j) => j !== i))
            }} />
          </span>
        )
      })}
      {value.length < max && (
        <Button
          variant="text"
          icon="add"
          onClick={() => {
            onChange([...value, 30])
            setUnits([...units, 'minutes'])
          }}
        >
          {t('reminders.add')}
        </Button>
      )}
      {!value.length && max > 0 && <span className="body-small muted">{t('reminders.none')}</span>}
    </div>
  )
}

// ---------- Location ----------

/** Location input with Google place suggestions (when a Maps key is set in Settings). */
export function LocationField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t, i18n } = useTranslation()
  const key = useSettings((s) => s.mapsApiKey)
  const [items, setItems] = useState<PlaceSuggestion[]>([])
  const [active, setActive] = useState(0)
  const [typed, setTyped] = useState(false)
  const [error, setError] = useState('')
  const session = useRef<object | undefined>(undefined)

  useEffect(() => {
    if (!key || !typed || value.trim().length < 3) {
      setItems([])
      return
    }
    let cancelled = false
    const h = setTimeout(async () => {
      try {
        session.current ??= await newPlacesSession(key)
        const found = await suggestPlaces(key, value, session.current, i18n.language)
        if (!cancelled) {
          setItems(found)
          setActive(0)
          setError('')
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(h)
    }
  }, [key, value, typed, i18n.language])

  const pick = (p: PlaceSuggestion) => {
    onChange(p.text)
    setItems([])
    setTyped(false)
    // The next search is a new session.
    session.current = undefined
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(items[Math.min(active, items.length - 1)])
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setItems([])
    }
  }

  return (
    <div className="location-field event-form__grow">
      <input
        className="text-field text-field--outlined"
        placeholder={t('calendar.location')}
        aria-label={t('calendar.location')}
        value={value}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value)
          setTyped(true)
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setItems([]), 150)}
      />
      {items.length > 0 && (
        <ul className="suggestions location-field__list" role="listbox">
          {items.map((p, i) => (
            <li key={p.text} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className={i === active ? 'is-active' : undefined}>
                <span className="body-medium">
                  <Icon name="location_on" size={16} /> {p.main}
                </span>
                {p.secondary && <span className="body-small muted">{p.secondary}</span>}
              </button>
            </li>
          ))}
          <li className="location-field__credit body-small muted">{t('calendar.placesByGoogle')}</li>
        </ul>
      )}
      {error && <p className="body-small field-error">{t('calendar.placesFailed', { reason: error })}</p>}
    </div>
  )
}
