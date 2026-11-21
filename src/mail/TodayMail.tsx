import { useTranslation } from 'react-i18next'
import { displayName, listDate } from '../lib/format'
import { href } from '../lib/router'
import { accountLabel, useSettings } from '../settings/store'
import { AccountBadge } from '../ui/components'
import { Spinner } from '../ui/overlay'
import { useMergedFolder } from './data'

/** "New or unread mail" panel of the Today page. */
export function TodayMail() {
  const { t } = useTranslation()
  const { accounts, threads, isLoading, errors } = useMergedFolder('inbox')
  const all = useSettings((s) => s.accounts)
  const unread = threads.filter((th) => th.unread)
  if (!accounts.length) return <p className="body-medium muted">{t('placeholder.nothing')}</p>
  if (isLoading && !threads.length) return <Spinner label={t('mail.loading')} />
  return (
    <div className="today-mail">
      {errors.map(({ account, error }) => (
        <p key={account.id} className="body-small field-error" role="alert">
          {t('mail.loadFailed', { account: account.email, reason: error.message })}
        </p>
      ))}
      {unread.length === 0 ? (
        <p className="body-medium muted">{t('mail.noUnread')}</p>
      ) : (
        <ul className="today-list">
          {unread.slice(0, 8).map((th) => {
            const a = all.find((x) => x.id === th.accountId)
            return (
              <li key={th.key} style={{ borderLeftColor: a?.color }}>
                <a href={href('mail', 'inbox', 't', th.accountId, th.threadId)}>
                  <span className="today-list__top">
                    {a && <AccountBadge color={a.color} label={accountLabel(a)} size={16} />}
                    <span className="title-small">{th.participants.map(displayName).join(', ')}</span>
                    <span className="body-small muted">{listDate(th.date)}</span>
                  </span>
                  <span className="body-medium today-list__subject">{th.subject || t('mail.noSubject')}</span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
      <a href={href('mail', 'inbox')} className="btn btn--text">
        {unread.length > 8 ? t('mail.moreUnread', { count: unread.length - 8 }) : t('mail.openInbox')}
      </a>
    </div>
  )
}
