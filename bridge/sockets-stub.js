// Stand-in for Cloudflare's `cloudflare:sockets` module, used only by the tests.
export function connect() {
  throw new Error('connect() is not available in tests')
}
