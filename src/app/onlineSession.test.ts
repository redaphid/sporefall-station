import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransportEvent } from '../net/types'
import { HOSTING_STATUS, hostOnline, NO_HOST_MESSAGE, NO_HOST_MS, watchForHost, type OnlineLobby } from './onlineSession'
import { parseRoomCode, ROOM_ATTEMPTS, type RoomCode } from './roomCode'

const code = (c: string): RoomCode => parseRoomCode(c)!

/** A lobby that records what the player would see, and answers prompts from a script. */
const fakeLobby = (answers: ('retry' | 'back')[] = []) => {
  const seen = { statuses: [] as string[], codes: [] as string[], retries: [] as string[], backs: [] as string[] }
  let pressBack: (() => void) | null = null
  const lobby: OnlineLobby = {
    setStatus: (t) => void seen.statuses.push(t),
    setRoomCode: (c) => void seen.codes.push(c),
    offerRetry: async (m) => {
      seen.retries.push(m)
      return answers.shift() ?? 'back'
    },
    offerBack: (m) => {
      seen.backs.push(m)
      return new Promise((resolve) => (pressBack = resolve))
    },
  }
  return { lobby, seen, pressBack: () => pressBack?.() }
}

/** A relay where some codes are already held: opening one of those rejects. */
const relay = (held: Set<string>, down = false) => {
  const tried: string[] = []
  const goLive = async (c: RoomCode): Promise<string> => {
    tried.push(c)
    if (down || held.has(c)) throw new Error("can't reach the online server")
    return `session:${c}`
  }
  return { tried, goLive }
}

const codes = (...cs: string[]) => {
  const queue = cs.map(code)
  return () => queue.shift() ?? code('ZZZZ')
}

describe('hostOnline', () => {
  it('a free code opens at once, and only then is the code shown', async () => {
    const { lobby, seen } = fakeLobby()
    const { goLive } = relay(new Set())
    const out = await hostOnline({ firstCode: code('AAAA'), goLive, lobby, backToMenu: () => {}, fresh: codes('BBBB') })
    expect(out).toEqual({ code: 'AAAA', session: 'session:AAAA' })
    expect(seen.codes).toEqual(['AAAA'])
    expect(seen.statuses.at(-1)).toBe(HOSTING_STATUS)
    expect(seen.retries).toEqual([])
  })

  it('a held code moves to a fresh one by itself, and the dead code is never shown', async () => {
    const { lobby, seen } = fakeLobby()
    const { goLive, tried } = relay(new Set(['AAAA']))
    const out = await hostOnline({ firstCode: code('AAAA'), goLive, lobby, backToMenu: () => {}, fresh: codes('BBBB') })
    expect(tried).toEqual(['AAAA', 'BBBB'])
    expect(out?.code).toBe('BBBB')
    expect(seen.codes).toEqual(['BBBB'])
  })

  it('when every attempt fails it asks, shows no code, and Back leaves with null', async () => {
    const { lobby, seen } = fakeLobby(['back'])
    const back = vi.fn()
    const { goLive, tried } = relay(new Set(), true)
    const out = await hostOnline({ firstCode: code('AAAA'), goLive, lobby, backToMenu: back, fresh: codes('BBBB', 'CCCC') })
    expect(out).toBeNull()
    expect(tried).toHaveLength(ROOM_ATTEMPTS)
    expect(seen.codes).toEqual([])
    expect(seen.retries).toEqual(["Couldn't open an online room (can't reach the online server). Check your connection and retry."])
    expect(back).toHaveBeenCalledOnce()
  })

  it('Retry tries again with fresh codes and can still succeed', async () => {
    const { lobby, seen } = fakeLobby(['retry'])
    const held = new Set(['AAAA', 'BBBB', 'CCCC'])
    const { goLive, tried } = relay(held)
    const out = await hostOnline({
      firstCode: code('AAAA'),
      goLive,
      lobby,
      backToMenu: () => {},
      fresh: codes('BBBB', 'CCCC', 'DDDD'),
    })
    expect(tried).toEqual(['AAAA', 'BBBB', 'CCCC', 'DDDD'])
    expect(out?.code).toBe('DDDD')
    expect(seen.codes).toEqual(['DDDD'])
  })
})

describe('watchForHost', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const transport = () => {
    const handlers = new Set<(e: TransportEvent) => void>()
    let present = false
    return {
      on: (h: (e: TransportEvent) => void) => {
        handlers.add(h)
        return () => handlers.delete(h)
      },
      peers: () => (present ? ['host'] : []),
      hostArrives: () => {
        present = true
        for (const h of handlers) h({ type: 'peerConnected', peer: 'host' })
      },
      handlers,
    }
  }

  it('a code nobody hosts says so after the timeout and offers Back', async () => {
    const t = transport()
    const { lobby, seen, pressBack } = fakeLobby()
    const back = vi.fn()
    watchForHost({ transport: t, lobby, backToMenu: back })
    await vi.advanceTimersByTimeAsync(NO_HOST_MS - 1)
    expect(seen.backs).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.backs).toEqual([NO_HOST_MESSAGE])
    expect(back).not.toHaveBeenCalled()
    pressBack()
    await vi.advanceTimersByTimeAsync(0)
    expect(back).toHaveBeenCalledOnce()
  })

  it('a host that turns up in time cancels the warning and stops listening', async () => {
    const t = transport()
    const { lobby, seen } = fakeLobby()
    watchForHost({ transport: t, lobby, backToMenu: () => {} })
    await vi.advanceTimersByTimeAsync(NO_HOST_MS / 2)
    t.hostArrives()
    await vi.advanceTimersByTimeAsync(NO_HOST_MS * 2)
    expect(seen.backs).toEqual([])
    expect(t.handlers.size).toBe(0)
  })
})
