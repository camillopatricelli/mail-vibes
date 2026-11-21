import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { shortDateTime } from '../lib/format'
import { Button, Icon } from '../ui/components'
import { Dialog } from '../ui/overlay'
import { snoozePresets } from './snooze'

const pad = (n: number) => String(n).padStart(2, '0')
/** A time as the value of a datetime-local input. */
const inputValue = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Snooze until…": the quick choices, or a date and time. */
export function SnoozeDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (until: number) => void }) {
  const { t } = useTranslation()
  const presets = snoozePresets()
  const [custom, setCustom] = useState('')
  const customTime = custom ? new Date(custom).getTime() : NaN
  const customOk = Number.isFinite(customTime) && customTime > Date.now()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('snooze.title')}
      actions={
        <>
          <span className="spacer" />
          <Button variant="text" onClick={onClose}>
            {t('calendar.cancel')}
          </Button>
        </>
      }
    >
      <ul className="folder-list snooze-list">
        {presets.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p.until)}>
              <Icon name="snooze" size={20} />
              <span className="body-large">{t(`snooze.${p.id}`)}</span>
              <span className="body-medium muted snooze-list__time">{shortDateTime(p.until)}</span>
            </button>
          </li>
        ))}
      </ul>
      <form
        className="snooze-custom"
        onSubmit={(e) => {
          e.preventDefault()
          if (customOk) onPick(customTime)
        }}
      >
        <label className="body-medium" htmlFor="snooze-custom">
          {t('snooze.custom')}
        </label>
        <div className="snooze-custom__row">
          <input id="snooze-custom" type="datetime-local" className="select" min={inputValue(Date.now())} value={custom} onChange={(e) => setCustom(e.target.value)} />
          <Button type="submit" disabled={!customOk} icon="snooze">
            {t('mail.snooze')}
          </Button>
        </div>
      </form>
      <p className="body-small muted snooze-note">{t('snooze.note')}</p>
    </Dialog>
  )
}
