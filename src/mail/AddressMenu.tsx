import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { addContact, contactsAccount, openContact } from '../contacts/contacts'
import { useStatus } from '../status/store'
import { Menu } from '../ui/overlay'
import { contactOf, formatAddress } from './addressBook'
import { openNew } from './compose'
import type { Address } from './types'
import { navigate } from '../lib/router'
import { isMailCapable } from './api'

/**
 * An address in a message: click or right-click for "Write", "Copy" and "Add to contacts".
 * With `ruleAccountId` (the sender of a message in that account), also "Create a rule".
 */
export function AddressMenu({ address, children, className, ruleAccountId }: { address: Address; children: ReactNode; className?: string; ruleAccountId?: string }) {
  const { t } = useTranslation()
  const target = contactsAccount()
  const known = contactOf(address.email)
  return (
    <Menu
      label={address.email}
      trigger={(p) => (
        <button
          type="button"
          className={['address-link', className].filter(Boolean).join(' ')}
          title={formatAddress(address)}
          aria-expanded={p['aria-expanded']}
          aria-haspopup={p['aria-haspopup']}
          onClick={(e) => {
            e.stopPropagation()
            p.onClick()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            p.onClick()
          }}
        >
          {children}
        </button>
      )}
      items={[
        { label: t('contacts.write'), icon: 'edit', onSelect: () => openNew(undefined, { to: [address] }) },
        {
          label: t('contacts.copy'),
          icon: 'content_copy',
          onSelect: () =>
            void navigator.clipboard.writeText(address.email).then(() => useStatus.getState().toast({ tone: 'success', message: t('contacts.copied') })),
        },
        known
          ? { label: t('contacts.open'), icon: 'contacts', disabled: !known.url, onSelect: () => openContact(address.email) }
          : { label: t('contacts.add', { account: target?.email ?? '' }), icon: 'person_add', disabled: !target, onSelect: () => void addContact(address) },
        ...(ruleAccountId && isMailCapable(ruleAccountId)
          ? [{ label: t('rules.fromSender'), icon: 'filter_list' as const, onSelect: () => navigate('rules', 'new', ruleAccountId, address.email) }]
          : []),
      ]}
    />
  )
}
