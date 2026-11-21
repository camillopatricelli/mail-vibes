import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { displayName, fullDate, listDate } from '../lib/format'
import { href, useLocation } from '../lib/router'
import { timeAgo, useNow } from '../lib/time'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { AccountBadge, Button, EmptyState, Icon, IconButton, type IconName } from '../ui/components'
import { Dialog, Menu, Spinner } from '../ui/overlay'
import { canDeleteForever, providerFor } from './api'
import { AttachmentList } from './Attachments'
import { openDraft, openNew, openReply } from './compose'
import { mailActions, useAllFolders, useAllTags, useFolders, useMergedFolder, useThread, useUnreadCounts, type ThreadSummary } from './data'
import { TagChip, TagDialog, tagColor } from './Tags'
import { MailTaskDialog } from '../tasks/MailTaskDialog'
import { AddressMenu } from './AddressMenu'
import { MessageBody } from './MessageBody'
import { goMail, isMixed, mailHref, parseMailParams, sameView, uiFolder, viewTarget, type MailView, type UiFolder } from './routes'
import { folderKinds, type FolderKind, type ListTarget, type MailMessage, type MailSummary } from './types'

const folderIcons: Record<FolderKind, IconName> = {
  inbox: 'inbox',
  starred: 'star',
  sent: 'send',
  drafts: 'drafts',
  archive: 'archive',
  trash: 'delete',
  spam: 'warning',
}

function useAccountMap() {
  const accounts = useSettings((s) => s.accounts)
  return useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
}

const accountLabel = (a: AccountSettings) => a.displayName || a.email

// ---------- Navigation ----------

