import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { displayName, fullDate, listDate } from '../lib/format'
import { href, navigate, useLocation } from '../lib/router'
import { timeAgo, useNow } from '../lib/time'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { AccountBadge, Button, EmptyState, Icon, IconButton, type IconName } from '../ui/components'
import { Dialog, Menu, Spinner } from '../ui/overlay'
import { formatAddress } from './addressBook'
import { AttachmentList } from './Attachments'
import { openDraft, openNew, openReply } from './compose'
import { mailActions, useFolders, useMergedFolder, useThread, useUnreadCounts, type ThreadSummary } from './data'
import { MessageBody } from './MessageBody'
import { providerFor } from './api'
import { folderKinds, type FolderKind, type MailMessage } from './types'
import { useQuery } from '@tanstack/react-query'

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

function FolderNav({ folder }: { folder: FolderKind }) {
  const { t } = useTranslation()
  const inboxUnread = useUnreadCounts('inbox')
  return (
    <nav className="mail-nav" aria-label={t('mail.folders')}>
      <button type="button" className="fab" onClick={() => openNew()}>
        <Icon name="edit" />
        <span className="label-large">{t('compose.compose')}</span>
      </button>
      <ul>
        {folderKinds.map((f) => (
          <li key={f}>
            <a href={href('mail', f)} className={['mail-nav__item', f === folder && 'is-active'].filter(Boolean).join(' ')} aria-current={f === folder ? 'page' : undefined}>
              <Icon name={folderIcons[f]} filled={f === folder} />
              <span className="label-large">{t(`mail.folder.${f}`)}</span>
              {f === 'inbox' && inboxUnread > 0 && <span className="label-medium mail-nav__count">{inboxUnread}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function FolderPicker({ folder }: { folder: FolderKind }) {
  const { t } = useTranslation()
  return (
    <select className="select folder-picker compact-only" value={folder} onChange={(e) => navigate('mail', e.target.value)} aria-label={t('mail.folders')}>
      {folderKinds.map((f) => (
        <option key={f} value={f}>
          {t(`mail.folder.${f}`)}
        </option>
      ))}
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
    <span className={['body-small', anyError ? 'sync-status--error' : 'muted'].join(' ')} title={accounts.map((a) => `${a.email}: ${status[a.id]?.lastSuccessAt ? timeAgo(status[a.id]!.lastSuccessAt!, now) : t('accounts.neverUpdated')}`).join('\n')}>
      {anyError ? t('mail.someAccountsFailing') : oldest ? t('accounts.lastUpdated', { ago: timeAgo(oldest, now) }) : t('accounts.neverUpdated')}
    </span>
  )
}

function ThreadRow({ th, folder, account, selected, onSelect }: { th: ThreadSummary; folder: FolderKind; account?: AccountSettings; selected: boolean; onSelect: (v: boolean) => void }) {
  const { t } = useTranslation()
  const items = itemsOf([th])
  const open = () => {
    if (folder === 'drafts' && th.hasDraft && th.messages.length === 1) void openDraft(th.accountId, th.messages[0].id)
    else navigate('mail', folder, 't', th.accountId, th.threadId)
  }
  const senders = folder === 'sent' || folder === 'drafts' ? th.messages[th.messages.length - 1].to.map(displayName).join(', ') : th.participants.map(displayName).join(', ')
  const label = account ? account.displayName || account.email : ''
  return (
    <li className={['thread-row', th.unread && 'is-unread', selected && 'is-selected'].filter(Boolean).join(' ')} style={{ borderLeftColor: account?.color }}>
      <input type="checkbox" className="thread-row__check" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={t('mail.select', { subject: th.subject })} />
      <IconButton
        icon="star"
        className="thread-row__star"
        selected={th.flagged}
        label={th.flagged ? t('mail.unstar') : t('mail.star')}
        onClick={() =>
          void mailActions.setFlagged(th.flagged ? items.filter((_, i) => th.messages[i].isFlagged) : [items[items.length - 1]], !th.flagged)
        }
      />
      <button type="button" className="thread-row__main" onClick={open}>
        <span className="thread-row__from">
          {account && <AccountBadge color={account.color} label={label} size={18} />}
          <span className="thread-row__senders">{senders || t('mail.noRecipients')}</span>
          {th.messages.length > 1 && <span className="thread-row__count body-small muted">{th.messages.length}</span>}
          {th.hasDraft && folder !== 'drafts' && <span className="draft-label body-small">{t('mail.draft')}</span>}
        </span>
        <span className="thread-row__text">
          <span className="thread-row__subject">{th.subject || t('mail.noSubject')}</span>
          <span className="thread-row__snippet muted"> – {th.snippet}</span>
        </span>
        <span className="thread-row__meta">
          {th.hasAttachments && <Icon name="attach_file" size={18} label={t('mail.hasAttachments')} />}
          <span className="thread-row__date body-small">{listDate(th.date)}</span>
        </span>
      </button>
      <span className="thread-row__actions">
        {folder === 'inbox' && <IconButton icon="archive" label={t('mail.archive')} onClick={() => void mailActions.archive(items, 1)} />}
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

function MoveDialog({ open, onClose, accountIds, onPick }: { open: boolean; onClose: () => void; accountIds: string[]; onPick: (accountId: string, folderId: string, name: string) => void }) {
  const { t } = useTranslation()
  const single = accountIds.length === 1 ? accountIds[0] : undefined
  const folders = useFolders(open ? single : undefined)
  return (
    <Dialog open={open} onClose={onClose} title={t('mail.moveTo')}>
      {!single ? (
        <p className="body-medium">{t('mail.moveOneAccount')}</p>
      ) : folders.isPending ? (
        <Spinner label={t('mail.loading')} />
      ) : folders.error ? (
        <p className="field-error" role="alert">
          {(folders.error as Error).message}
        </p>
      ) : (
        <ul className="folder-list">
          {folders.data!.map((f) => (
            <li key={f.id}>
              <button type="button" style={{ paddingLeft: 16 + f.depth * 20 }} onClick={() => onPick(single, f.id, f.name)}>
                <Icon name="folder" size={20} />
                <span className="body-large">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function MailList({ folder }: { folder: FolderKind }) {
  const { t } = useTranslation()
  const { accounts, threads, hasMore, isLoading, isFetching, errors, loadMore, refresh } = useMergedFolder(folder)
  const accountMap = useAccountMap()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  useEffect(() => setSelected(new Set()), [folder])

  const sel = threads.filter((th) => selected.has(th.key))
  const selItems = itemsOf(sel)
  const clear = () => setSelected(new Set())
  const allSelected = threads.length > 0 && sel.length === threads.length

  if (!accounts.length) {
    const any = useSettings.getState().accounts.length > 0
    return <EmptyState icon="inbox" title={any ? t('mail.allHidden') : t('accounts.none')} body={!any && <a href={href('settings')}>{t('accounts.addFirst')}</a>} />
  }

  return (
    <div className="mail-list">
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
            {folder === 'inbox' && <IconButton icon="archive" label={t('mail.archive')} onClick={() => void mailActions.archive(selItems, sel.length).then(clear)} />}
            {folder === 'trash' ? (
              <>
                <IconButton icon="inbox" label={t('mail.restore')} onClick={() => void mailActions.moveToInbox(selItems, sel.length).then(clear)} />
                <IconButton
                  icon="delete"
                  label={t('mail.deleteForever')}
                  onClick={() => {
                    if (confirm(t('mail.confirmDeleteForever', { count: sel.length }))) void mailActions.deleteForever(selItems, sel.length).then(clear)
                  }}
                />
              </>
            ) : (
              <IconButton icon="delete" label={t('mail.delete')} onClick={() => void mailActions.trash(selItems, sel.length).then(clear)} />
            )}
            {folder === 'spam' && <IconButton icon="inbox" label={t('mail.notSpam')} onClick={() => void mailActions.moveToInbox(selItems, sel.length).then(clear)} />}
            <IconButton icon="mark_email_read" label={t('mail.markRead')} onClick={() => void mailActions.setRead(selItems, true).then(clear)} />
            <IconButton icon="mark_email_unread" label={t('mail.markUnread')} onClick={() => void mailActions.setRead(selItems, false).then(clear)} />
            <IconButton icon="drive_file_move" label={t('mail.moveTo')} onClick={() => setMoving(true)} />
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
        <EmptyState icon={folderIcons[folder]} title={t('mail.empty')} />
      ) : (
        <ul className="thread-list">
          {threads.map((th) => (
            <ThreadRow
              key={th.key}
              th={th}
              folder={folder}
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
        onPick={(_a, folderId, name) => {
          setMoving(false)
          void mailActions.moveToFolder(selItems, folderId, name).then(clear)
        }}
      />
    </div>
  )
}

function MessageCard({ m, expanded, onToggle, account }: { m: MailMessage; expanded: boolean; onToggle: () => void; account?: AccountSettings }) {
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
      <li className="message is-collapsed">
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
    <li className="message">
      <header className="message__head">
        <AccountBadge color={account?.color ?? '#888'} label={displayName(m.from)} size={40} />
        <button type="button" className="message__who" onClick={onToggle} aria-expanded>
          <span className="title-small">{displayName(m.from)}</span> <span className="body-small muted">&lt;{m.from.email}&gt;</span>
          <span className="body-small muted message__to">
            {t('mail.toList', { list: recipients.map((a) => formatAddress(a)).join(', ') || '—' })}
          </span>
        </button>
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
                { label: t('mail.markUnreadFromHere'), icon: 'mark_email_unread', onSelect: () => void mailActions.setRead([m], false) },
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

function ThreadView({ folder, accountId, threadId }: { folder: FolderKind; accountId: string; threadId: string }) {
  const { t } = useTranslation()
  const q = useThread(accountId, threadId)
  const account = useSettings((s) => s.accounts.find((a) => a.id === accountId))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  const back = () => navigate('mail', folder)
  // Messages that were unread when the conversation opened stay expanded after being marked read.
  const initiallyUnread = useRef<Set<string> | null>(null)
  if (q.data && !initiallyUnread.current) initiallyUnread.current = new Set(q.data.filter((m) => !m.isRead).map((m) => m.id))

  const all = q.data ?? []
  const viewingTrash = folder === 'trash' || folder === 'spam'
  const messages = viewingTrash ? all : all.filter((m) => m.folderKind !== 'trash' && m.folderKind !== 'spam')
  const latest = [...messages].reverse().find((m) => !m.isDraft) ?? messages[messages.length - 1]

  // Opening a conversation marks it read (as in Gmail).
  const unreadIds = messages.filter((m) => !m.isRead).map((m) => m.id).join(',')
  useEffect(() => {
    if (unreadIds) void mailActions.setRead(messages.filter((m) => !m.isRead), true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadIds])

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
  if (!messages.length) return <EmptyState icon="mail" title={t('mail.threadGone')} body={<a href={href('mail', folder)}>{t('mail.back')}</a>} />

  const inInbox = messages.filter((m) => m.folderKind === 'inbox')
  const notTrashed = messages.filter((m) => m.folderKind !== 'trash')
  const movable = messages.filter((m) => m.folderKind !== 'sent' && m.folderKind !== 'drafts' && m.folderKind !== 'trash')
  const isExpanded = (m: MailMessage) => expanded.has(m.id) !== (m.id === latest?.id || !!initiallyUnread.current?.has(m.id))

  return (
    <div className="thread">
      <div className="list-toolbar">
        <IconButton icon="arrow_back" label={t('mail.back')} onClick={back} />
        {inInbox.length > 0 && <IconButton icon="archive" label={t('mail.archive')} onClick={() => void mailActions.archive(inInbox, 1).then(back)} />}
        {notTrashed.length > 0 ? (
          <IconButton icon="delete" label={t('mail.delete')} onClick={() => void mailActions.trash(notTrashed, 1).then(back)} />
        ) : (
          <IconButton
            icon="delete"
            label={t('mail.deleteForever')}
            onClick={() => {
              if (confirm(t('mail.confirmDeleteForever', { count: 1 }))) void mailActions.deleteForever(messages, 1).then(back)
            }}
          />
        )}
        {viewingTrash && <IconButton icon="inbox" label={folder === 'spam' ? t('mail.notSpam') : t('mail.restore')} onClick={() => void mailActions.moveToInbox(messages, 1).then(back)} />}
        {latest && <IconButton icon="mark_email_unread" label={t('mail.markUnread')} onClick={() => void mailActions.setRead([latest], false).then(back)} />}
        {movable.length > 0 && <IconButton icon="drive_file_move" label={t('mail.moveTo')} onClick={() => setMoving(true)} />}
        <span className="spacer" />
        {account && (
          <span className="thread__account body-small" style={{ borderColor: account.color }}>
            <AccountBadge color={account.color} label={account.displayName || account.email} size={16} />
            {account.email}
          </span>
        )}
      </div>
      <h1 className="headline-small thread__subject">{latest?.subject || t('mail.noSubject')}</h1>
      <ul className="messages">
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            m={m}
            account={account}
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
      <MoveDialog
        open={moving}
        onClose={() => setMoving(false)}
        accountIds={[accountId]}
        onPick={(_a, folderId, name) => {
          setMoving(false)
          void mailActions.moveToFolder(movable, folderId, name).then(back)
        }}
      />
    </div>
  )
}

export function MailPage() {
  const { t } = useTranslation()
  const { params } = useLocation()
  const folder = (folderKinds as string[]).includes(params[0]) ? (params[0] as FolderKind) : 'inbox'
  const inThread = params[1] === 't' && params[2] && params[3]
  return (
    <div className="mail">
      <FolderNav folder={folder} />
      <section className="mail-main">
        <div className="mail-main__head compact-only">
          <FolderPicker folder={folder} />
        </div>
        {inThread ? <ThreadView key={`${params[2]}|${params[3]}`} folder={folder} accountId={params[2]} threadId={params[3]} /> : <MailList folder={folder} />}
      </section>
      <button type="button" className="fab fab--floating compact-only" onClick={() => openNew()} aria-label={t('compose.compose')}>
        <Icon name="edit" />
      </button>
    </div>
  )
}
