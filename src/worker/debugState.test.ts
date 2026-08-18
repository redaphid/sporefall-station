import { describe, expect, it } from 'vitest'
import { newStateId, STATE_ID_RE } from '../debug/stateLink'
import type { Env } from './env'
import {
  handleDebugState,
  isStorablePayload,
  kvKey,
  MAX_COMPRESSED_BYTES,
  newWorkerStateId,
  resolveStatePath,
  STATE_TTL_SECONDS,
  WORKER_STATE_ID_RE,
} from './debugState'

/** In-memory stand-in for the KV binding, so the REAL handler (gzip, validation,
 * id minting, TTL) is exercised without a Worker runtime. */
const fakeEnv = (): { env: Env; store: Map<string, ArrayBuffer>; ttls: number[] } => {
  const store = new Map<string, ArrayBuffer>()
  const ttls: number[] = []
  const DEBUG_STATES = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: ArrayBuffer, opts?: { expirationTtl?: number }) => {
      store.set(k, v)
      if (opts?.expirationTtl) ttls.push(opts.expirationTtl)
    },
  }
  return { env: { DEBUG_STATES } as unknown as Env, store, ttls }
}

const gzipBytes = async (text: string): Promise<ArrayBuffer> =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()

const post = async (env: Env, body: ArrayBuffer | string): Promise<Response> =>
  handleDebugState(new Request('https://sporefall.test/state', { method: 'POST', body }), env)

const validPayload = { v: 1, world: { v: 1, seed: 1, floor: 1, tick: 9, entities: [] }, meta: { note: 'hi' } }

describe('resolveStatePath', () => {
  it('routes the create endpoint', () => {
    expect(resolveStatePath('/state')).toEqual({ kind: 'create' })
    expect(resolveStatePath('/state/')).toEqual({ kind: 'create' })
  })

  it('routes a well-formed id to a read', () => {
    expect(resolveStatePath('/state/abcdefgh01234567')).toEqual({ kind: 'read', id: 'abcdefgh01234567' })
  })

  it('refuses anything that is not a canonical id', () => {
    expect(resolveStatePath('/state/short')).toBeNull()
    expect(resolveStatePath('/state/../../etc/passwd')).toBeNull()
    expect(resolveStatePath('/state/ABCDEFGH01234567')).toBeNull() // upper case
    expect(resolveStatePath('/state/illlooouu0123456')).toBeNull() // ambiguous letters
    expect(resolveStatePath('/review/x.png')).toBeNull()
    expect(resolveStatePath('/')).toBeNull()
  })
})

describe('id format', () => {
  it('the Worker and the app agree byte-for-byte (they cannot share a module)', () => {
    for (const fill of [0, 1, 7, 31, 255]) {
      const bytes = new Uint8Array(16).fill(fill)
      expect(newWorkerStateId(bytes)).toBe(newStateId(bytes))
    }
    const random = crypto.getRandomValues(new Uint8Array(16))
    expect(newWorkerStateId(random)).toBe(newStateId(random))
  })

  it('the two regexes agree', () => {
    expect(WORKER_STATE_ID_RE.source).toBe(STATE_ID_RE.source)
  })

  it('mints ids the read route will actually accept', () => {
    for (let i = 0; i < 50; i++) {
      const id = newWorkerStateId(crypto.getRandomValues(new Uint8Array(16)))
      expect(resolveStatePath(`/state/${id}`)).toEqual({ kind: 'read', id })
    }
  })
})

describe('isStorablePayload', () => {
  it('accepts a v1 payload and rejects everything else', () => {
    expect(isStorablePayload(validPayload)).toBe(true)
    expect(isStorablePayload({ v: 2, world: {} })).toBe(false)
    expect(isStorablePayload({ v: 1 })).toBe(false)
    expect(isStorablePayload({ v: 1, world: 'nope' })).toBe(false)
    expect(isStorablePayload(null)).toBe(false)
    expect(isStorablePayload([])).toBe(false)
  })
})

