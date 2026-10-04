import { describe, expect, it } from 'vitest'
import {
  claimRoom,
  newRoomCode,
  onlineRoom,
  parseRoomCode,
  ROOM_ATTEMPTS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type RoomCode,
} from './roomCode'
import { onlineHostFailureMessage } from './hostError'

const bytes = (...b: number[]) => () => new Uint8Array(b)

describe('newRoomCode', () => {
  it('maps every byte value onto the alphabet without bias', () => {
    const counts = new Map<string, number>()
    for (let b = 0; b < 256; b++) {
      const ch = newRoomCode(bytes(b, b, b, b))[0]
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    expect([...counts.keys()].sort().join('')).toBe([...ROOM_CODE_ALPHABET].sort().join(''))
    expect(new Set(counts.values())).toEqual(new Set([256 / ROOM_CODE_ALPHABET.length]))
  })

  it('always produces a code its own parser accepts', () => {
    for (let i = 0; i < 500; i++) {
      const code = newRoomCode()
      expect(code).toHaveLength(ROOM_CODE_LENGTH)
      expect(parseRoomCode(code)).toBe(code)
    }
  })

  it('never emits a character that reads as another on a small screen', () => {
    for (let b = 0; b < 256; b++) expect(newRoomCode(bytes(b, b, b, b))).not.toMatch(/[IO01]/)
  })
})

describe('parseRoomCode', () => {
  it.each([
    ['abcd', 'ABCD'],
    [' ab cd ', 'ABCD'],
    ['AB-CD', 'ABCD'],
    ['z9z9', 'Z9Z9'],
  ])('forgives case, spaces and dashes: %j', (input, code) => {
    expect(parseRoomCode(input)).toBe(code)
  })

  it.each(['', 'ABC', 'ABCDE', 'AB0D', 'ABOD', 'AB1D', 'ABID', 'AB_D', 'ÄBCD', 'AB​CD', '../x', 'ABCD\n?role=host'])(
    'rejects %j rather than guessing',
    (input) => {
      expect(parseRoomCode(input)).toBeNull()
    },
  )
})

describe('onlineRoom', () => {
  it('keeps coded rooms out of the dev room names', () => {
    const code = parseRoomCode('CAR2')!
    expect(onlineRoom(code)).toBe('online-CAR2')
    expect(onlineRoom(code)).not.toBe('car')
  })
})

describe('claimRoom', () => {
  const code = (c: string): RoomCode => parseRoomCode(c)!
  const relay = (taken: Set<string>) => {
    const tried: string[] = []
    const open = async (c: RoomCode): Promise<string> => {
      tried.push(c)
      if (taken.has(c)) throw new Error("can't reach the online server (closed with code 1006)")
      return `session:${c}`
    }
    return { tried, open }
  }

  it('keeps the first code when it is free', async () => {
    const { tried, open } = relay(new Set())
    expect(await claimRoom(code('AAAA'), open, () => code('BBBB'))).toEqual({ code: 'AAAA', value: 'session:AAAA' })
    expect(tried).toEqual(['AAAA'])
  })

  it('a taken code falls through to a fresh one, and the lobby gets the code that opened', async () => {
    const { tried, open } = relay(new Set(['AAAA']))
    expect(await claimRoom(code('AAAA'), open, () => code('BBBB'))).toEqual({ code: 'BBBB', value: 'session:BBBB' })
    expect(tried).toEqual(['AAAA', 'BBBB'])
  })

  it(`gives up after ${ROOM_ATTEMPTS} codes with the last error, so the player can choose`, async () => {
    const fresh = ['BBBB', 'CCCC', 'DDDD'].map(code)
    const { tried, open } = relay(new Set(['AAAA', 'BBBB', 'CCCC', 'DDDD']))
    await expect(claimRoom(code('AAAA'), open, () => fresh.shift()!)).rejects.toThrow(/online server/)
    expect(tried).toEqual(['AAAA', 'BBBB', 'CCCC'])
  })

  it('the failure message names the cause and the way out', () => {
    expect(onlineHostFailureMessage(new Error("can't reach the online server"))).toBe(
      "Couldn't open an online room (can't reach the online server). Check your connection and retry.",
    )
    expect(onlineHostFailureMessage(undefined)).toBe("Couldn't open an online room. Check your connection and retry.")
  })
})
