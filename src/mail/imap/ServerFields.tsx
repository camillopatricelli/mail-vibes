import { useTranslation } from 'react-i18next'
import type { Security } from './bridge'
import type { ServerConfig } from './client'

/** Server settings as typed in a form (the port as text while editing). */
export interface ServerForm {
  host: string
  port: string
  security: Security
  username: string
}

export const emptyServer = (port: number, security: Security): ServerForm => ({ host: '', port: String(port), security, username: '' })

export function ServerFields({ value, onChange, prefix }: { value: ServerForm; onChange: (v: ServerForm) => void; prefix: string }) {
  const { t } = useTranslation()
  const set = (p: Partial<ServerForm>) => onChange({ ...value, ...p })
  return (
    <div className="imap-server">
      <label className="imap-server__host">
        <span className="body-small">{t('imap.host')}</span>
        <input className="text-field text-field--outlined" value={value.host} spellCheck={false} autoComplete="off" name={`${prefix}-host`} onChange={(e) => set({ host: e.target.value.trim() })} />
      </label>
      <label>
        <span className="body-small">{t('imap.port')}</span>
        <input className="text-field text-field--outlined imap-server__port" inputMode="numeric" value={value.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />
      </label>
      <label>
        <span className="body-small">{t('imap.security')}</span>
        <select className="select" value={value.security} onChange={(e) => set({ security: e.target.value as Security })}>
          <option value="tls">{t('imap.securityTls')}</option>
          <option value="starttls">STARTTLS</option>
        </select>
      </label>
      <label className="imap-server__user">
        <span className="body-small">{t('imap.username')}</span>
        <input className="text-field text-field--outlined" value={value.username} spellCheck={false} autoComplete="off" name={`${prefix}-user`} onChange={(e) => set({ username: e.target.value.trim() })} />
      </label>
    </div>
  )
}

export const toServer = (f: ServerForm): ServerConfig => ({ host: f.host, port: Number(f.port), security: f.security, username: f.username })
export const filled = (f: ServerForm) => !!f.host && !!f.port && !!f.username
export const toForm = (s: ServerConfig): ServerForm => ({ host: s.host, port: String(s.port), security: s.security, username: s.username })
