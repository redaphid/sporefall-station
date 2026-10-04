// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { parseRoomCode, type RoomCode } from '../app/roomCode'
import { createLobbyUi, pickMode } from './menu'
import { pickOnline, type OnlinePick } from './onlineMenu'

const mount = (): HTMLElement => {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const el = <T extends HTMLElement>(root: HTMLElement, role: string): T =>
  root.querySelector<T>(`[data-role="${role}"]`)!

/** Open the screen and track what it resolves with; `undefined` = still open. */
const open = (root: HTMLElement, code = 'K7QX') => {
  const out: { pick: OnlinePick | null | undefined } = { pick: undefined }
  void pickOnline(root, () => parseRoomCode(code) as RoomCode).then((p) => (out.pick = p))
  return out
}

const typeCode = (root: HTMLElement, text: string): void => {
  const input = el<HTMLInputElement>(root, 'online-code')
  input.value = text
  input.dispatchEvent(new Event('input'))
}

describe('the start menu', () => {
  it('offers Play online and resolves it as its own mode', async () => {
    const root = mount()
    let mode: string | undefined
    void pickMode(root).then((m) => (mode = m))
    const online = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('Play online'))
    expect(online).toBeDefined()
    online!.click()
    await flush()
    expect(mode).toBe('online')
  })
})

describe('pickOnline', () => {
  it('hosting hands back a fresh code and closes the screen', async () => {
    const root = mount()
    const out = open(root, 'ZZ22')
    el<HTMLButtonElement>(root, 'online-host').click()
    await flush()
    expect(out.pick).toEqual({ role: 'host', code: 'ZZ22' })
    expect(el(root, 'online-menu')).toBeNull()
  })

  it('joining normalizes what the player typed', async () => {
    const root = mount()
    const out = open(root)
    typeCode(root, ' ab-cd ')
    el<HTMLButtonElement>(root, 'online-join').click()
    await flush()
    expect(out.pick).toEqual({ role: 'join', code: 'ABCD' })
  })

  it.each(['', 'ABC', 'AB0D', 'room-1'])('a bad code %j says why and keeps the screen open', async (bad) => {
    const root = mount()
    const out = open(root)
    typeCode(root, bad)
    el<HTMLButtonElement>(root, 'online-join').click()
    await flush()
    expect(out.pick).toBeUndefined()
    expect(el(root, 'online-error').textContent).toMatch(/4 letters and numbers/)
    expect(el(root, 'online-menu')).not.toBeNull()
  })

  it('fixing the code clears the error, and Enter joins', async () => {
    const root = mount()
    const out = open(root)
    typeCode(root, 'AB')
    el<HTMLButtonElement>(root, 'online-join').click()
    typeCode(root, 'abcd')
    expect(el(root, 'online-error').textContent).toBe('')
    el<HTMLInputElement>(root, 'online-code').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(out.pick).toEqual({ role: 'join', code: 'ABCD' })
  })

  it('Back resolves null and removes the screen', async () => {
    const root = mount()
    const out = open(root)
    Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent === 'Back')!
      .click()
    await flush()
    expect(out.pick).toBeNull()
    expect(root.children).toHaveLength(0)
  })
})

describe('createLobbyUi room code', () => {
  it('shows an online room code as text under the title', () => {
    const root = mount()
    createLobbyUi(root, true, '<b>X</b>')
    const code = root.querySelector('#room-code')!
    expect(code.textContent).toBe('<b>X</b>')
    expect(code.querySelector('b')).toBeNull()
  })

  it('has no code block for a Bluetooth lobby', () => {
    const root = mount()
    createLobbyUi(root, true)
    expect(root.querySelector('#room-code')).toBeNull()
  })
})
