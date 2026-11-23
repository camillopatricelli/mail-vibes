import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth/msal', () => ({
  getGraphToken: async () => 'token',
  AuthRequiredError: class extends Error {},
}))
vi.mock('../status/store', () => ({
  useStatus: { getState: () => ({ reportSuccess() {}, reportError() {} }) },
}))
vi.mock('../i18n', () => ({ default: { t: (k: string) => k } }))

const { graphFileStore, fileToBase64 } = await import('./graphFiles')

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** Records the requests and answers them with `answer`. */
function fakeFetch(answer: (c: Call) => unknown) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    const c = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body }
    calls.push(c)
    const a = answer(c)
    return a instanceof Response ? a : new Response(a === undefined ? null : JSON.stringify(a), { status: a === undefined ? 204 : 200 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const G = 'https://graph.microsoft.com/v1.0'

describe('graph file store', () => {
  it('encodes files as base64', async () => {
    expect(await fileToBase64(new Blob(['Ciao!']))).toBe(btoa('Ciao!'))
  })

  it('lists event files without their content, skipping inline and non-file ones', async () => {
    const calls = fakeFetch(() => ({
      value: [
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a', name: 'plan.pdf', size: 10, contentType: 'application/pdf' },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'b', name: 'logo.png', size: 5, contentType: 'image/png', isInline: true },
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'c', name: 'Mail' },
      ],
    }))
    const store = graphFileStore('microsoft:1', '/me/events/E1/attachments', 'outlook', 100)
    expect(await store.list()).toEqual([{ id: 'a', name: 'plan.pdf', size: 10, contentType: 'application/pdf' }])
    expect(calls[0].url).toBe(`${G}/me/events/E1/attachments?$select=id,name,size,contentType,isInline`)
  })

  it('sends a small event file in one request', async () => {
    const calls = fakeFetch(() => ({ id: 'new' }))
    const store = graphFileStore('microsoft:1', '/me/events/E1/attachments', 'outlook', 100)
    await store.add(new File(['hello'], 'note.txt', { type: 'text/plain' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: `${G}/me/events/E1/attachments`,
      method: 'POST',
      body: { '@odata.type': '#microsoft.graph.fileAttachment', name: 'note.txt', contentType: 'text/plain', contentBytes: btoa('hello') },
    })
  })

  it('sends a small To Do file as a task file attachment', async () => {
    const calls = fakeFetch(() => ({ id: 'new' }))
    const store = graphFileStore('microsoft:1', '/me/todo/lists/L/tasks/T/attachments', 'todo', 100)
    await store.add(new File(['x'], 'a.bin'))
    expect(calls[0].body).toMatchObject({ '@odata.type': '#microsoft.graph.taskFileAttachment', name: 'a.bin', contentType: 'application/octet-stream' })
  })

  it('sends a large To Do file through an upload session, in chunks, without the token', async () => {
    const size = 5 * 1024 * 1024
    const calls = fakeFetch((c) => (c.url.endsWith('/createUploadSession') ? { uploadUrl: 'https://upload.example.com/s/1' } : c.method === 'PUT' ? {} : undefined))
    const progress: number[] = []
    const store = graphFileStore('microsoft:1', '/me/todo/lists/L/tasks/T/attachments', 'todo', 25 * 1024 * 1024)
    await store.add(new File([new Uint8Array(size)], 'big.zip', { type: 'application/zip' }), (x) => progress.push(x))
    expect(calls[0]).toMatchObject({
      url: `${G}/me/todo/lists/L/tasks/T/attachments/createUploadSession`,
      body: { attachmentInfo: { attachmentType: 'file', name: 'big.zip', size, contentType: 'application/zip' } },
    })
    const puts = calls.slice(1)
    expect(puts.map((c) => c.headers['Content-Range'])).toEqual([`bytes 0-3932159/${size}`, `bytes 3932160-${size - 1}/${size}`])
    expect(puts.every((c) => c.url === 'https://upload.example.com/s/1' && !('Authorization' in c.headers))).toBe(true)
    expect(progress.at(-1)).toBe(1)
  })

  it('uses Outlook upload sessions for large event files', async () => {
    const calls = fakeFetch((c) => (c.url.endsWith('/createUploadSession') ? { uploadUrl: 'https://upload.example.com/s/2' } : {}))
    const store = graphFileStore('microsoft:1', '/me/events/E1/attachments', 'outlook', 150 * 1024 * 1024)
    await store.add(new File([new Uint8Array(4 * 1024 * 1024)], 'deck.pptx'))
    expect(calls[0].body).toMatchObject({ AttachmentItem: { attachmentType: 'file', name: 'deck.pptx', size: 4 * 1024 * 1024 } })
  })

  it('removes and downloads by id', async () => {
    const calls = fakeFetch((c) => (c.method === 'GET' ? new Response('data') : undefined))
    const store = graphFileStore('microsoft:1', '/me/events/E1/attachments', 'outlook', 100)
    await store.remove('a/b')
    expect(await (await store.download('a')).text()).toBe('data')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${G}/me/events/E1/attachments/a%2Fb`, `GET ${G}/me/events/E1/attachments/a/$value`])
  })
})
