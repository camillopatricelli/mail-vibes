import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Strict Content Security Policy, injected only into production builds.
 * (Vite's dev server needs inline scripts for hot reload, so dev runs without it.)
 * GitHub Pages cannot send HTTP headers, so the policy is delivered as a <meta> tag;
 * `frame-ancestors` is not supported that way and is therefore omitted.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  // Email HTML relies heavily on inline <style>; the email frame is sandboxed without scripts.
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.googleapis.com https://accounts.google.com",
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
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
}))
