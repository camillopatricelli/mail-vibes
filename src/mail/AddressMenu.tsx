import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { addContact, contactsAccount } from '../contacts/contacts'
import { useStatus } from '../status/store'
import { Menu } from '../ui/overlay'
import { formatAddress, isContact } from './addressBook'
import { openNew } from './compose'
import type { Address } from './types'

/** An address in a message: click or right-click for "Write", "Copy" and "Add to contacts". */
export function AddressMenu({ address, children, className }: { address: Address; children: ReactNode; className?: string }) {
  const { t } = useTranslation()
  const target = contactsAccount()
  const known = isContact(address.email)
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
          ? { label: t('contacts.already'), icon: 'contacts', disabled: true, onSelect: () => undefined }
          : { label: t('contacts.add', { account: target?.email ?? '' }), icon: 'person_add', disabled: !target, onSelect: () => void addContact(address) },
      ]}
    />
  )
}
