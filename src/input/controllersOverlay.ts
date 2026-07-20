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
  if (s.throwItem) out.push('T')
  if (s.hotbarPrev) out.push('<')
  if (s.hotbarNext) out.push('>')
  return out.join('')
}

// Slot maps straight to player id; humans count from 1, so slot 0 is P1.
const label = (slot: number | null): string => (slot === null ? 'press to join' : `P${slot + 1}`)

/**
 * The RAW diagnostic line: the ground-truth the shared button map is decoded
 * FROM. On a non-standard pad (an 8BitDo in D-input mode, a raw evdev joystick)
 * the driver's button INDICES are not the W3C order, so the only way to see
 * WHERE a physical button actually lands is to read the raw index off. Pressing
 * R2 and seeing `btn:9` (Start's index) is the direct proof of a misreport — and
 * exactly what to rebind against in Settings → Controller. Axes are shown too so
 * a trigger reported as an axis (D-input pads often do this) is visible rather
 * than silently missing. Empty pieces are dropped; a wholly idle pad still shows
 * its mapping/kind so the profile in force is never a mystery.
 */
export const formatPadDiag = (pad: CoopDebugPad): string => {
  const parts: string[] = []
  const map = pad.mapping === undefined ? undefined : pad.mapping === '' ? '""' : pad.mapping
  if (map !== undefined || pad.kind !== undefined) parts.push([map, pad.kind].filter(Boolean).join(' '))
  if (pad.buttonsDown && pad.buttonsDown.length > 0) parts.push(`btn:${pad.buttonsDown.join(',')}`)
  if (pad.axes && pad.axes.length > 0) parts.push(`ax:${pad.axes.map((a) => a.toFixed(2)).join(',')}`)
  return parts.join(' ')
}

export const formatPadRow = (pad: CoopDebugPad): string => {
  const live = [dirs(pad.state), actions(pad.state)].filter((s) => s.length > 0).join(' ')
  const diag = formatPadDiag(pad)
  return `${label(pad.slot)}  ${pad.id}  [${live}]${diag ? `  «${diag}»` : ''}`
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
