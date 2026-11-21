import { useQueries } from '@tanstack/react-query'
import { useEffect } from 'react'
import i18n from '../i18n'
import { contactOf, setContacts, type Contact } from '../mail/addressBook'
import type { Address } from '../mail/types'
import { graph, type GraphPage } from '../providers/graph'
import { google } from '../providers/google'
import { queryClient } from '../lib/queryClient'
import { useSettings, type AccountSettings } from '../settings/store'
import { useStatus } from '../status/store'

/**
 * Contacts: Google Contacts (People API) and Outlook contacts (Graph). Contacts of every account
 * feed recipient suggestions; new contacts go to the default contacts account. Kept in memory only.
 */

const PEOPLE = 'https://people.googleapis.com/v1'

/** Google Contacts page of a person ("people/c123" -> …/person/c123), in the right account. */
const googleContactUrl = (resourceName: string, email: string) =>
  `https://contacts.google.com/person/${resourceName.split('/')[1]}?authuser=${encodeURIComponent(email)}`
const OUTLOOK_PEOPLE = 'https://outlook.office.com/people/'

const accountEmail = (accountId: string) => useSettings.getState().accounts.find((a) => a.id === accountId)?.email ?? ''

async function googleContacts(accountId: string): Promise<Contact[]> {
  type Person = { resourceName?: string; names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] }
  const email = accountEmail(accountId)
  const out: Contact[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ personFields: 'names,emailAddresses', pageSize: '1000' })
    if (pageToken) q.set('pageToken', pageToken)
    const r = await google<{ connections?: Person[]; nextPageToken?: string }>(accountId, `${PEOPLE}/people/me/connections?${q}`)
    for (const p of r.connections ?? [])
      for (const e of p.emailAddresses ?? [])
        if (e.value) out.push({ name: p.names?.[0]?.displayName ?? '', email: e.value, url: p.resourceName ? googleContactUrl(p.resourceName, email) : undefined })
    pageToken = r.nextPageToken
    if (!pageToken) break
  }
  return out
}

async function outlookContacts(accountId: string): Promise<Contact[]> {
  type GContact = { displayName?: string; emailAddresses?: { name?: string; address?: string }[] }
  const out: Contact[] = []
  let next: string | undefined = '/me/contacts?$top=500&$select=displayName,emailAddresses'
  for (let i = 0; next && i < 10; i++) {
    const page: GraphPage<GContact> = await graph<GraphPage<GContact>>(accountId, next, { quiet: true })
    for (const c of page.value)
      for (const e of c.emailAddresses ?? []) if (e.address) out.push({ name: c.displayName || e.name || '', email: e.address, url: OUTLOOK_PEOPLE })
    next = page['@odata.nextLink']
  }
  return out
}

export const loadContacts = (accountId: string) => (accountId.startsWith('google:') ? googleContacts(accountId) : outlookContacts(accountId))

const contactsKey = (accountId: string) => ['contacts', accountId] as const

/**
 * Loads every account's contacts into the address book: every 30 minutes, and when the app is
 * back in front after a couple of minutes (e.g. after editing a contact in another tab).
 */
export function useContactsSync() {
  const accounts = useSettings((s) => s.accounts)
  const preferred = useSettings((s) => s.defaults.contactsAccountId ?? s.accounts[0]?.id)
  const results = useQueries({
    queries: accounts.map((a) => ({
      queryKey: contactsKey(a.id),
      queryFn: () => loadContacts(a.id),
      staleTime: 2 * 60_000,
      refetchInterval: 30 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    })),
  })
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  useEffect(() => {
    results.forEach((r, i) => r.data && setContacts(accounts[i].id, r.data as Contact[], preferred ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, preferred])
}

/** Opens a contact in Google Contacts or Outlook. */
export function openContact(email: string) {
  const url = contactOf(email)?.url
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

/** The account new contacts are saved to: the chosen default, else the first account. */
export function contactsAccount(): AccountSettings | undefined {
  const s = useSettings.getState()
  return s.accounts.find((a) => a.id === s.defaults.contactsAccountId) ?? s.accounts[0]
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/)
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
}

/**
 * Saves an address as a new contact in the default contacts account, then shows it in a new tab
 * (Google Contacts or Outlook People) for editing. Must be called from a click: the tab is opened
 * right away (browsers block tabs opened later) and pointed at the contact once it exists.
 */
export async function addContact(a: Address) {
  const account = contactsAccount()
  const toast = useStatus.getState().toast
  if (!account) return
  const tab = window.open('about:blank', '_blank')
  if (tab) tab.opener = null
  const { first, last } = splitName(a.name && a.name !== a.email ? a.name : '')
  try {
    let url = OUTLOOK_PEOPLE
    if (account.provider === 'google') {
      const p = await google<{ resourceName: string }>(account.id, `${PEOPLE}/people:createContact?personFields=names`, {
        method: 'POST',
        body: { ...(first && { names: [{ givenName: first, familyName: last || undefined }] }), emailAddresses: [{ value: a.email }] },
      })
      url = googleContactUrl(p.resourceName, account.email)
    } else
      await graph(account.id, '/me/contacts', {
        method: 'POST',
        body: { givenName: first || undefined, surname: last || undefined, emailAddresses: [{ address: a.email, name: a.name || a.email }] },
      })
    if (tab) tab.location.href = url
    toast({ tone: 'success', message: i18n.t('contacts.added', { address: a.email, account: account.email }) })
    void queryClient.invalidateQueries({ queryKey: contactsKey(account.id) })
  } catch (e) {
    tab?.close()
    toast({ tone: 'error', message: i18n.t('contacts.addFailed', { reason: (e as Error).message }) })
  }
}
