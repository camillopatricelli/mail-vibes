import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

/**
 * Strict Content Security Policy, injected only into production builds.
 * (Vite's dev server needs inline scripts for hot reload, so dev runs without it.)
 * GitHub Pages cannot send HTTP headers, so the policy is delivered as a <meta> tag;
 * `frame-ancestors` is not supported that way and is therefore omitted.
 */
/**
 * IMAP bridges (docs/imap-bridge.md) are deployed by each user, so their address isn't known at
 * build time: any Cloudflare workers.dev address is allowed, plus custom domains listed at build
 * time in VITE_BRIDGE_ORIGINS (comma-separated, e.g. "wss://bridge.example.com").
 */
export const bridgeOrigins = (process.env.VITE_BRIDGE_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^wss:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s))

const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets pdf.js run its bundled WebAssembly image decoders (no JS eval).
  // Google Maps (place suggestions) loads only when the user has set their own Maps key.
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client https://maps.googleapis.com https://maps.gstatic.com",
  // Email HTML relies heavily on inline <style>; the email frame is sandboxed without scripts.
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.googleapis.com https://maps.gstatic.com https://accounts.google.com wss://*.workers.dev https://*.workers.dev${bridgeOrigins.map((o) => ` ${o} ${o.replace(/^wss:/, 'https:')}`).join('')}`,
  "frame-src 'self' blob: https://accounts.google.com https://login.microsoftonline.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },
  }
}

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the app from /<repo>/; override with VITE_BASE when self-hosting elsewhere.
  base: process.env.VITE_BASE ?? (command === 'build' ? '/mail-vibes/' : '/'),
  plugins: [react(), cspPlugin()],
  define: { 'import.meta.env.VITE_BRIDGE_ORIGINS': JSON.stringify(bridgeOrigins.join(',')) },
  // The bridge's tests import the Worker, which needs Cloudflare's socket module.
  resolve: process.env.VITEST ? { alias: { 'cloudflare:sockets': fileURLToPath(new URL('./bridge/sockets-stub.js', import.meta.url)) } } : {},
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
}))
