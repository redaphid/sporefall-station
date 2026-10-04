/**
 * Room codes for online play: the four characters a host reads out and a friend
 * types in. The relay keys a Durable Object by room name (src/worker/router.ts),
 * so a code needs no server-side allocation. Two hosts that draw the same code
 * collide, and the second gets a 409 from the relay; at 32^4 codes that is rare
 * enough for a game played between friends.
 */

/** No I, O, 0 or 1: each looks like another when read off a phone screen. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 4

export type RoomCode = string & { readonly __brand: 'RoomCode' }

/** `randomBytes(n)` returns n uniformly random bytes. 256 is a multiple of the
 * alphabet's 32, so `byte % 32` has no bias. */
export const newRoomCode = (
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): RoomCode => {
  let code = ''
  for (const b of randomBytes(ROOM_CODE_LENGTH)) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]
  return code as RoomCode
}

/** What a player typed, as a code, or null. Case, spaces and dashes are
 * forgiven; a character outside the alphabet is not guessed at. */
export const parseRoomCode = (input: string): RoomCode | null => {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== ROOM_CODE_LENGTH) return null
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null
  return code as RoomCode
}

/** The relay room a code names. The prefix keeps coded rooms apart from the
 * `?room=` names that dev links and e2e runs use. */
export const onlineRoom = (code: RoomCode): string => `online-${code}`
