import DOMPurify from 'dompurify'

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Inserts `html` right after the opening <body> tag of a full HTML document (or prepends it). */
export function insertIntoBody(doc: string, html: string) {
  const m = /<body[^>]*>/i.exec(doc)
  if (!m) return html + doc
  const at = m.index + m[0].length
  return doc.slice(0, at) + html + doc.slice(at)
}

export interface SanitizeOptions {
  allowRemoteImages: boolean
  /** contentId -> object URL for inline images */
  inlineImages?: Map<string, string>
}

export interface SanitizedEmail {
  /** Complete document for the sandboxed iframe's srcdoc */
  srcdoc: string
  blockedImages: number
  hasQuoted: boolean
}

const REMOTE = /^(https?:)?\/\//i
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi

function cleanCss(css: string, allowRemote: boolean) {
  let out = css.replace(/@import[^;]+;?/gi, '')
  if (!allowRemote) out = out.replace(CSS_REMOTE_URL, 'none')
  // Expressions / behaviours (old IE) and javascript: URLs are never allowed.
  return out.replace(/expression\s*\(|behavior\s*:|javascript:/gi, '')
}

/** Baseline styles inside the email frame (emails are rendered on white, as in Gmail). */
const FRAME_CSS = `
html{background:#fff;color:#202124;}
body{margin:0;padding:0 2px;font:14px/1.5 Roboto,Arial,sans-serif;overflow-wrap:anywhere;}
img{max-width:100%;height:auto;}
table{max-width:100%;}
pre{white-space:pre-wrap;}
blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;}
.mv-quoted[hidden]{display:none!important;}
a{color:#1a73e8;}
`
/** Appended after the email's own styles so its html/body height rules can't break frame sizing. */
const FRAME_SIZING_CSS = `html,body{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;}`

const QUOTE_SELECTORS = ['.gmail_quote', '#divRplyFwdMsg', '#appendonsend', 'blockquote[type="cite"]', '.moz-cite-prefix']

/**
 * Sanitizes an email body for display: strips scripts, forms, event handlers and external
 * stylesheets; blocks remote images unless allowed; maps cid: images; forces links to open in a
 * new tab; wraps quoted history so it can be shown on demand.
 */
export function sanitizeEmail(html: string, opts: SanitizeOptions): SanitizedEmail {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const styles = [...parsed.querySelectorAll('style')].map((s) => cleanCss(s.textContent ?? '', opts.allowRemoteImages)).join('\n')
  parsed.querySelectorAll('style').forEach((s) => s.remove())

  let blocked = 0
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? ''
      el.removeAttribute('srcset')
      if (/^cid:/i.test(src)) {
        const url = opts.inlineImages?.get(src.slice(4).replace(/^<|>$/g, ''))
        if (url) el.setAttribute('src', url)
        else el.removeAttribute('src')
      } else if (REMOTE.test(src) && !opts.allowRemoteImages) {
        el.removeAttribute('src')
        el.setAttribute('data-blocked', '1')
        blocked++
      }
    }
    if (el.hasAttribute('background')) {
      if (!opts.allowRemoteImages && REMOTE.test(el.getAttribute('background') ?? '')) blocked++
      el.removeAttribute('background')
    }
    const style = el.getAttribute('style')
    if (style) {
      const cleaned = cleanCss(style, opts.allowRemoteImages)
      if (cleaned !== style && !opts.allowRemoteImages && CSS_REMOTE_URL.test(style)) blocked++
      CSS_REMOTE_URL.lastIndex = 0
      el.setAttribute('style', cleaned)
    }
  })
  let body: DocumentFragment
  try {
    body = DOMPurify.sanitize(parsed.body.innerHTML, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'audio', 'video', 'svg', 'math', 'style'],
      FORBID_ATTR: ['action', 'formaction', 'ping'],
      ALLOW_DATA_ATTR: false,
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }

  // Wrap quoted history (everything from the first quote marker onward at its level).
  const container = document.createElement('div')
  container.appendChild(body)
  let hasQuoted = false
  const marker = container.querySelector(QUOTE_SELECTORS.join(','))
  if (marker && marker !== container.firstElementChild) {
    let start: Element = marker
    // Outlook puts an <hr> right before the "From:" block.
    const prev = start.previousElementSibling
    if (prev?.tagName === 'HR') start = prev
    const wrap = document.createElement('div')
    wrap.className = 'mv-quoted'
    wrap.hidden = true
    start.parentNode!.insertBefore(wrap, start)
    let n: ChildNode | null = start
    while (n) {
      const next: ChildNode | null = n.nextSibling
      wrap.appendChild(n)
      n = next
    }
    hasQuoted = (wrap.textContent ?? '').trim().length > 0
    if (!hasQuoted) wrap.replaceWith(...wrap.childNodes)
  }

  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${FRAME_CSS}</style><style>${styles.replace(/<\/style/gi, '')}</style><style>${FRAME_SIZING_CSS}</style></head><body>${container.innerHTML}</body></html>`
  return { srcdoc, blockedImages: blocked, hasQuoted }
}

/** Sanitizes HTML that will be placed in the compose editor (e.g. an existing draft). */
export function sanitizeForEditor(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return DOMPurify.sanitize(parsed.body.innerHTML, {
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'style', 'script'],
    ALLOW_DATA_ATTR: false,
  })
}

export function htmlToText(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}
