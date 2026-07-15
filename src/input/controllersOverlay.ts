import type { CoopDebugPad } from './gamepadCoop'
import type { PadState } from './readPad'

/**
 * On-screen controllers debug overlay: which pads are connected, which player
 * each is assigned to, and their live button/axis state. The row text is a pure
 * function so it stays unit-testable; the DOM piece just paints those rows.
 */
const dirs = (s: PadState): string => {
  const out: string[] = []
  if (s.moveX < 0) out.push('L')
  if (s.moveX > 0) out.push('R')
  if (s.moveY < 0) out.push('U')
  if (s.moveY > 0) out.push('D')
  return out.join('')
}

const actions = (s: PadState): string => {
  const out: string[] = []
  if (s.attack) out.push('A')
  if (s.interact) out.push('I')
  if (s.special) out.push('S')
  if (s.pause) out.push('P')
  return out.join('')
}

// Keyboard is player 1, so pad slot 0 shows as P2.
const label = (slot: number | null): string => (slot === null ? 'press to join' : `P${slot + 2}`)

export const formatPadRow = (pad: CoopDebugPad): string => {
  const live = [dirs(pad.state), actions(pad.state)].filter((s) => s.length > 0).join(' ')
  return `${label(pad.slot)}  ${pad.id}  [${live}]`
}

export const createControllersOverlay = (mount: HTMLElement) => {
  const box = document.createElement('div')
  box.style.cssText =
    'position:absolute;top:8px;left:8px;z-index:50;font:600 12px ui-monospace,monospace;' +
    'color:#eaeaea;background:#000000b0;border:1px solid #ffffff30;border-radius:8px;' +
    'padding:8px 10px;pointer-events:none;white-space:pre;line-height:1.5;max-width:60vw'
  let visible = new URLSearchParams(location.search).get('pads') === '1'
  box.style.display = visible ? 'block' : 'none'
  mount.appendChild(box)

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F9') return
    visible = !visible
    box.style.display = visible ? 'block' : 'none'
  })

  const update = (pads: CoopDebugPad[]): void => {
    if (!visible) return
    const head = `CONTROLLERS (${pads.length})  F9 to hide`
    const rows = pads.map(formatPadRow)
    box.textContent = [head, ...rows].join('\n')
  }

  return { update }
}
