import { useSnoozeWaker } from '../mail/useSnoozeWaker'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { appInfo } from '../config'
import { href, navigate, useLocation, type Route } from '../lib/router'
import { timeAgo, useNow } from '../lib/time'
import { accountLabel, useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { FilterChip, Icon, IconButton, type IconName } from '../ui/components'
import { Banners, Toasts } from './Banners'
import { ComposerStack } from '../mail/Composer'
import { useNotifyReminder } from './reminders'
import { useContactsSync } from '../contacts/contacts'
import { useEventNotifier, useMailNotifier, useTaskNotifier, useUnreadBadge } from '../notify/useNotifiers'

const sections: { route: Route; icon: IconName; key: string }[] = [
  { route: 'today', icon: 'today', key: 'nav.today' },
  { route: 'mail', icon: 'mail', key: 'nav.mail' },
  { route: 'calendar', icon: 'calendar_month', key: 'nav.calendar' },
  { route: 'tasks', icon: 'task_alt', key: 'nav.tasks' },
]

export function keepUrl(email?: string) {
  return email ? `https://keep.google.com/?authuser=${encodeURIComponent(email)}` : 'https://keep.google.com/'
}

function NotesButton({ asRailItem }: { asRailItem?: boolean }) {
  const { t } = useTranslation()
  const accounts = useSettings((s) => s.accounts)
  const notesId = useSettings((s) => s.defaults.notesAccountId)
  const email = accounts.find((a) => a.id === notesId)?.email
  const open = () => window.open(keepUrl(email), '_blank', 'noopener,noreferrer')
  if (asRailItem)
    return (
      <button type="button" className="rail__item" onClick={open} title={t('nav.notes')}>
        <span className="rail__indicator">
          <Icon name="sticky_note_2" />
        </span>
        <span className="label-medium">{t('nav.notes')}</span>
      </button>
    )
  return <IconButton icon="sticky_note_2" label={t('nav.notes')} onClick={open} />
}

function TopBar() {
  const { t } = useTranslation()
  const { route, params } = useLocation()
  const routeQuery = route === 'search' ? (params[0] ?? '') : ''
  const [q, setQ] = useState(routeQuery)
  // Keep the box in step with the address (back/forward between searches).
  useEffect(() => {
    if (route === 'search') setQ(routeQuery)
  }, [route, routeQuery])
  return (
    <header className="top-bar">
      <a className="brand" href={href('today')} aria-label={appInfo.name}>
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={32} height={32} />
        <span className="title-large brand__name">{appInfo.name}</span>
      </a>
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          if (q.trim()) navigate('search', q.trim())
        }}
      >
        <Icon name="search" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
        />
        {q && (
          <IconButton
            icon="close"
            label={t('search.clear')}
            onClick={() => {
              setQ('')
              if (route === 'search') history.back()
            }}
          />
        )}
      </form>
      <div className="top-bar__actions">
        <span className="compact-only">
          <NotesButton />
        </span>
        <IconButton icon="settings" label={t('nav.settings')} onClick={() => navigate('settings')} />
      </div>
    </header>
  )
}

function NavRail({ active }: { active: Route | null }) {
  const { t } = useTranslation()
  return (
    <nav className="rail" aria-label={t('nav.menu')}>
      {sections.map((s) => (
        <a key={s.route} href={href(s.route)} className={['rail__item', active === s.route && 'is-active'].filter(Boolean).join(' ')} aria-current={active === s.route ? 'page' : undefined}>
          <span className="rail__indicator">
            <Icon name={s.icon} filled={active === s.route} />
          </span>
          <span className="label-medium">{t(s.key)}</span>
        </a>
      ))}
      <div className="rail__spacer" />
      <NotesButton asRailItem />
    </nav>
  )
}

function BottomNav({ active }: { active: Route | null }) {
  const { t } = useTranslation()
  return (
    <nav className="bottom-nav" aria-label={t('nav.menu')}>
      {sections.map((s) => (
        <a key={s.route} href={href(s.route)} className={['bottom-nav__item', active === s.route && 'is-active'].filter(Boolean).join(' ')} aria-current={active === s.route ? 'page' : undefined}>
          <span className="rail__indicator">
            <Icon name={s.icon} filled={active === s.route} />
          </span>
          <span className="label-medium">{t(s.key)}</span>
        </a>
      ))}
    </nav>
  )
}

/** Filter chips to show/hide accounts in merged views, each with its live status. */
function AccountFilters() {
  const { t } = useTranslation()
  const accounts = useSettings((s) => s.accounts)
  const updateAccount = useSettings((s) => s.updateAccount)
  const update = useSettings((s) => s.update)
  const status = useStatus((s) => s.accounts)
  const now = useNow()
  if (!accounts.length) return null
  const allShown = accounts.every((a) => a.visible)
  const showOnly = (id?: string) => update({ accounts: accounts.map((a) => ({ ...a, visible: id === undefined || a.id === id })) })
  return (
    <div className="account-filters" role="group" aria-label={t('accounts.filterLabel')}>
      {accounts.length > 1 && (
        <FilterChip
          selected={allShown}
          onToggle={() => (allShown ? update({ accounts: accounts.map((a) => ({ ...a, visible: false })) }) : showOnly())}
          title={allShown ? t('accounts.hideAll') : t('accounts.showAll')}
        >
          {t('accounts.all')}
        </FilterChip>
      )}
      {accounts.map((a) => {
        const st = status[a.id]
        const stateText = st?.error
          ? st.error.kind === 'auth'
            ? t('accounts.needsSignIn')
            : `${t('accounts.error')}: ${st.error.message}`
          : st?.lastSuccessAt
            ? t('accounts.lastUpdated', { ago: timeAgo(st.lastSuccessAt, now) })
            : t('accounts.neverUpdated')
        return (
          <FilterChip
            key={a.id}
            selected={a.visible}
            color={a.color}
            onToggle={() => updateAccount(a.id, { visible: !a.visible })}
            onDoubleClick={() => showOnly(a.id)}
            title={`${a.email} — ${stateText}\n${t('accounts.onlyHint')}`}
          >
            {accountLabel(a)}
            {st?.error && <Icon name="error" size={16} className="chip__error" label={stateText} />}
          </FilterChip>
        )
      })}
    </div>
  )
}

/** For keyboard users: the first Tab stop jumps past the menus to the page (hidden until focused). */
function SkipLink() {
  const { t } = useTranslation()
  return (
    <a
      className="skip-link"
      href="#main"
      onClick={(e) => {
        // The app's routes live in the URL hash, so move focus instead of navigating.
        e.preventDefault()
        document.getElementById('main')?.focus()
      }}
    >
      {t('nav.skipToContent')}
    </a>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { route } = useLocation()
  useNotifyReminder()
  useContactsSync()
  useMailNotifier()
  useEventNotifier()
  useTaskNotifier()
  useSnoozeWaker()
  useUnreadBadge()
  const showFilters = route !== 'settings' && route !== 'privacy' && route !== 'setup'
  return (
    <div className="shell">
      <SkipLink />
      <TopBar />
      <NavRail active={route} />
      <main id="main" className="content" tabIndex={-1}>
        <Banners />
        {showFilters && <AccountFilters />}
        <div className="page">{children}</div>
      </main>
      <BottomNav active={route} />
      <ComposerStack />
      <Toasts />
    </div>
  )
}
