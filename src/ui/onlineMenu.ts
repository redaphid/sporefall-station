import { newRoomCode, parseRoomCode, ROOM_CODE_LENGTH, type RoomCode } from '../app/roomCode'
import { markUiChrome } from './chrome'
import { installGamepadMenuNav } from './gamepadMenu'

export interface OnlinePick {
  role: 'host' | 'join'
  code: RoomCode
}

const BUTTON_CSS =
  'font:600 17px system-ui;padding:12px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
  'background:#ffffff10;color:#eee;cursor:pointer;touch-action:manipulation'

/**
 * The "Play online" screen: host a game under a fresh room code, or join one by
 * typing the code a friend reads out. Resolves null when the player backs out.
 * Online games go through the Worker's relay, so every player needs a
 * connection; Bluetooth co-op stays on the start menu for when there is none.
 */
export const pickOnline = (mount: HTMLElement, makeCode: () => RoomCode = newRoomCode): Promise<OnlinePick | null> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    markUiChrome(overlay) // press-exempt UI chrome (chrome.ts)
    overlay.dataset.role = 'online-menu'
    overlay.style.cssText =
      'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;padding:0 16px;overflow-y:auto;pointer-events:auto;color:#eee;' +
      'font:16px system-ui;text-align:center'
    const title = document.createElement('div')
    title.style.cssText = 'font:800 22px system-ui'
    title.textContent = 'PLAY ONLINE'
    const note = document.createElement('div')
    note.style.cssText = 'opacity:.7;max-width:min(340px,85vw);line-height:1.35'
    note.textContent = 'Over the internet, so everyone needs a connection.'

    const host = document.createElement('button')
    host.dataset.role = 'online-host'
    host.style.cssText = `${BUTTON_CSS};width:min(320px,85vw)`
    host.textContent = 'Host online game'

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;width:min(320px,85vw)'
    const input = document.createElement('input')
    input.dataset.role = 'online-code'
    input.placeholder = 'CODE'
    input.maxLength = ROOM_CODE_LENGTH + 2 // room for a stray space or dash
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('autocapitalize', 'characters')
    input.setAttribute('aria-label', 'Room code')
    input.style.cssText =
      'flex:1;min-width:0;box-sizing:border-box;font:700 20px ui-monospace,monospace;letter-spacing:4px;' +
      'text-transform:uppercase;text-align:center;padding:10px;border-radius:10px;border:2px solid #ffffff2e;' +
      'background:#ffffff08;color:#eee'
    const join = document.createElement('button')
    join.dataset.role = 'online-join'
    join.style.cssText = BUTTON_CSS
    join.textContent = 'Join'
    row.append(input, join)

    const error = document.createElement('div')
    error.dataset.role = 'online-error'
    error.style.cssText = 'min-height:1.2em;color:#ff9d9d'

    const back = document.createElement('button')
    back.style.cssText = `${BUTTON_CSS};margin-top:4px`
    back.textContent = 'Back'

    const stopNav = installGamepadMenuNav(() => [host, join, back])
    const finish = (pick: OnlinePick | null): void => {
      stopNav()
      overlay.remove()
      resolve(pick)
    }
    const tryJoin = (): void => {
      const code = parseRoomCode(input.value)
      if (code) finish({ role: 'join', code })
      else error.textContent = `A code is ${ROOM_CODE_LENGTH} letters and numbers, like K7QX.`
    }
    host.addEventListener('click', () => finish({ role: 'host', code: makeCode() }))
    join.addEventListener('click', tryJoin)
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') tryJoin()
    })
    input.addEventListener('input', () => (error.textContent = ''))
    back.addEventListener('click', () => finish(null))

    overlay.append(title, note, host, row, error, back)
    mount.appendChild(overlay)
  })
