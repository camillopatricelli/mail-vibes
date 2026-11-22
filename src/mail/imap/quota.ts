import { asList, asText, type ImapResponse } from './parse'

/**
 * Mailbox storage from GETQUOTAROOT (servers with QUOTA): "* QUOTA "" (STORAGE 512 1024)", in KB.
 * A full mailbox refuses new mail, which for a PEC mailbox means certified mail sent to you
 * bounces: the app warns before that happens.
 */
export interface Usage {
  usedKb: number
  limitKb: number
}

export function storageUsage(responses: ImapResponse[]): Usage | undefined {
  let worst: Usage | undefined
  for (const r of responses) {
    if (r.type !== 'QUOTA') continue
    const items = asList(r.values[1]).map(asText)
    for (let i = 0; i + 2 < items.length; i += 3) {
      if (items[i].toUpperCase() !== 'STORAGE') continue
      const usedKb = Number(items[i + 1])
      const limitKb = Number(items[i + 2])
      if (!(limitKb > 0) || !(usedKb >= 0)) continue
      if (!worst || usedKb / limitKb > worst.usedKb / worst.limitKb) worst = { usedKb, limitKb }
    }
  }
  return worst
}

/** Warn from 90% full. */
export const nearlyFull = (u: Usage) => u.usedKb / u.limitKb >= 0.9

/** "1.2 GB", "850 MB" */
export function formatKb(kb: number) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} GB`
  return `${Math.max(1, Math.round(kb / 1024))} MB`
}
