import { describe, expect, it } from 'vitest'
import type { Env } from './env'
import { route } from './router'

/** An Env whose ROOM namespace records which room names reached a Durable Object. */
const envSpy = () => {
  const reached: string[] = []
  const env = {
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async () => {
          reached.push(id)
          return new Response('to the room', { status: 200 })
        },
      }),
    },
    ASSETS: { fetch: async () => new Response('asset') },
  } as unknown as Env
  return { env, reached }
}

const wsAt = (path: string) => new Request(`https://sporefall.example${path}`, { headers: { Upgrade: 'websocket' } })

describe('route /ws/:room — room names are checked at the boundary', () => {
  it.each(['car', 'online-K7QX', 'betas-path~car', 'pr-12~online-ZZ22', 'a'.repeat(64)])('serves %j', async (room) => {
    const { env, reached } = envSpy()
    const res = await route(wsAt(`/ws/${encodeURIComponent(room)}`), env)
    expect(res.status).toBe(200)
    expect(reached).toEqual([room])
  })

  it.each([
    ['empty', '/ws/'],
    ['65 characters', `/ws/${'a'.repeat(65)}`],
    ['a space', `/ws/${encodeURIComponent('my room')}`],
    ['a slash', `/ws/${encodeURIComponent('a/b')}`],
    ['two slugs', `/ws/${encodeURIComponent('x~y~car')}`],
    ['an upper-case slug', `/ws/${encodeURIComponent('Beta~car')}`],
    ['a dot', '/ws/car.'],
    ['an emoji', `/ws/${encodeURIComponent('car🙂')}`],
    ['a malformed escape', '/ws/%E0%A4%A'],
  ])('refuses %s with 400 before any Durable Object exists', async (_label, path) => {
    const { env, reached } = envSpy()
    const res = await route(wsAt(path), env)
    expect(res.status).toBe(400)
    expect(reached).toEqual([])
  })
})
