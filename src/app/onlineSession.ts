import type { Transport } from '../net/types'
import { onlineHostFailureMessage } from './hostError'
import { claimRoom, newRoomCode, type RoomCode } from './roomCode'

/** The slice of the lobby screen the online flows drive (ui/menu.ts LobbyUi). */
export interface OnlineLobby {
  setStatus(text: string): void
  setRoomCode(code: string): void
  offerRetry(message: string): Promise<'retry' | 'back'>
  offerBack(message: string): Promise<void>
}

export const HOSTING_STATUS = 'Friends join with this code from Play online'

/**
 * Host online: open a room under `firstCode`, moving to fresh codes when one
 * fails (a code another host holds looks like any other failure from the
 * browser). The code is shown only once its room is open. If every attempt
 * fails, the player chooses Retry or Back, and Back resolves null.
 */
export const hostOnline = async <S>(deps: {
  firstCode: RoomCode
  /** Bring a session up on the relay room for `code`; rejects if it can't. */
  goLive: (code: RoomCode) => Promise<S>
  lobby: OnlineLobby
  backToMenu: () => void
  fresh?: () => RoomCode
}): Promise<{ code: RoomCode; session: S } | null> => {
  const fresh = deps.fresh ?? newRoomCode
  let first = deps.firstCode
  for (;;) {
    deps.lobby.setStatus('Opening an online room…')
    try {
      const room = await claimRoom(first, deps.goLive, fresh)
      deps.lobby.setRoomCode(room.code)
      deps.lobby.setStatus(HOSTING_STATUS)
      return { code: room.code, session: room.value }
    } catch (err) {
      if ((await deps.lobby.offerRetry(onlineHostFailureMessage(err))) === 'back') {
        deps.backToMenu()
        return null
      }
      first = fresh()
    }
  }
}

/** How long a joiner waits for the code's host before being told there is none. */
export const NO_HOST_MS = 10_000
export const NO_HOST_MESSAGE = 'No game with that code'

/**
 * Join online: the relay announces a present host at once, so a code nobody
 * hosts would otherwise wait forever. After NO_HOST_MS without a host, say so
 * and offer Back. A host that turns up later still joins normally. Returns a
 * cancel for the timer.
 */
export const watchForHost = (deps: {
  transport: Pick<Transport, 'on' | 'peers'>
  lobby: Pick<OnlineLobby, 'offerBack'>
  backToMenu: () => void
  ms?: number
}): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = deps.transport.on((ev) => {
    if (ev.type === 'peerConnected') cancel()
  })
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    stop()
  }
  timer = setTimeout(() => {
    timer = undefined
    stop()
    if (deps.transport.peers().length > 0) return
    void deps.lobby.offerBack(NO_HOST_MESSAGE).then(deps.backToMenu)
  }, deps.ms ?? NO_HOST_MS)
  return cancel
}