function FolderNav({ view }: { view: MailView }) {
  const { t } = useTranslation()
  const inboxUnread = useUnreadCounts('inbox')
  // Gmail labels are shown as tags, so only Outlook accounts list folders here.
  const accountFolders = useAllFolders().filter((x) => x.account.provider !== 'google')
  const tags = useAllTags()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  return (
    <nav className="mail-nav" aria-label={t('mail.folders')}>
      <button type="button" className="fab" onClick={() => openNew()}>
        <Icon name="edit" />
        <span className="label-large">{t('compose.compose')}</span>
      </button>
      <ul>
        {folderKinds.map((f) => {
          const active = view.kind === 'well' && view.folder === f
          return (
            <li key={f}>
              <a href={mailHref({ kind: 'well', folder: f })} className={['mail-nav__item', active && 'is-active'].filter(Boolean).join(' ')} aria-current={active ? 'page' : undefined}>
                <Icon name={folderIcons[f]} filled={active} />
                <span className="label-large">{t(`mail.folder.${f}`)}</span>
                {f === 'inbox' && inboxUnread > 0 && <span className="label-medium mail-nav__count">{inboxUnread}</span>}
              </a>
            </li>
          )
        })}
      </ul>
      {tags.length > 0 && (
        <>
          <h2 className="title-small mail-nav__heading">{t('tags.heading')}</h2>
          <ul>
            {tags.map((tag) => {
              const v: MailView = { kind: 'tag', name: tag.name }
              const active = sameView(v, view)
              return (
                <li key={tag.name}>
                  <a href={mailHref(v)} className={['mail-nav__item', 'mail-nav__item--folder', active && 'is-active'].filter(Boolean).join(' ')} aria-current={active ? 'page' : undefined} title={tag.name}>
                    <span className="mail-nav__tag-icon" style={{ color: tagColor(tag.name, tags) }}>
                      <Icon name="label" size={20} filled />
                    </span>
                    <span className="label-large mail-nav__folder-name">{tag.name}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {accountFolders.length > 0 && <h2 className="title-small mail-nav__heading">{t('mail.myFolders')}</h2>}
      {accountFolders.map(({ account, folders, error, isPending }) => {
        const open = !collapsed.has(account.id)
        return (
          <div key={account.id} className="mail-nav__account">
            <button
              type="button"
              className="mail-nav__account-head"
              aria-expanded={open}
              title={open ? t('mail.hideFolders', { account: account.email }) : t('mail.showFolders', { account: account.email })}
              onClick={() =>
                setCollapsed((s) => {
                  const n = new Set(s)
                  if (n.has(account.id)) n.delete(account.id)
                  else n.add(account.id)
                  return n
                })
              }
            >
              <Icon name={open ? 'keyboard_arrow_down' : 'chevron_right'} size={20} />
              <span className="chip__dot" style={{ background: account.color }} />
              <span className="label-large mail-nav__account-name">{accountLabel(account)}</span>
            </button>
            {open &&
              (isPending ? (
                <Spinner size={18} label={t('mail.loading')} />
              ) : error ? (
                <p className="body-small field-error mail-nav__note">{t('mail.foldersFailed', { reason: error.message })}</p>
              ) : !folders?.length ? (
                <p className="body-small muted mail-nav__note">{t('mail.folderEmptyList')}</p>
              ) : (
                <ul>
                  {folders.map((f) => {
                    const v: MailView = { kind: 'custom', accountId: account.id, folderId: f.id }
                    const active = sameView(v, view)
                    return (
                      <li key={f.id}>
                        <a
                          href={mailHref(v)}
                          className={['mail-nav__item', 'mail-nav__item--folder', active && 'is-active'].filter(Boolean).join(' ')}
                          style={{ paddingLeft: 16 + f.depth * 16 }}
                          aria-current={active ? 'page' : undefined}
                          title={f.name}
                        >
                          <Icon name="folder" size={20} filled={active} />
                          <span className="label-large mail-nav__folder-name">{f.name}</span>
                          {f.unread > 0 && <span className="label-medium mail-nav__count">{f.unread}</span>}
                        </a>
                      </li>
                    )
                  })}
                </ul>
              ))}
          </div>
        )
      })}
    </nav>
  )
}

/** Folder selector for phones (the navigation column is hidden there). */
function FolderPicker({ view }: { view: MailView }) {
  const { t } = useTranslation()
  const accountFolders = useAllFolders().filter((x) => x.account.provider !== 'google')
  const tags = useAllTags()
  const value = view.kind === 'well' ? `w:${view.folder}` : view.kind === 'tag' ? `g:${view.name}` : view.kind === 'search' ? '' : `c:${view.accountId}\n${view.folderId}`
  return (
    <select
      className="select folder-picker compact-only"
      value={value}
      onChange={(e) => {
        const v = e.target.value
        if (v.startsWith('w:')) goMail({ kind: 'well', folder: v.slice(2) as FolderKind })
        else if (v.startsWith('g:')) goMail({ kind: 'tag', name: v.slice(2) })
        else {
          const [accountId, folderId] = v.slice(2).split('\n')
          goMail({ kind: 'custom', accountId, folderId })
        }
      }}
      aria-label={t('mail.folders')}
    >
      {folderKinds.map((f) => (
        <option key={f} value={`w:${f}`}>
          {t(`mail.folder.${f}`)}
        </option>
      ))}
      {tags.length > 0 && (
        <optgroup label={t('tags.heading')}>
          {tags.map((tag) => (
            <option key={tag.name} value={`g:${tag.name}`}>
              {tag.name}
            </option>
          ))}
        </optgroup>
      )}
      {accountFolders.map(({ account, folders }) =>
        folders?.length ? (
          <optgroup key={account.id} label={accountLabel(account)}>
            {folders.map((f) => (
              <option key={f.id} value={`c:${account.id}\n${f.id}`}>
                {' '.repeat(f.depth * 3)}
                {f.name}
                {f.unread ? ` (${f.unread})` : ''}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  )
}

function itemsOf(threads: ThreadSummary[]) {
  return threads.flatMap((th) => th.messages.map((m) => ({ accountId: m.accountId, id: m.id })))
}

function SyncStatus({ accounts }: { accounts: AccountSettings[] }) {
  const { t } = useTranslation()
  const status = useStatus((s) => s.accounts)
  const now = useNow()
  if (!accounts.length) return null
  const times = accounts.map((a) => status[a.id]?.lastSuccessAt ?? 0)
  const oldest = Math.min(...times)
  const anyError = accounts.some((a) => status[a.id]?.error)
  return (
    <span
      className={['body-small', anyError ? 'sync-status--error' : 'muted'].join(' ')}
      title={accounts.map((a) => `${a.email}: ${status[a.id]?.lastSuccessAt ? timeAgo(status[a.id]!.lastSuccessAt!, now) : t('accounts.neverUpdated')}`).join('\n')}
    >
      {anyError ? t('mail.someAccountsFailing') : oldest ? t('accounts.lastUpdated', { ago: timeAgo(oldest, now) }) : t('accounts.neverUpdated')}
    </span>
  )
}

// ---------- List ----------

function ThreadRow({
  th,
  view,
  account,
  selected,
  onSelect,
}: {
  th: ThreadSummary
  view: MailView
  account?: AccountSettings
  selected: boolean
  onSelect: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const folder = uiFolder(view)
  const items = itemsOf([th])
  const allTags = useAllTags()
  const rowTags = th.tags.filter((n) => view.kind !== 'tag' || n.toLowerCase() !== view.name.toLowerCase())
  const open = () => {
    if (folder === 'drafts' && th.hasDraft && th.messages.length === 1) void openDraft(th.accountId, th.messages[0].id)
    else goMail(view, { accountId: th.accountId, threadId: th.threadId })
  }
  const senders =
    folder === 'sent' || folder === 'drafts'
      ? th.messages[th.messages.length - 1].to.map(displayName).join(', ')
      : th.participants.map(displayName).join(', ')
  return (
    <li className={['thread-row', th.unread && 'is-unread', selected && 'is-selected'].filter(Boolean).join(' ')} style={{ borderLeftColor: account?.color }}>
      <input type="checkbox" className="thread-row__check" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={t('mail.select', { subject: th.subject })} />
      <IconButton
        icon="star"
        className="thread-row__star"
        selected={th.flagged}
        label={th.flagged ? t('mail.unstar') : t('mail.star')}
        onClick={() => void mailActions.setFlagged(th.flagged ? items.filter((_, i) => th.messages[i].isFlagged) : [items[items.length - 1]], !th.flagged)}
      />
      <button type="button" className="thread-row__main" onClick={open}>
        <span className="thread-row__from">
          {account && <AccountBadge color={account.color} label={accountLabel(account)} size={18} />}
          <span className="thread-row__senders">{senders || t('mail.noRecipients')}</span>
          {th.messages.length > 1 && <span className="thread-row__count body-small muted">{th.messages.length}</span>}
          {th.hasDraft && folder !== 'drafts' && <span className="draft-label body-small">{t('mail.draft')}</span>}
        </span>
        <span className="thread-row__text">
          {rowTags.slice(0, 3).map((n) => (
            <TagChip key={n} name={n} tags={allTags} />
          ))}
          {rowTags.length > 3 && <span className="body-small muted">+{rowTags.length - 3} </span>}
          <span className="thread-row__subject">{th.subject || t('mail.noSubject')}</span>
          <span className="thread-row__snippet muted"> – {th.snippet}</span>
        </span>
        <span className="thread-row__meta">
          {th.hasAttachments && <Icon name="attach_file" size={18} label={t('mail.hasAttachments')} />}
          <span className="thread-row__date body-small">{listDate(th.date)}</span>
        </span>
      </button>
      <span className="thread-row__actions">
        {(folder === 'inbox' || folder === 'custom' || isMixed(folder)) && (
          <IconButton icon="archive" label={t('mail.archive')} onClick={() => void mailActions.archive(items, 1, isMixed(folder))} />
        )}
        {folder !== 'trash' ? (
          <IconButton icon="delete" label={t('mail.delete')} onClick={() => void mailActions.trash(items, 1)} />
        ) : (
          <IconButton icon="inbox" label={t('mail.restore')} onClick={() => void mailActions.moveToInbox(items, 1)} />
        )}
        <IconButton
          icon={th.unread ? 'mark_email_read' : 'mark_email_unread'}
          label={th.unread ? t('mail.markRead') : t('mail.markUnread')}
          onClick={() => void mailActions.setRead(th.unread ? items : [items[items.length - 1]], th.unread)}
        />
      </span>
    </li>
  )
}

/** Move to Inbox, Archive or one of the account's own folders. */
function MoveDialog({
  open,
  onClose,
  accountIds,
  onPick,
}: {
  open: boolean
  onClose: () => void
  accountIds: string[]
  onPick: (dest: ListTarget, name: string) => void
}) {
  const { t } = useTranslation()
  const single = accountIds.length === 1 ? accountIds[0] : undefined
  const folders = useFolders(open ? single : undefined)
  const standard: FolderKind[] = ['inbox', 'archive']
  return (
    <Dialog open={open} onClose={onClose} title={t('mail.moveTo')}>
      {!single ? (
        <p className="body-medium">{t('mail.moveOneAccount')}</p>
      ) : (
        <ul className="folder-list">
          {standard.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => onPick(f, t(`mail.folder.${f}`))}>
                <Icon name={folderIcons[f]} size={20} />
                <span className="body-large">{t(`mail.folder.${f}`)}</span>
              </button>
            </li>
          ))}
          {folders.isPending ? (
            <li className="folder-list__note">
              <Spinner size={20} label={t('mail.loading')} />
            </li>
          ) : folders.error ? (
            <li className="folder-list__note field-error" role="alert">
              {t('mail.foldersFailed', { reason: (folders.error as Error).message })}
            </li>
          ) : (
            folders.data!.map((f) => (
              <li key={f.id}>
                <button type="button" style={{ paddingLeft: 24 + f.depth * 20 }} onClick={() => onPick({ folderId: f.id }, f.name)}>
                  <Icon name="folder" size={20} />
                  <span className="body-large">{f.name}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </Dialog>
  )
}

function CustomFolderTitle({ view }: { view: Extract<MailView, { kind: 'custom' }> }) {
  const { t } = useTranslation()
  const folders = useFolders(view.accountId)
  const account = useSettings((s) => s.accounts.find((a) => a.id === view.accountId))
  const name = folders.data?.find((f) => f.id === view.folderId)?.name ?? '…'
  return (
    <h1 className="title-large custom-folder-title">
      <Icon name="folder" />
      {account ? t('mail.inFolder', { folder: name, account: accountLabel(account) }) : name}
    </h1>
  )
}

function TagTitle({ name }: { name: string }) {
  const tags = useAllTags()
  return (
    <h1 className="title-large custom-folder-title">
      <span className="mail-nav__tag-icon" style={{ color: tagColor(name, tags) }}>
        <Icon name="label" filled />
      </span>
      {name}
    </h1>
  )
}

function MailList({ view }: { view: MailView }) {
  const { t } = useTranslation()
  const folder = uiFolder(view)
  const { accounts, threads, hasMore, isLoading, isFetching, errors, loadMore, refresh } = useMergedFolder(
    viewTarget(view),
    view.kind === 'custom' ? view.accountId : undefined,
  )
  const accountMap = useAccountMap()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  const [tagging, setTagging] = useState<MailSummary[] | null>(null)
  const viewKey = mailHref(view)
  useEffect(() => setSelected(new Set()), [viewKey])

  const sel = threads.filter((th) => selected.has(th.key))
  const selItems = itemsOf(sel)
  const deletable = selItems.filter((i) => canDeleteForever(i.accountId))
  const clear = () => setSelected(new Set())
  const allSelected = threads.length > 0 && sel.length === threads.length

  if (!accounts.length) {
    const any = useSettings.getState().accounts.length > 0
    return <EmptyState icon="inbox" title={any ? t('mail.allHidden') : t('accounts.none')} body={!any && <a href={href('settings')}>{t('accounts.addFirst')}</a>} />
  }

  return (
    <div className="mail-list">
      {view.kind === 'custom' && <CustomFolderTitle view={view} />}
      {view.kind === 'tag' && <TagTitle name={view.name} />}
      {view.kind === 'search' && (
        <h1 className="title-large custom-folder-title">
          <Icon name="search" />
          {t('search.mailResults', { q: view.q })}
        </h1>
      )}
      <div className="list-toolbar">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = sel.length > 0 && !allSelected
          }}
          onChange={(e) => setSelected(e.target.checked ? new Set(threads.map((th) => th.key)) : new Set())}
          aria-label={t('mail.selectAll')}
        />
        {sel.length === 0 ? (
          <>
            <IconButton icon="refresh" label={t('mail.refresh')} onClick={refresh} disabled={isFetching} />
            {isFetching && <Spinner size={18} label={t('mail.loading')} />}
            <span className="spacer" />
            <SyncStatus accounts={accounts} />
          </>
        ) : (
          <>
            {(folder === 'inbox' || folder === 'custom' || isMixed(folder)) && (
              <IconButton icon="archive" label={t('mail.archive')} onClick={() => void mailActions.archive(selItems, sel.length, isMixed(folder)).then(clear)} />
            )}
            {folder === 'trash' ? (
              <>
                <IconButton icon="inbox" label={t('mail.restore')} onClick={() => void mailActions.moveToInbox(selItems, sel.length).then(clear)} />
                {deletable.length > 0 && (
                  <IconButton
                    icon="delete"
                    label={t('mail.deleteForever')}
                    onClick={() => {
                      if (confirm(t('mail.confirmDeleteForever', { count: sel.length }))) void mailActions.deleteForever(deletable, sel.length).then(clear)
                    }}
                  />
                )}
              </>
            ) : (
              <IconButton icon="delete" label={t('mail.delete')} onClick={() => void mailActions.trash(selItems, sel.length).then(clear)} />
            )}
            {folder === 'spam' && <IconButton icon="inbox" label={t('mail.notSpam')} onClick={() => void mailActions.moveToInbox(selItems, sel.length).then(clear)} />}
            <IconButton icon="mark_email_read" label={t('mail.markRead')} onClick={() => void mailActions.setRead(selItems, true).then(clear)} />
            <IconButton icon="mark_email_unread" label={t('mail.markUnread')} onClick={() => void mailActions.setRead(selItems, false).then(clear)} />
            <IconButton icon="drive_file_move" label={t('mail.moveTo')} onClick={() => setMoving(true)} />
            <IconButton icon="label" label={t('tags.action')} onClick={() => setTagging(sel.flatMap((th) => th.messages))} />
            <span className="body-medium">{t('mail.selected', { count: sel.length })}</span>
          </>
        )}
      </div>

      {errors.map(({ account, error, refetch }) => (
        <div key={account.id} className="banner banner--error list-error" role="alert">
          <Icon name="error" />
          <div className="banner__text">
            <p className="body-medium">{t('mail.loadFailed', { account: account.email, reason: error.message })}</p>
          </div>
          <Button variant="text" onClick={() => void refetch()}>
            {t('banner.retry')}
          </Button>
        </div>
      ))}

      {isLoading && !threads.length ? (
        <div className="list-loading">
          <Spinner label={t('mail.loading')} />
        </div>
      ) : !threads.length && !errors.length ? (
        <EmptyState icon={view.kind === 'well' ? folderIcons[view.folder] : view.kind === 'tag' ? 'label' : view.kind === 'search' ? 'search' : 'folder'} title={view.kind === 'search' ? t('search.noMail') : t('mail.empty')} />
      ) : (
        <ul className="thread-list">
          {threads.map((th) => (
            <ThreadRow
              key={th.key}
              th={th}
              view={view}
              account={accountMap.get(th.accountId)}
              selected={selected.has(th.key)}
              onSelect={(v) =>
                setSelected((s) => {
                  const n = new Set(s)
                  if (v) n.add(th.key)
                  else n.delete(th.key)
                  return n
                })
              }
            />
          ))}
        </ul>
      )}
      {hasMore && threads.length > 0 && (
        <div className="load-more">
          <Button variant="text" onClick={loadMore} disabled={isFetching}>
            {t('mail.loadMore')}
          </Button>
        </div>
      )}
      <MoveDialog
        open={moving}
        onClose={() => setMoving(false)}
        accountIds={[...new Set(sel.map((s) => s.accountId))]}
        onPick={(dest, name) => {
          setMoving(false)
          void mailActions.moveTo(selItems, dest, name).then(clear)
        }}
      />
      {tagging && (
        <TagDialog
          messages={tagging}
          onClose={() => {
            setTagging(null)
            clear()
          }}
        />
      )}
    </div>
  )
}

// ---------- Conversation ----------

function MessageCard({ m, expanded, onToggle, account, onAddTask }: { m: MailMessage; expanded: boolean; onToggle: () => void; account?: AccountSettings; onAddTask: (m: MailMessage) => void }) {
  const { t } = useTranslation()
  const attachments = useQuery({
    queryKey: ['mail', 'attachments', m.accountId, m.id],
    enabled: expanded && m.hasAttachments,
    staleTime: Infinity,
    queryFn: () => providerFor(m.accountId).attachments(m.accountId, m.id),
  })
  const recipients = [...m.to, ...m.cc]
  if (!expanded)
    return (
      <li className={['message', 'is-collapsed', !m.isRead && 'is-unread'].filter(Boolean).join(' ')}>
        <button type="button" className="message__collapsed" onClick={onToggle}>
          <AccountBadge color={account?.color ?? '#888'} label={displayName(m.from)} size={32} />
          <span className="message__from-name title-small">{displayName(m.from)}</span>
          {m.isDraft && <span className="draft-label body-small">{t('mail.draft')}</span>}
          <span className="message__snippet body-medium muted">{m.snippet}</span>
          <span className="body-small muted">{listDate(m.date)}</span>
        </button>
      </li>
    )
  return (
    <li className={['message', !m.isRead && 'is-unread'].filter(Boolean).join(' ')}>
      <header className="message__head">
        <AccountBadge color={account?.color ?? '#888'} label={displayName(m.from)} size={40} />
        {/* Clicking the header collapses the message; the addresses open their own menu. */}
        <div className="message__who" onClick={(e) => e.currentTarget.contains(e.target as Node) && onToggle()}>
          <AddressMenu address={m.from} className="title-small">
            {displayName(m.from)}
          </AddressMenu>
          <span className="body-small muted">&lt;{m.from.email}&gt;</span>
          <span className="body-small muted message__to">
            {t('mail.toPrefix')}{' '}
            {recipients.length
              ? recipients.map((a, i) => (
                  <span key={a.email + i}>
                    <AddressMenu address={a}>{displayName(a)}</AddressMenu>
                    {i < recipients.length - 1 && ', '}
                  </span>
                ))
              : '—'}
          </span>
        </div>
        <span className="body-small muted message__date" title={fullDate(m.date)}>
          {listDate(m.date)}
        </span>
        {m.isDraft ? (
          <Button variant="tonal" icon="edit" onClick={() => void openDraft(m.accountId, m.id)}>
            {t('mail.editDraft')}
          </Button>
        ) : (
          <>
            <IconButton icon="star" selected={m.isFlagged} label={m.isFlagged ? t('mail.unstar') : t('mail.star')} onClick={() => void mailActions.setFlagged([m], !m.isFlagged)} />
            <IconButton icon="reply" label={t('mail.reply')} onClick={() => void openReply(m, 'reply')} />
            <Menu
              label={t('mail.more')}
              trigger={(p) => <IconButton icon="more_vert" label={t('mail.more')} {...p} />}
              items={[
                { label: t('mail.replyAll'), icon: 'reply_all', onSelect: () => void openReply(m, 'replyAll') },
                { label: t('mail.forward'), icon: 'forward', onSelect: () => void openReply(m, 'forward') },
                m.isRead
                  ? { label: t('mail.markUnread'), icon: 'mark_email_unread', onSelect: () => void mailActions.setRead([m], false) }
                  : { label: t('mail.markRead'), icon: 'mark_email_read', onSelect: () => void mailActions.setRead([m], true) },
                { label: t('tasks.addFromMail'), icon: 'add_task', onSelect: () => onAddTask(m) },
              ]}
            />
          </>
        )}
      </header>
      <MessageBody message={m} />
      {m.hasAttachments &&
        (attachments.isPending ? (
          <Spinner size={20} label={t('mail.loading')} />
        ) : attachments.error ? (
          <p className="field-error body-small" role="alert">
            {t('mail.attachmentsFailed', { reason: (attachments.error as Error).message })}
          </p>
        ) : (
          <AttachmentList accountId={m.accountId} messageId={m.id} attachments={attachments.data ?? []} />
        ))}
    </li>
  )
}

function ThreadView({ view, accountId, threadId }: { view: MailView; accountId: string; threadId: string }) {
  const { t } = useTranslation()
  const q = useThread(accountId, threadId)
  const account = useSettings((s) => s.accounts.find((a) => a.id === accountId))
  const markReadPref = useSettings((s) => s.markRead)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  const [taskFrom, setTaskFrom] = useState<MailMessage | null>(null)
  const [tagging, setTagging] = useState(false)
  const allTags = useAllTags()
  const folder: UiFolder = uiFolder(view)
  const back = () => goMail(view)
  // Messages that were unread when the conversation opened stay expanded after being marked read.
  const initiallyUnread = useRef<Set<string> | null>(null)
  if (q.data && !initiallyUnread.current) initiallyUnread.current = new Set(q.data.filter((m) => !m.isRead).map((m) => m.id))

  const all = q.data ?? []
  const viewingTrash = folder === 'trash' || folder === 'spam'
  const messages = viewingTrash ? all : all.filter((m) => m.folderKind !== 'trash' && m.folderKind !== 'spam')
  const latest = [...messages].reverse().find((m) => !m.isDraft) ?? messages[messages.length - 1]
  const unread = messages.filter((m) => !m.isRead)

  // Automatic "mark as read" only if the user chose it in Settings, and only once per opening,
  // so a deliberate "Mark as unread" is never undone.
  const autoDone = useRef(false)
  const loaded = !!q.data
  useEffect(() => {
    if (!loaded || markReadPref === 'never' || autoDone.current) return
    const run = () => {
      autoDone.current = true
      const ids = initiallyUnread.current
      const targets = (q.data ?? []).filter((m) => ids?.has(m.id) && !m.isRead)
      if (targets.length) void mailActions.setRead(targets, true)
    }
    if (markReadPref === 'open') {
      run()
      return
    }
    const h = setTimeout(run, 5000)
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, markReadPref])

  if (q.isPending)
    return (
      <div className="list-loading">
        <Spinner label={t('mail.loading')} />
      </div>
    )
  if (q.error)
    return (
      <div className="thread">
        <div className="list-toolbar">
          <IconButton icon="arrow_back" label={t('mail.back')} onClick={back} />
        </div>
        <div className="banner banner--error" role="alert">
          <Icon name="error" />
          <div className="banner__text">
            <p className="body-medium">{t('mail.threadFailed', { reason: (q.error as Error).message })}</p>
          </div>
          <Button variant="text" onClick={() => void q.refetch()}>
            {t('banner.retry')}
          </Button>
        </div>
      </div>
    )
  if (!messages.length) return <EmptyState icon="mail" title={t('mail.threadGone')} body={<a href={mailHref(view)}>{t('mail.back')}</a>} />

  const inInbox = messages.filter((m) => m.folderKind === 'inbox')
  const archivable =
    folder === 'custom' ? messages.filter((m) => !m.folderKind) : isMixed(folder) ? messages.filter((m) => !m.folderKind || m.folderKind === 'inbox') : inInbox
  const threadTags = [...new Map(messages.flatMap((m) => m.tags).map((n) => [n.toLowerCase(), n])).values()]
  const tagged = (n: string) => messages.filter((m) => m.tags.some((x) => x.toLowerCase() === n.toLowerCase()))
  const notTrashed = messages.filter((m) => m.folderKind !== 'trash')
  const movable = messages.filter((m) => m.folderKind !== 'sent' && m.folderKind !== 'drafts' && m.folderKind !== 'trash')
  const isExpanded = (m: MailMessage) => expanded.has(m.id) !== (m.id === latest?.id || !!initiallyUnread.current?.has(m.id))

  return (
    <div className="thread">
      <div className="list-toolbar">
        <IconButton icon="arrow_back" label={t('mail.back')} onClick={back} />
        {archivable.length > 0 && <IconButton icon="archive" label={t('mail.archive')} onClick={() => void mailActions.archive(archivable, 1).then(back)} />}
        {notTrashed.length > 0 ? (
          <IconButton icon="delete" label={t('mail.delete')} onClick={() => void mailActions.trash(notTrashed, 1).then(back)} />
        ) : (
          messages.some((m) => canDeleteForever(m.accountId)) && (
            <IconButton
              icon="delete"
              label={t('mail.deleteForever')}
              onClick={() => {
                if (confirm(t('mail.confirmDeleteForever', { count: 1 }))) void mailActions.deleteForever(messages, 1).then(back)
              }}
            />
          )
        )}
        {viewingTrash && (
          <IconButton icon="inbox" label={folder === 'spam' ? t('mail.notSpam') : t('mail.restore')} onClick={() => void mailActions.moveToInbox(messages, 1).then(back)} />
        )}
        {unread.length > 0 ? (
          <IconButton icon="mark_email_read" label={t('mail.markRead')} onClick={() => void mailActions.setRead(unread, true)} />
        ) : (
          latest && <IconButton icon="mark_email_unread" label={t('mail.markUnread')} onClick={() => void mailActions.setRead([latest], false)} />
        )}
        {movable.length > 0 && <IconButton icon="drive_file_move" label={t('mail.moveTo')} onClick={() => setMoving(true)} />}
        <IconButton icon="label" label={t('tags.action')} onClick={() => setTagging(true)} />
        {latest && !latest.isDraft && <IconButton icon="add_task" label={t('tasks.addFromMail')} onClick={() => setTaskFrom(latest)} />}
        <span className="spacer" />
        {account && (
          <span className="thread__account body-small" style={{ borderColor: account.color }}>
            <AccountBadge color={account.color} label={accountLabel(account)} size={16} />
            {account.email}
          </span>
        )}
      </div>
      <h1 className="headline-small thread__subject">{latest?.subject || t('mail.noSubject')}</h1>
      {threadTags.length > 0 && (
        <div className="thread__tags">
          {threadTags.map((n) => (
            <TagChip key={n} name={n} tags={allTags} onRemove={() => void mailActions.setTags(tagged(n), [], [n])} />
          ))}
        </div>
      )}
      <ul className="messages">
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            m={m}
            account={account}
            onAddTask={setTaskFrom}
            expanded={isExpanded(m)}
            onToggle={() =>
              setExpanded((s) => {
                const n = new Set(s)
                if (n.has(m.id)) n.delete(m.id)
                else n.add(m.id)
                return n
              })
            }
          />
        ))}
      </ul>
      {latest && !latest.isDraft && (
        <div className="thread__reply">
          <Button variant="outlined" icon="reply" onClick={() => void openReply(latest, 'reply')}>
            {t('mail.reply')}
          </Button>
          <Button variant="outlined" icon="reply_all" onClick={() => void openReply(latest, 'replyAll')}>
            {t('mail.replyAll')}
          </Button>
          <Button variant="outlined" icon="forward" onClick={() => void openReply(latest, 'forward')}>
            {t('mail.forward')}
          </Button>
        </div>
      )}
      {tagging && <TagDialog messages={messages} onClose={() => setTagging(false)} />}
      {taskFrom && <MailTaskDialog message={taskFrom} onClose={() => setTaskFrom(null)} />}
      <MoveDialog
        open={moving}
        onClose={() => setMoving(false)}
        accountIds={[accountId]}
        onPick={(dest, name) => {
          setMoving(false)
          void mailActions.moveTo(movable, dest, name).then(back)
        }}
      />
    </div>
  )
}

export function MailPage() {
  const { t } = useTranslation()
  const { params } = useLocation()
  const { view, thread } = parseMailParams(params)
  return (
    <div className="mail">
      <FolderNav view={view} />
      <section className="mail-main">
        <div className="mail-main__head compact-only">
          <FolderPicker view={view} />
        </div>
        {thread ? (
          <ThreadView key={`${thread.accountId}|${thread.threadId}`} view={view} accountId={thread.accountId} threadId={thread.threadId} />
        ) : (
          <MailList view={view} />
        )}
      </section>
      <button type="button" className="fab fab--floating compact-only" onClick={() => openNew()} aria-label={t('compose.compose')}>
        <Icon name="edit" />
      </button>
    </div>
  )
}
