import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld } from '../game/world'
import { shareState, stateOrigin } from './stateShare'

// The origin the bundle is built for. Written here as a LITERAL on purpose:
// capacitor.config.ts is the single source of truth, and this asserts the whole
// chain (capacitor.config.ts -> vite `define` -> version.ts -> stateOrigin)
// actually delivers it. If the canonical domain ever moves, this test is the
// thing that notices the native path was left behind.
const SITE = 'https://sporefall.hypnodroid.com'

/** Capacitor's Android default with no `androidScheme` set: a real, portless,
 * https origin that resolves to files inside the APK. */
const NATIVE = 'https://localhost'

const jsonRes = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** What the app's own bundled assets answer a POST with: 200, and the app. */
const spaFallbackRes = (): Response =>
  new Response('<!doctype html><html><head><title>Sporefall Station</title></head></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

/** Stubs `fetch` and returns the (growing) list of URLs it was asked for. */
const stubFetch = (res: () => Response): string[] => {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      urls.push(String(input))
      return res()
    }),
  )
  return urls
}

afterEach(() => vi.unstubAllGlobals())

describe('stateOrigin', () => {
  it('uses the origin the page came from, in a browser', () => {
    expect(stateOrigin('', SITE)).toBe(SITE)
    expect(stateOrigin('?debug', 'https://preview.example.com')).toBe('https://preview.example.com')
  })

  it('lets an explicit ?stateOrigin= override win — vite dev pointing at wrangler dev', () => {
    expect(stateOrigin('?stateOrigin=http://localhost:8787', 'http://localhost:5173')).toBe('http://localhost:8787')
    // ...including from the native shell, so the override stays a real escape hatch.
    expect(stateOrigin('?stateOrigin=http://192.168.1.9:8787', NATIVE)).toBe('http://192.168.1.9:8787')
  })

  it('targets the deployed site from the Android webview, not the phone itself', () => {
    expect(stateOrigin('', NATIVE)).toBe(SITE)
  })

  it('treats every other native-shell origin the same way', () => {
    expect(stateOrigin('', 'capacitor://localhost')).toBe(SITE)
    expect(stateOrigin('', 'ionic://localhost')).toBe(SITE)
    // A file:// document reports the literal string "null" as its origin.
    expect(stateOrigin('', 'null')).toBe(SITE)
    expect(stateOrigin('', '')).toBe(SITE)
  })

  it('LEAVES LOCAL DEV SERVERS ALONE — they have ports, and can serve /state themselves', () => {
    // wrangler dev genuinely serves the Worker; vite dev / preview are covered by
    // the ?stateOrigin= override. Hijacking these to production would break local
    // work and quietly write dev captures into the live KV namespace.
    expect(stateOrigin('', 'http://localhost:8787')).toBe('http://localhost:8787')
    expect(stateOrigin('', 'http://localhost:5173')).toBe('http://localhost:5173')
    expect(stateOrigin('', 'http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173')
  })
})

describe('shareState', () => {
  it('returns the id and url the Worker minted', async () => {
    stubFetch(() => jsonRes({ id: 'abcdefgh01234567', url: `${SITE}/?state=abcdefgh01234567` }))

    const result = await shareState(createWorld(1, 1), { note: 'hi' }, undefined, SITE)

    expect(result.id).toBe('abcdefgh01234567')
    expect(result.url).toBe(`${SITE}/?state=abcdefgh01234567`)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.rawBytes).toBeGreaterThan(result.bytes)
  })

  it('says "HTML, not JSON" when a 200 turns out to be the app shell', async () => {
    stubFetch(spaFallbackRes)

    const err = await shareState(createWorld(1, 1), {}, undefined, NATIVE).then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err).toBeInstanceOf(Error)
    // Readable: names the content-type and WHERE the upload actually landed.
    expect(err?.message).toMatch(/instead of JSON/i)
    expect(err?.message).toContain('text/html')
    expect(err?.message).toContain(NATIVE)
    // NOT the raw JSON-parser crash the player used to see.
    expect(err?.message).not.toMatch(/doctype/i)
    expect(err?.message).not.toMatch(/Unexpected token/i)
  })

  it('posts to the deployed site — not the phone — when it defaults its own origin', async () => {
    // The real APK path: no explicit origin argument, and a `location` that is
    // Capacitor's local shell.
    vi.stubGlobal('location', { search: '', origin: NATIVE })
    const urls = stubFetch(() => jsonRes({ id: 'abcdefgh01234567', url: `${SITE}/?state=abcdefgh01234567` }))

    await shareState(createWorld(1, 1), {})

    expect(urls).toEqual([`${SITE}/state`])
  })
})
