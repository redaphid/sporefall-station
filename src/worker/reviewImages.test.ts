import { describe, expect, it } from 'vitest'
import { handleReviewImage, resolveReviewKey } from './reviewImages'
import type { Env } from './env'

/** First 8 bytes of any PNG. The whole point of this route is that a browser (and
 * GitHub's camo proxy) gets REAL image bytes, so the tests check bytes, not 200s. */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const envWith = (entries: Record<string, Uint8Array>): Env =>
  ({
    REVIEW_IMAGES: {
      get: async (key: string) => {
        const hit = entries[key]
        return hit ? (hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) as ArrayBuffer) : null
      },
    },
  }) as unknown as Env

const get = (path: string, entries: Record<string, Uint8Array> = {}, method = 'GET') =>
  handleReviewImage(new Request(`https://sporefall.hypnodroid.com${path}`, { method }), envWith(entries))

describe('resolveReviewKey', () => {
  it('accepts a nested, content-addressed image key', () => {
    expect(resolveReviewKey('/review/feat-props/winners-1a2b3c4d.png')).toEqual({
      key: 'feat-props/winners-1a2b3c4d.png',
      contentType: 'image/png',
    })
  })

  it.each([
    ['/review/a.png', 'image/png'],
    ['/review/a.jpg', 'image/jpeg'],
    ['/review/a.jpeg', 'image/jpeg'],
    ['/review/a.gif', 'image/gif'],
    ['/review/a.webp', 'image/webp'],
    ['/review/a.avif', 'image/avif'],
    ['/review/a.PNG', 'image/png'],
  ])('maps %s to %s', (path, contentType) => {
    expect(resolveReviewKey(path)?.contentType).toBe(contentType)
  })

  it.each([
    ['/review/', 'an empty key'],
    ['/review/sheet', 'no extension'],
    ['/review/sheet.svg', 'svg — scriptable, same-origin with the game'],
    ['/review/index.html', 'html — would impersonate the site'],
    ['/review/sheet.png.txt', 'a non-image final extension'],
    ['/review/../secret.png', 'a parent-directory segment'],
    ['/review/a/../../b.png', 'traversal deeper in the path'],
    ['/review/a//b.png', 'an empty path segment'],
    ['/review/a/b.png/', 'a trailing slash'],
    ['/review/%2e%2e/b.png', 'percent escapes (keys are canonical ASCII)'],
    ['/review/-leading-dash.png', 'a non-alphanumeric first character'],
    ['/review/sheet .png', 'a space'],
    ['/reviewer/a.png', 'a path that only looks like the prefix'],
    ['/ota/check', 'an unrelated route'],
  ])('rejects %s (%s)', (path) => {
    expect(resolveReviewKey(path)).toBeNull()
  })

  it('rejects an absurdly long key', () => {
    expect(resolveReviewKey(`/review/${'a'.repeat(600)}.png`)).toBeNull()
  })
})

describe('handleReviewImage', () => {
  it('serves stored bytes as a real image, not a 200 page', async () => {
    const res = await get('/review/run/sheet-abc12345.png', { 'run/sheet-abc12345.png': PNG_MAGIC })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_MAGIC)
  })

  // THE TRAP: `not_found_handling: "single-page-application"` answers unknown
  // paths with 200 + index.html. A missing review image must be an honest 404
  // that is impossible to mistake for the game page.
  it('answers a miss with a plain-text 404, never HTML', async () => {
    const res = await get('/review/run/missing-abc12345.png')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).not.toContain('<')
  })

  it('rejects an unservable path without consulting KV', async () => {
    const res = await handleReviewImage(
      new Request('https://sporefall.hypnodroid.com/review/evil.svg'),
      { REVIEW_IMAGES: { get: () => Promise.reject(new Error('KV must not be read')) } } as unknown as Env,
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('answers HEAD with the image headers and no body', async () => {
    const res = await get('/review/run/sheet-abc12345.png', { 'run/sheet-abc12345.png': PNG_MAGIC }, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('refuses writes', async () => {
    const res = await get('/review/run/sheet-abc12345.png', { 'run/sheet-abc12345.png': PNG_MAGIC }, 'POST')
    expect(res.status).toBe(405)
  })

  it('caches hard, because keys are content-addressed and immutable', async () => {
    const res = await get('/review/run/sheet-abc12345.png', { 'run/sheet-abc12345.png': PNG_MAGIC })
    expect(res.headers.get('cache-control')).toContain('immutable')
  })
})
