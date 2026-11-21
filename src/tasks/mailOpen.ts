import i18n from '../i18n'
import { goMail } from '../mail/routes'
import type { MailSummary } from '../mail/types'
import { graph, ApiError } from '../providers/graph'
import { google } from '../providers/google'
import { useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import type { MailLink, MailSource } from './mailLink'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** The conversation of a linked email in one account, or undefined if the account doesn't have it. */
async function findThread(accountId: string, provider: MailLink['provider'], id: string): Promise<string | undefined> {
  const missing = (e: unknown) => e instanceof ApiError && (e.status === 400 || e.status === 404)
  try {
    if (provider === 'microsoft') {
      const m = await graph<{ conversationId: string }>(accountId, `/me/messages/${encodeURIComponent(id)}?$select=conversationId`)
      return m.conversationId
    }
    try {
      const th = await google<{ id: string }>(accountId, `${GMAIL}/threads/${encodeURIComponent(id)}?format=minimal&fields=id`)
      return th.id
    } catch (e) {
      if (!missing(e)) throw e
      const m = await google<{ threadId: string }>(accountId, `${GMAIL}/messages/${encodeURIComponent(id)}?format=minimal&fields=threadId`)
      return m.threadId
    }
  } catch (e) {
    if (missing(e)) return undefined
    throw e
  }
}

/**
 * Opens the email of a task in the app, looking in the accounts of the link's provider (the one
 * named by the link first, then the task's own). If none has it, offers the web address.
 */
export async function openMailLink(link: MailLink, taskAccountId: string) {
  const toast = useStatus.getState().toast
  const accounts = useSettings
    .getState()
    .accounts.filter((a) => a.provider === link.provider)
    .sort((a, b) => rank(b) - rank(a))
  function rank(a: { id: string; email: string }) {
    return (link.email && a.email.toLowerCase() === link.email.toLowerCase() ? 2 : 0) + (a.id === taskAccountId ? 1 : 0)
  }
  try {
    for (const a of accounts)
      for (const id of link.ids) {
        const threadId = await findThread(a.id, link.provider, id)
        if (threadId) return goMail({ kind: 'well', folder: 'inbox' }, { accountId: a.id, threadId })
      }
  } catch (e) {
    toast({ tone: 'error', message: i18n.t('tasks.mailOpenFailed', { reason: (e as Error).message }) })
    return
  }
  const url = link.url
  toast({
    tone: 'error',
    message: i18n.t('tasks.mailNotFound'),
    ...(url && { action: { label: i18n.t('tasks.openOnWeb'), run: () => void window.open(url, '_blank', 'noopener,noreferrer') } }),
  })
}

/** What a new task needs to link back to this email (Outlook's web address takes a request). */
export async function mailSource(m: MailSummary): Promise<MailSource> {
  const account = useSettings.getState().accounts.find((a) => a.id === m.accountId)
  if (m.accountId.startsWith('google:'))
    return {
      provider: 'google',
      id: m.threadId,
      subject: m.subject,
      url: `https://mail.google.com/mail/u/${encodeURIComponent(account?.email ?? '0')}/#all/${m.threadId}`,
    }
  let url = `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(m.id)}`
  try {
    url = (await graph<{ webLink?: string }>(m.accountId, `/me/messages/${encodeURIComponent(m.id)}?$select=webLink`)).webLink ?? url
  } catch {
    // Keep the generic address.
  }
  return { provider: 'microsoft', id: m.id, subject: m.subject, url }
}
