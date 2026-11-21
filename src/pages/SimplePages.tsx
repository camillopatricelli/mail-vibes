import { useTranslation } from 'react-i18next'
import { href } from '../lib/router'
import { useSettings } from '../settings/store'
import { Card, EmptyState, Icon, type IconName } from '../ui/components'

function NoAccountsHint() {
  const { t } = useTranslation()
  const count = useSettings((s) => s.accounts.length)
  if (count) return null
  return (
    <p className="body-medium muted">
      {t('accounts.none')}. <a href={href('settings')}>{t('accounts.addFirst')}</a>
    </p>
  )
}

export function TodayPage() {
  const { t } = useTranslation()
  const panels: { icon: IconName; title: string }[] = [
    { icon: 'mail', title: t('placeholder.todayMail') },
    { icon: 'event', title: t('placeholder.todayAgenda') },
    { icon: 'task_alt', title: t('placeholder.todayTasks') },
  ]
  return (
    <div className="today">
      <h1 className="headline-small page-title">{t('nav.today')}</h1>
      <NoAccountsHint />
      <div className="today__panels">
        {panels.map((p) => (
          <Card key={p.title} className="today__panel">
            <header className="today__panel-head">
              <Icon name={p.icon} />
              <h2 className="title-medium">{p.title}</h2>
            </header>
            <p className="body-medium muted">{t('placeholder.nothing')}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}

export function PlaceholderPage({ section }: { section: 'mail' | 'calendar' | 'tasks' }) {
  const { t } = useTranslation()
  const icon: IconName = section === 'mail' ? 'inbox' : section === 'calendar' ? 'calendar_month' : 'task_alt'
  return (
    <div>
      <h1 className="headline-small page-title">{t(`nav.${section}`)}</h1>
      <NoAccountsHint />
      <EmptyState icon={icon} title={t(`placeholder.${section}`)} body={t('placeholder.comingSoon')} />
    </div>
  )
}

export function PrivacyPage() {
  const { t } = useTranslation()
  return (
    <article className="prose">
      <h1 className="headline-small page-title">{t('privacy.title')}</h1>
      {(['p1', 'p2', 'p3', 'p4', 'p5'] as const).map((k) => (
        <p key={k} className="body-large">
          {t(`privacy.${k}`)}
        </p>
      ))}
    </article>
  )
}
