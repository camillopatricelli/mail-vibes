import { useTranslation } from 'react-i18next'
import { fullDate } from '../../lib/format'
import type { PecDetails } from '../types'

const KNOWN_TYPES = [
  'posta-certificata',
  'accettazione',
  'non-accettazione',
  'presa-in-carico',
  'avvenuta-consegna',
  'errore-consegna',
  'preavviso-errore-consegna',
  'rilevazione-virus',
]

/** The certification data of a PEC message or receipt (from its daticert.xml). */
export function PecBox({ pec }: { pec: PecDetails }) {
  const { t } = useTranslation()
  const type = KNOWN_TYPES.includes(pec.type) ? t(`imap.pecType.${pec.type}`) : pec.type
  const bad = pec.kind === 'error' || /^(non-|errore|preavviso|rilevazione)/.test(pec.type)
  const rows: [string, string | undefined][] = [
    [t('imap.pecCertifiedAt'), pec.date ? fullDate(pec.date) : undefined],
    [t('imap.pecSender'), pec.sender],
    [
      t('imap.pecRecipients'),
      pec.recipients.length
        ? pec.recipients.map((r) => `${r.email}${r.certified ? '' : ` (${t('imap.pecNotCertified')})`}`).join(', ')
        : undefined,
    ],
    [t('imap.pecDeliveredTo'), pec.deliveredTo],
    [t('imap.pecProblem'), pec.error],
    [t('imap.pecProvider'), pec.provider],
    [t('imap.pecId'), pec.id],
  ]
  return (
    <section className={['pec-box', bad && 'is-bad'].filter(Boolean).join(' ')} aria-label={t('imap.pecDetails')}>
      <header className="pec-box__head">
        <span className="pec-badge label-medium">PEC</span>
        <span className="title-small">{type}</span>
      </header>
      <dl className="pec-box__rows body-small">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt className="muted">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      {pec.envelopeAttachmentId && <p className="body-small muted pec-box__note">{t('imap.pecProofAttached')}</p>}
    </section>
  )
}
