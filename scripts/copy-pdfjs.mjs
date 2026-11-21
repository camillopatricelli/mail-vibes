// Copies the pdf.js runtime assets (fonts, character maps, wasm decoders) into public/pdfjs
// so they are served from our own origin (CSP: no third-party hosts). Runs before dev/build.
import { cpSync, mkdirSync, rmSync } from 'node:fs'

const src = 'node_modules/pdfjs-dist'
const dest = 'public/pdfjs'
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(`${src}/${dir}`, `${dest}/${dir}`, { recursive: true })
}
console.log('pdf.js assets copied to', dest)
