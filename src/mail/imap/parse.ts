/**
 * IMAP4rev1 / rev2 response parsing (RFC 3501, RFC 9051), working on bytes so that literals
 * (message bodies, attachments) stay binary.
 */

/** An atom or quoted string (string), a literal (bytes), NIL (null), or a parenthesised list. */
export type ImapValue = string | Uint8Array | null | ImapValue[]

export interface ImapResponse {
  /** '*' for untagged, '+' for a continuation request, else the command tag */
  tag: string
  /** Upper-case response name: OK, NO, BAD, BYE, PREAUTH, CAPABILITY, LIST, FETCH, EXISTS, … */
  type: string
  /** The number before the name in "* 12 EXISTS" / "* 3 FETCH (…)" */
  num?: number
  /** Response code of a status response: "[UIDVALIDITY 123]" -> { name: 'UIDVALIDITY', args: ['123'] } */
  code?: { name: string; args: ImapValue[] }
  /** Human-readable text of a status response or continuation */
  text?: string
  /** The values after the name (data responses) */
  values: ImapValue[]
}

const STATUS = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'])
const CR = 13
const LF = 10

/**
 * Splits the incoming byte stream into complete responses: a line, plus any literals ("{n}\r\n"
 * followed by n bytes) and the line parts after them.
 */
export class ResponseSplitter {
  private buf = new Uint8Array(0)
  private start = 0

  push(chunk: Uint8Array): Uint8Array[] {
    const rest = this.buf.subarray(this.start)
    const joined = new Uint8Array(rest.length + chunk.length)
    joined.set(rest)
    joined.set(chunk, rest.length)
    this.buf = joined
    this.start = 0
    const out: Uint8Array[] = []
    for (;;) {
      const end = this.completeAt(this.start)
      if (end < 0) break
      out.push(this.buf.slice(this.start, end))
      this.start = end
    }
    return out
  }

  /** Index just after the CRLF that ends the response starting at `from`, or -1 if incomplete. */
  private completeAt(from: number) {
    let i = from
    const b = this.buf
    for (;;) {
      let lf = -1
      for (let j = i; j < b.length; j++)
        if (b[j] === LF) {
          lf = j
          break
        }
      if (lf < 0) return -1
      const lit = literalLength(b, from, lf)
      if (lit === undefined) return lf + 1
      if (lf + 1 + lit > b.length) return -1
      i = lf + 1 + lit
    }
  }
}

/** If the line ending at `lf` ends with "{n}" or "{n+}", the literal's length. */
function literalLength(b: Uint8Array, from: number, lf: number) {
  let end = lf
  if (end > from && b[end - 1] === CR) end--
  if (end <= from || b[end - 1] !== 0x7d /* } */) return undefined
  let j = end - 2
  if (b[j] === 0x2b /* + */ || b[j] === 0x2d /* - */) j--
  let digits = ''
  while (j >= from && b[j] >= 0x30 && b[j] <= 0x39) digits = String.fromCharCode(b[j--]) + digits
  if (!digits || b[j] !== 0x7b /* { */) return undefined
  // A literal must follow a space, a "(" or "~" (binary); this rules out "{" inside text.
  return Number(digits)
}

const utf8 = new TextDecoder()

class Tokenizer {
  i = 0
  constructor(readonly b: Uint8Array) {}

  get done() {
    return this.i >= this.b.length || this.b[this.i] === CR || this.b[this.i] === LF
  }
  peek() {
    return this.b[this.i]
  }
  skipSpaces() {
    while (this.b[this.i] === 0x20) this.i++
  }

  /** The rest of the line as text (status text). */
  rest() {
    let e = this.i
    while (e < this.b.length && this.b[e] !== CR && this.b[e] !== LF) e++
    const s = utf8.decode(this.b.subarray(this.i, e))
    this.i = e
    return s
  }

  value(): ImapValue {
    this.skipSpaces()
    const c = this.peek()
    if (c === 0x28 /* ( */) {
      this.i++
      const list: ImapValue[] = []
      for (;;) {
        this.skipSpaces()
        if (this.done) return list
        if (this.peek() === 0x29 /* ) */) {
          this.i++
          return list
        }
        list.push(this.value())
      }
    }
    if (c === 0x22 /* " */) return this.quoted()
    if (c === 0x7b /* { */ || (c === 0x7e /* ~ */ && this.b[this.i + 1] === 0x7b)) {
      const lit = this.literal()
      if (lit) return lit
    }
    const atom = this.atom()
    return atom.toUpperCase() === 'NIL' ? null : atom
  }

  quoted() {
    this.i++
    const bytes: number[] = []
    while (this.i < this.b.length && this.b[this.i] !== 0x22) {
      if (this.b[this.i] === 0x5c /* \ */) this.i++
      bytes.push(this.b[this.i++])
    }
    this.i++
    return utf8.decode(Uint8Array.from(bytes))
  }

