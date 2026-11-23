import { useTranslation } from 'react-i18next'
import { appInfo } from '../config'
import { href } from '../lib/router'
import { useSettings } from '../settings/store'
import { Card, Icon, type IconName } from '../ui/components'
import { TodayMail } from '../mail/TodayMail'
import { TodayAgenda } from '../calendar/TodayAgenda'
import { TodayTasks } from '../tasks/TodayTasks'

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
  const panels: { icon: IconName; title: string; body: React.ReactNode }[] = [
    { icon: 'event', title: t('placeholder.todayAgenda'), body: <TodayAgenda /> },
    { icon: 'task_alt', title: t('placeholder.todayTasks'), body: <TodayTasks /> },
    { icon: 'mail', title: t('placeholder.todayMail'), body: <TodayMail /> },
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
            {p.body}
          </Card>
        ))}
      </div>
    </div>
  )
}

export function PrivacyPage() {
  const { t } = useTranslation()
  return (
    <article className="prose">
      <h1 className="headline-small page-title">{t('privacy.title')}</h1>
      {(['p1', 'p2', 'p3', 'p6', 'p7', 'p4'] as const).map((k) => (
        <p key={k} className="body-large">
          {t(`privacy.${k}`)}
        </p>
      ))}
      <h2 className="title-medium">{t('privacy.permTitle')}</h2>
      <p className="body-large">{t('privacy.permIntro')}</p>
      <ul className="body-large">
        {(['permIdentity', 'permMail', 'permCalendar', 'permTasks', 'permContacts', 'permMeet', 'permRules', 'permOptional'] as const).map((k) => (
          <li key={k}>{t(`privacy.${k}`)}</li>
        ))}
      </ul>
      <p className="body-large">{t('privacy.p5')}</p>
      <h2 className="title-medium">{t('privacy.disclaimerTitle')}</h2>
      <p className="body-large">{t('privacy.disclaimer')}</p>
      <p className="body-large">
        <a href={appInfo.repoUrl} target="_blank" rel="noopener noreferrer">
          {t('privacy.sourceCode')}
        </a>
        {' · '}
        <a href={`${appInfo.repoUrl}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
          {t('privacy.licence')}
        </a>
      </p>
    </article>
  )
}
