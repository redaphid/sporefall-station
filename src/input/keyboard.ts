import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from './input'

/** WASD/arrows move, J/space attack, K/E interact, L/shift special, 1-6 equip
 * hotbar slot, Q/G throw. */
export const createKeyboard = (): InputSource => {
  const down = new Set<string>()
  // Taps between samples must not be lost — accumulate edges.
  let attackEdge = false
  let interactEdge = false
  let specialEdge = false
  let throwEdge = false
  let hotbarEdge = -1
  let seq = 0

  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return
    down.add(ev.code)
    if (ev.code === 'KeyJ' || ev.code === 'Space') attackEdge = true
    if (ev.code === 'KeyK' || ev.code === 'KeyE') interactEdge = true
    if (ev.code === 'KeyL' || ev.code === 'ShiftLeft') specialEdge = true
    if (ev.code === 'KeyQ' || ev.code === 'KeyG') throwEdge = true
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
      cmd.hotbar = hotbarEdge
      attackEdge = false
      interactEdge = false
      specialEdge = false
      throwEdge = false
      hotbarEdge = -1
      if (cmd.moveX !== 0 || cmd.moveY !== 0) {
        cmd.aimX = cmd.moveX
        cmd.aimY = cmd.moveY
      }
      return cmd
    },
  }
}