  literal(): Uint8Array | undefined {
    const save = this.i
    if (this.peek() === 0x7e) this.i++
    this.i++
    let digits = ''
    while (this.peek() >= 0x30 && this.peek() <= 0x39) digits += String.fromCharCode(this.b[this.i++])
    if (this.peek() === 0x2b || this.peek() === 0x2d) this.i++
    if (!digits || this.peek() !== 0x7d) {
      this.i = save
      return undefined
    }
    this.i++
    if (this.peek() === CR) this.i++
    if (this.peek() === LF) this.i++
    const n = Number(digits)
    const out = this.b.slice(this.i, this.i + n)
    this.i += n
    return out
  }

  /** An atom; "[...]" inside it (BODY[HEADER.FIELDS (FROM)]) is kept whole, spaces included. */
  atom() {
    const s = this.i
    let depth = 0
    while (this.i < this.b.length) {
      const c = this.b[this.i]
      if (c === CR || c === LF) break
      if (c === 0x5b /* [ */) depth++
      else if (c === 0x5d /* ] */) {
        if (depth === 0) break
        depth--
      } else if (depth === 0 && (c === 0x20 || c === 0x28 || c === 0x29)) break
      this.i++
    }
    if (this.i === s) {
      this.i++ // never loop on an unexpected character
      return String.fromCharCode(this.b[s])
    }
    return utf8.decode(this.b.subarray(s, this.i))
  }
}

/** Parses one complete response (as given by ResponseSplitter). */
export function parseResponse(bytes: Uint8Array): ImapResponse {
  const t = new Tokenizer(bytes)
  const tag = t.atom()
  t.skipSpaces()
  if (tag === '+') return { tag, type: 'CONTINUE', text: t.rest(), values: [] }

  let first = t.atom()
  let num: number | undefined
  if (/^\d+$/.test(first)) {
    num = Number(first)
    t.skipSpaces()
    first = t.atom()
  }
  const type = first.toUpperCase()
  const r: ImapResponse = { tag, type, values: [] }
  if (num !== undefined) r.num = num

  if (STATUS.has(type)) {
    t.skipSpaces()
    if (t.peek() === 0x5b /* [ */) {
      t.i++
      const name = t.atom().toUpperCase()
      const args: ImapValue[] = []
      for (;;) {
        t.skipSpaces()
        if (t.done || t.peek() === 0x5d) break
        args.push(t.value())
      }
      t.i++
      r.code = { name, args }
      t.skipSpaces()
    }
    r.text = t.rest()
    return r
  }
  while (!t.done) {
    r.values.push(t.value())
    t.skipSpaces()
  }
  return r
}

// ---------- Helpers for reading values ----------

export const asText = (v: ImapValue | undefined): string =>
  v == null ? '' : typeof v === 'string' ? v : v instanceof Uint8Array ? utf8.decode(v) : ''

export const asList = (v: ImapValue | undefined): ImapValue[] => (Array.isArray(v) ? v : [])

/** A FETCH response's attributes as a map with upper-case keys ("UID", "FLAGS", "BODY[]", …). */
export function fetchAttributes(r: ImapResponse): Map<string, ImapValue> {
  const m = new Map<string, ImapValue>()
  const list = asList(r.values[0])
  for (let i = 0; i + 1 < list.length; i += 2) m.set(asText(list[i]).toUpperCase(), list[i + 1])
  return m
}

/** Capabilities from a CAPABILITY response or an "[CAPABILITY …]" code, upper-cased. */
export function capabilitiesOf(r: ImapResponse): string[] | undefined {
  if (r.type === 'CAPABILITY') return r.values.map((v) => asText(v).toUpperCase())
  if (r.code?.name === 'CAPABILITY') return r.code.args.map((v) => asText(v).toUpperCase())
  return undefined
}

// ---------- Writing commands ----------

/**
 * An argument as IMAP needs it: an atom if safe, a quoted string, or (non-ASCII, line breaks,
 * long text) a literal, returned as bytes for the client to send after the server's "+".
 */
export function encodeString(s: string): string | Uint8Array {
  // Atom characters: not % and * (wildcards), which strict servers refuse unquoted (RFC 3501 §9).
  if (/^[\x21\x23\x24\x26\x27\x2b-\x5b\x5d-\x7a\x7c\x7e]+$/.test(s) && s.toUpperCase() !== 'NIL') return s
  if (/^[\x20-\x7e]*$/.test(s) && s.length < 1000) return `"${s.replace(/["\\]/g, '\\$&')}"`
  return new TextEncoder().encode(s)
}

// ---------- Mailbox names (modified UTF-7, RFC 3501 §5.1.3) ----------

export function decodeMailboxName(name: string) {
  return name.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (!b64) return '&'
    const bin = atob(b64.replace(/,/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4))
    let out = ''
    for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1))
    return out
  })
}

export function encodeMailboxName(name: string) {
  return name.replace(/&|[^\x20-\x7e]+/g, (run) => {
    if (run === '&') return '&-'
    let bin = ''
    for (let i = 0; i < run.length; i++) {
      const c = run.charCodeAt(i)
      bin += String.fromCharCode(c >> 8, c & 0xff)
    }
    return `&${btoa(bin).replace(/=+$/, '').replace(/\//g, ',')}-`
  })
}
