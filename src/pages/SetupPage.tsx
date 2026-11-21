import { useTranslation } from 'react-i18next'
import { decodeOrg } from '../lib/setupLink'
import { navigate } from '../lib/router'
import { selectTenants, useSettings } from '../settings/store'
import { useStatus } from '../status/store'
import { Button, Card } from '../ui/components'

/** Confirmation page for a shared organisation setup link (#/setup/org/<payload>). */
export function SetupPage({ params }: { params: string[] }) {
  const { t } = useTranslation()
  const customTenants = useSettings((s) => s.customTenants)
  const tenantNames = useSettings((s) => s.tenantNames)
  const addTenant = useSettings((s) => s.addTenant)
  const toast = useStatus((s) => s.toast)

  const org = params[0] === 'org' && params[1] ? decodeOrg(params[1]) : null
  const existing =
    org &&
    selectTenants({ customTenants, tenantNames }).find(
      (x) => x.clientId.toLowerCase() === org.clientId && x.tenantId.toLowerCase() === org.tenantId,
    )

  return (
    <div className="settings">
      <h1 className="headline-small page-title">{t('setup.title')}</h1>
      <Card className="settings__section">
        {!org ? (
          <p className="body-medium field-error" role="alert">
            {t('setup.invalid')}
          </p>
        ) : existing ? (
          <p className="body-medium">{t('setup.already', { name: existing.name })}</p>
        ) : (
          <>
            <p className="body-large">{t('setup.confirm', { name: org.name })}</p>
            <p className="body-small muted">
              {t('settings.clientId')}: <code>{org.clientId}</code>
              <br />
              {t('settings.tenantId')}: <code>{org.tenantId}</code>
            </p>
            <p className="body-medium muted">{t('setup.explain')}</p>
          </>
        )}
        <div className="row-wrap" style={{ marginTop: 16 }}>
          {org && !existing && (
            <Button
              variant="filled"
              icon="add"
              onClick={() => {
                addTenant(org)
                toast({ tone: 'success', message: t('setup.added', { name: org.name }) })
                navigate('settings')
              }}
            >
              {t('settings.addTenant')}
            </Button>
          )}
          <Button variant="text" onClick={() => navigate('settings')}>
            {org && !existing ? t('settings.cancel') : t('nav.settings')}
          </Button>
        </div>
      </Card>
    </div>
  )
}
