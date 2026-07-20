import { emptyInput, type InputCmd } from '../game/types'
import { selectAim, type Aim } from './aim'
import type { InputSource } from './input'

/** WASD/arrows move, J/space attack, K/E interact, L/shift special, 1-6 equip
 * hotbar slot, Q/G throw, F/left-ctrl dodge-roll.
 *
 * `readPointerAim` (optional) supplies the MOUSE as a continuous aim device: a
 * unit vector from the player toward the cursor (see aim.pointerAim). When it
 * returns a deflected vector the bullet follows the cursor to ANY angle; when it
 * returns null/(0,0) — no mouse yet, or the cursor is on the player — aim falls
 * back to the 8-way WASD movement vector (the legacy behavior, and the reason
 * keyboard fire used to be 8-directional). Absent entirely (headless/tests), the
 * source behaves exactly as before. */
export const createKeyboard = (readPointerAim?: () => Aim | null): InputSource => {
  const down = new Set<string>()
  // Taps between samples must not be lost — accumulate edges.
  let attackEdge = false
  let interactEdge = false
  let specialEdge = false
  let throwEdge = false
  let rollEdge = false
  let hotbarEdge = -1
  let seq = 0

  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return
    down.add(ev.code)
    if (ev.code === 'KeyJ' || ev.code === 'Space') attackEdge = true
    if (ev.code === 'KeyK' || ev.code === 'KeyE') interactEdge = true
    if (ev.code === 'KeyL' || ev.code === 'ShiftLeft') specialEdge = true
    if (ev.code === 'KeyQ' || ev.code === 'KeyG') throwEdge = true
    if (ev.code === 'KeyF' || ev.code === 'ControlLeft') rollEdge = true
    if (ev.code.startsWith('Digit')) {
      const n = Number(ev.code.slice(5))
      if (n >= 1 && n <= 6) hotbarEdge = n - 1
    }
  })
  window.addEventListener('keyup', (ev) => down.delete(ev.code))
  window.addEventListener('blur', () => down.clear())

  return {
    sample(): InputCmd {
      const cmd = emptyInput()
      cmd.seq = seq++
      cmd.moveX = (down.has('KeyD') || down.has('ArrowRight') ? 1 : 0) - (down.has('KeyA') || down.has('ArrowLeft') ? 1 : 0)
      cmd.moveY = (down.has('KeyS') || down.has('ArrowDown') ? 1 : 0) - (down.has('KeyW') || down.has('ArrowUp') ? 1 : 0)
      cmd.attack = attackEdge || down.has('KeyJ') || down.has('Space')
      cmd.interact = interactEdge
      cmd.special = specialEdge || down.has('KeyL') || down.has('ShiftLeft')
      cmd.throwItem = throwEdge
      cmd.roll = rollEdge
      cmd.hotbar = hotbarEdge
      attackEdge = false
      interactEdge = false
      specialEdge = false
      throwEdge = false
      rollEdge = false
      hotbarEdge = -1
      // Mouse aim wins when the cursor is off the player (continuous heading);
      // otherwise selectAim falls back to the WASD move vector. Passing (0,0)
      // when no pointer is available reproduces the pre-mouse behavior exactly.
      const p = readPointerAim?.() ?? null
      const aim = selectAim(cmd.moveX, cmd.moveY, p?.x ?? 0, p?.y ?? 0)
      cmd.aimX = aim.x
      cmd.aimY = aim.y
      return cmd
    },
  }
}