describe('POST /state then GET /state/:id', () => {
  it('round-trips a gzipped payload and hands back a usable link', async () => {
    const { env, store, ttls } = fakeEnv()
    const res = await post(env, await gzipBytes(JSON.stringify(validPayload)))
    expect(res.status).toBe(201)

    const { id, url } = (await res.json()) as { id: string; url: string }
    expect(id).toMatch(WORKER_STATE_ID_RE)
    expect(url).toBe(`https://sporefall.test/?state=${id}`)
    // Stored COMPRESSED, under a namespaced key, with an expiry.
    expect(store.has(kvKey(id))).toBe(true)
    expect(ttls).toEqual([STATE_TTL_SECONDS])

    const got = await handleDebugState(new Request(`https://sporefall.test/state/${id}`), env)
    expect(got.status).toBe(200)
    // CONTENT-TYPE is the real check — a 200 alone could be the SPA fallback.
    expect(got.headers.get('content-type')).toMatch(/application\/json/)
    expect(await got.json()).toEqual(validPayload)
  })

  it('answers a missing id with a REAL 404 in text/plain, never the SPA shell', async () => {
    const { env } = fakeEnv()
    const res = await handleDebugState(new Request('https://sporefall.test/state/aaaaaaaaaaaaaaaa'), env)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await res.text()).not.toMatch(/<!doctype|<html/i)
  })

  it('rejects a non-gzip body', async () => {
    const { env, store } = fakeEnv()
    const res = await post(env, JSON.stringify(validPayload))
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/gzip/)
    expect(store.size).toBe(0)
  })

  it('rejects valid gzip that is not JSON', async () => {
    const { env } = fakeEnv()
    const res = await post(env, await gzipBytes('not json at all'))
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/JSON/)
  })

  it('rejects a JSON body that is not a v1 debug state', async () => {
    const { env, store } = fakeEnv()
    const res = await post(env, await gzipBytes(JSON.stringify({ hello: 'world' })))
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/v1 debug-state/)
    expect(store.size).toBe(0)
  })

  it('rejects an empty body', async () => {
    const { env } = fakeEnv()
    expect((await post(env, new ArrayBuffer(0))).status).toBe(400)
  })

  it('refuses an oversized upload even when content-length lies', async () => {
    const { env, store } = fakeEnv()
    const huge = new ArrayBuffer(MAX_COMPRESSED_BYTES + 1)
    const req = new Request('https://sporefall.test/state', { method: 'POST', body: huge })
    // Strip the honest content-length so only the real-bytes check can catch it.
    const res = await handleDebugState(
      new Request(req, { method: 'POST', body: huge, headers: { 'content-length': '10' } }),
      env,
    )
    expect(res.status).toBe(413)
    expect(store.size).toBe(0)
  })

  it('refuses a zip bomb: small compressed, enormous decompressed', async () => {
    const { env, store } = fakeEnv()
    // ~16 MiB of zeros gzips to a few KiB — well under the compressed cap, and
    // the decompressed ceiling is the only thing that can stop it.
    const bomb = await gzipBytes('0'.repeat(16 * 1024 * 1024))
    expect(bomb.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES)
    const res = await post(env, bomb)
    expect(res.status).toBe(413)
    expect(store.size).toBe(0)
  })

  it('rejects the wrong methods', async () => {
    const { env } = fakeEnv()
    const get = await handleDebugState(new Request('https://sporefall.test/state'), env)
    expect(get.status).toBe(405)
    const put = await handleDebugState(
      new Request('https://sporefall.test/state/aaaaaaaaaaaaaaaa', { method: 'PUT' }),
      env,
    )
    expect(put.status).toBe(405)
  })

  it('answers CORS preflight so a link works from any origin', async () => {
    const { env } = fakeEnv()
    const res = await handleDebugState(new Request('https://sporefall.test/state', { method: 'OPTIONS' }), env)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('mints a different id for every capture', async () => {
    const { env } = fakeEnv()
    const ids = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const res = await post(env, await gzipBytes(JSON.stringify(validPayload)))
      ids.add(((await res.json()) as { id: string }).id)
    }
    expect(ids.size).toBe(8)
  })
})
