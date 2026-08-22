import { describe, expect, it, vi } from 'vitest'
import type { Env } from './env'
import { decideOta, handleOta } from './ota'

describe('decideOta', () => {
  it('offers a newer bundle when the installed version differs', () => {
    expect(decideOta('41', { version: '42', url: 'https://x/ota/42.zip' })).toEqual({
      version: '42',
      url: 'https://x/ota/42.zip',
    })
  })

  it('reports up-to-date when the installed version matches', () => {
    expect(decideOta('42', { version: '42', url: 'https://x/ota/42.zip' })).toEqual({ message: 'up-to-date' })
  })

  it('reports up-to-date when there is no published bundle url', () => {
    expect(decideOta('builtin', { version: 'builtin', url: '' })).toEqual({ message: 'up-to-date' })
  })

  it('does not offer an update with an empty url even if versions differ', () => {
    expect(decideOta('1', { version: '2', url: '' })).toEqual({ message: 'up-to-date' })
  })
})

// ---------------------------------------------------------------------------
// handleOta: READING the published manifest out of the ASSETS binding.
//
// decideOta above is only half the job. The other half is deciding what we are
// even allowed to hand it, and that read has THREE outcomes. Conflating any two
// of them is how "you are on the latest build" becomes a lie:
//
//   published - a real manifest. Hand it to decideOta.
//   absent    - a clean 404. Nothing has been published yet, so "nothing to
//               update to" is the TRUE answer. This must stay quiet.
//   fault     - 200 + text/html (Cloudflare's SPA fallback), unparseable JSON,
//               or a shape that is not a manifest. We do NOT know what the
//               current version is, and answering "up-to-date" would be a guess
//               that is indistinguishable from success -- forever, silently.
// ---------------------------------------------------------------------------

/** Stand-in for the ASSETS binding, so the REAL handler is exercised. */
const envServing = (respond: () => Response): Env =>
  ({ ASSETS: { fetch: async () => respond() } }) as unknown as Env

const jsonRes = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

const textRes = (body: string, status: number): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } })

/**
 * What `not_found_handling: "single-page-application"` (wrangler.jsonc) ACTUALLY
 * serves for an asset that is not in dist/: a cheerful 200 carrying the game's
 * index.html. `res.ok` is true; `res.json()` detonates on `<!doctype`.
 */
