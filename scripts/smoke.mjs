// Smoke test: loads each page in headless Edge/Chrome, reports console errors and saves screenshots.
// Usage: node scripts/smoke.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const base = process.argv[2] ?? 'http://localhost:5173/'
const out = process.argv[3] ?? 'test-results/smoke'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge' })
let failures = 0
for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
]) {
  const page = await browser.newPage({ viewport, locale: 'en-GB' })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  for (const route of ['today', 'mail/inbox', 'calendar', 'tasks', 'settings', 'privacy', 'setup/org/bad']) {
    await page.goto(`${base}#/${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/${name}-${route.replace(/\//g, '_')}.png`, fullPage: false })
  }
  if (errors.length) {
    failures += errors.length
    console.log(`[${name}] console errors:\n  ` + errors.join('\n  '))
  } else console.log(`[${name}] no console errors`)
  await page.close()
}
await browser.close()
process.exit(failures ? 1 : 0)
