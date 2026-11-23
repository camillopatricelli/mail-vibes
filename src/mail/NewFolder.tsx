import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { queryClient } from '../lib/queryClient'
import { useStatus } from '../status/store'
import { Button } from '../ui/components'
import { Dialog } from '../ui/overlay'
import { providerFor } from './api'
import { useFolders } from './data'

/** Name and place of a new folder (Gmail: a label), in one account. */
export function NewFolderForm({
  accountId,
  onCreated,
  onCancel,
  submitLabel,
}: {
  accountId: string
  onCreated: (id: string, name: string) => void
  onCancel: () => void
  submitLabel?: string
}) {
  const { t } = useTranslation()
  const folders = useFolders(accountId)
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const create = async () => {
    const clean = name.trim()
    if (!clean) return
    setBusy(true)
    setError(undefined)
    try {
      const id = await providerFor(accountId).createFolder(accountId, clean, parent || undefined)
      await queryClient.invalidateQueries({ queryKey: ['mail', 'folders', accountId] })
      void queryClient.invalidateQueries({ queryKey: ['mail', 'tags', accountId] }) // Gmail labels are tags too
      onCreated(id, clean)
    } catch (e) {
      setError(t('mail.newFolderFailed', { reason: (e as Error).message }))
      setBusy(false)
    }
  }

  return (
    <form
      className="new-folder"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <input
        className="text-field text-field--outlined"
        value={name}
        autoFocus
        maxLength={120}
        placeholder={t('mail.newFolderName')}
        aria-label={t('mail.newFolderName')}
        onChange={(e) => setName(e.target.value)}
      />
      {!!folders.data?.length && (
        <label className="body-small muted">
          {t('mail.newFolderInside')}{' '}
          <select className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t('mail.newFolderTop')}</option>
            {folders.data.map((f) => (
              <option key={f.id} value={f.id}>
                {'  '.repeat(f.depth) + f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row-wrap">
        <Button variant="filled" type="submit" disabled={busy || !name.trim()}>
          {submitLabel ?? t('mail.newFolderCreate')}
        </Button>
        <Button variant="text" onClick={onCancel}>
          {t('settings.cancel')}
        </Button>
      </div>
      {error && (
        <p className="body-small field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** Side menu → "+" next to an account's folders. */
export function NewFolderDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useStatus((s) => s.toast)
  return (
    <Dialog open onClose={onClose} title={t('mail.newFolder')}>
      <NewFolderForm
        accountId={accountId}
        onCancel={onClose}
        onCreated={(_, name) => {
          toast({ tone: 'success', message: t('mail.newFolderCreated', { name }) })
          onClose()
        }}
      />
    </Dialog>
  )
}
