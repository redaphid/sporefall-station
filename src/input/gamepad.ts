import { emptyInput, type InputCmd } from '../game/types'
import { selectAim } from './aim'
import type { InputSource } from './input'

/**
 * Standard-mapping gamepad input. Left stick / d-pad move; face buttons act.
 *   - A (button 0) = attack (primary)
 *   - B (button 1) = interact
 *   - X (button 2) = special
 *   - RT/RB (7/5)  = attack (alt, easy for kids)
 * Edge-triggered buttons accumulate between samples so a quick tap is never lost.
 * Poll-based: navigator.getGamepads() is read fresh on every sample() from the
 * rAF/sim loop. A gamepad only appears after the user presses a button in the
 * browser (Gamepad API security), so keep the keyboard fallback merged in.
 */
const DEADZONE = 0.28

const prevPressed = new Map<number, boolean>()
const edges = { attack: false, interact: false, special: false }

// Track button rising-edges across the whole session (works even before sample()).
const scanEdges = (): void => {
  const pads = navigator.getGamepads?.() ?? []
  for (const pad of pads) {
    if (!pad) continue
    const press = (i: number): boolean => (pad.buttons[i]?.pressed ?? false)
    const rising = (i: number): boolean => {
      const now = press(i)
      const key = pad.index * 100 + i
      const was = prevPressed.get(key) ?? false
      prevPressed.set(key, now)
      return now && !was
    }
    if (rising(0) || rising(7) || rising(5)) edges.attack = true
    if (rising(1)) edges.interact = true
    if (rising(2) || rising(3)) edges.special = true
  }
}

export const createGamepad = (): InputSource => {
  let seq = 0
  let logged = false

  window.addEventListener('gamepadconnected', (e) => {
    // eslint-disable-next-line no-console
    console.log('[gamepad] connected:', (e as GamepadEvent).gamepad.id)
  })

  return {
    sample(): InputCmd {
      scanEdges()
      const cmd = emptyInput()
      cmd.seq = seq++

      const pads = navigator.getGamepads?.() ?? []
      let pad: Gamepad | null = null
      for (const p of pads) {
        if (p) {
          pad = p
          break
        }
      }
      if (!pad) return cmd

      if (!logged) {
        logged = true
        // eslint-disable-next-line no-console
        console.log('[gamepad] active:', pad.id)
      }

      let mx = pad.axes[0] ?? 0
      let my = pad.axes[1] ?? 0
      if (Math.abs(mx) < DEADZONE) mx = 0
      if (Math.abs(my) < DEADZONE) my = 0

      // D-pad (standard mapping buttons 12-15) overrides/augments the stick.
      const btn = (i: number): boolean => pad!.buttons[i]?.pressed ?? false
      if (btn(14)) mx = -1
      if (btn(15)) mx = 1
      if (btn(12)) my = -1
      if (btn(13)) my = 1

      cmd.moveX = mx
      cmd.moveY = my

      const held = btn(0) || btn(7) || btn(5)
      cmd.attack = edges.attack || held
      cmd.interact = edges.interact || btn(1)
      cmd.special = edges.special || btn(2) || btn(3)
      edges.attack = false
      edges.interact = false
      edges.special = false

      // Right stick (standard axes 2/3) aims; falls back to aim-where-you-move.
      let ax = pad.axes[2] ?? 0
      let ay = pad.axes[3] ?? 0
      if (Math.abs(ax) < DEADZONE) ax = 0
      if (Math.abs(ay) < DEADZONE) ay = 0
      const aim = selectAim(mx, my, ax, ay)
      cmd.aimX = aim.x
      cmd.aimY = aim.y
      return cmd
    },
  }
}