const spaFallback = (): Response =>
  new Response('<!doctype html><html><body>Sporefall</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const call = (env: Env, method: string, installed = '41'): Promise<Response> =>
  handleOta(
    new Request('https://sporefall.hypnodroid.com/ota/check', {
      method,
      headers: method === 'POST' ? { cap_version_name: installed } : {},
    }),
    env,
  )

const bodyOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>

/** Run a call with console.error muted, returning the parsed body + the spy. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; errors: number }> => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return { result: await fn(), errors: spy.mock.calls.length }
  } finally {
    spy.mockRestore()
  }
}

const healthy = (): Response => jsonRes('{"version":"42","url":"https://x/ota/42.zip"}')

describe('handleOta - a healthy manifest behaves exactly as before', () => {
  it('offers a newer bundle to a POST', async () => {
    const res = await call(envServing(healthy), 'POST', '41')
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ version: '42', url: 'https://x/ota/42.zip' })
  })

  it('reports up-to-date to a POST already on that version', async () => {
    const res = await call(envServing(healthy), 'POST', '42')
    expect(await bodyOf(res)).toEqual({ message: 'up-to-date' })
  })

  it('shows the manifest in the GET health view', async () => {
    const res = await call(envServing(healthy), 'GET')
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, current: { version: '42', url: 'https://x/ota/42.zip' } })
  })

  it('still refuses other methods', async () => {
    const res = await call(envServing(healthy), 'PUT')
    expect(res.status).toBe(405)
  })

  it('stays silent in the logs', async () => {
    const { errors } = await quietly(() => call(envServing(healthy), 'POST'))
    expect(errors).toBe(0)
  })
})

describe('handleOta - a genuinely absent manifest stays BENIGN', () => {
  // An origin that has never run deploy-web.yml has no manifest to read. That is
  // legitimate, not broken: there is simply nothing to update to.
  const missing = (): Response => textRes('not found', 404)

  it('tells a POST there is nothing to update to', async () => {
    const res = await call(envServing(missing), 'POST')
    expect(await bodyOf(res)).toEqual({ message: 'up-to-date' })
  })

  it('leaves the GET health view ok - nothing is broken, nothing is published', async () => {
    const res = await call(envServing(missing), 'GET')
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, current: { version: 'builtin', url: '' } })
  })

  it('does not shout about it', async () => {
    const { errors } = await quietly(() => call(envServing(missing), 'POST'))
    expect(errors).toBe(0)
  })
})

/** Every way the manifest read can be BROKEN rather than merely absent. */
const FAULTS: ReadonlyArray<readonly [string, () => Response]> = [
  ['the SPA fallback (200 + text/html)', spaFallback],
  ['a JSON content-type over an unparseable body', () => jsonRes('<!doctype html><html></html>')],
  ['valid JSON of an entirely wrong shape', () => jsonRes('{"foo":1}')],
  ['valid JSON that is not even an object', () => jsonRes('"42"')],
  ['a manifest missing its url', () => jsonRes('{"version":"42"}')],
  ['a manifest whose version is not a string', () => jsonRes('{"version":42,"url":"https://x/42.zip"}')],
  ['a 500 from the asset store', () => textRes('boom', 500)],
  [
    'the ASSETS binding throwing outright',
    () => {
      throw new TypeError('binding unavailable')
    },
  ],
]

describe.each(FAULTS)('handleOta - a FAULT: %s', (_label, respond) => {
  it('does NOT tell the phone it is up to date', async () => {
    const { result: body } = await quietly(async () => bodyOf(await call(envServing(respond), 'POST')))
    expect(body).not.toEqual({ message: 'up-to-date' })
    expect(body.error).toBeTypeOf('string')
  })

  it('still offers no bundle, so the phone is never worse off', async () => {
    const { result: body } = await quietly(async () => bodyOf(await call(envServing(respond), 'POST')))
    // Never a synthetic version. `version: "builtin"` is a RESET instruction to
    // @capgo/capacitor-updater (CapacitorUpdaterPlugin.java calls _reset() on
    // it), so a guessed manifest could roll a phone BACK to the shipped bundle.
    expect(body.version).toBeUndefined()
    expect(body.url).toBeUndefined()
  })

  it('says so in the GET health view instead of claiming ok', async () => {
    const { result: body } = await quietly(async () => bodyOf(await call(envServing(respond), 'GET')))
    expect(body.ok).toBe(false)
    expect(body.error).toBeTypeOf('string')
  })

  it('keeps GET answering 2xx - e2e/ws-lib.mjs probes res.ok for worker liveness', async () => {
    const { result: res } = await quietly(() => call(envServing(respond), 'GET'))
    expect(res.ok).toBe(true)
  })

  it('logs the fault so it lands in Workers Logs', async () => {
    const { errors } = await quietly(() => call(envServing(respond), 'POST'))
    expect(errors).toBeGreaterThan(0)
  })
})

describe('handleOta - the fault is diagnosable, not merely present', () => {
  it('names the SPA fallback when HTML comes back', async () => {
    const { result: body } = await quietly(async () => bodyOf(await call(envServing(spaFallback), 'GET')))
    const error = String(body.error)
    expect(error).toContain('text/html')
    expect(error.toLowerCase()).toContain('fallback')
  })

  it('answers a POST in the updater plugin own error protocol', async () => {
    const { result: res } = await quietly(() => call(envServing(spaFallback), 'POST'))
    const body = await bodyOf(res)
    // makeJsonRequest() in CapgoUpdater.java routes ANY body carrying `error`
    // into its failure branch (kind normalised to "failed"). So this is a
    // no-update answer the DEVICE names in logcat, not a silent success.
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(body.error).toBeTypeOf('string')
    expect(body.message).toBeTypeOf('string')
  })
})
