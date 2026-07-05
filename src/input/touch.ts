import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from './input'

const STICK_RADIUS = 60 // px of thumb travel for full speed

/**
 * Left-half virtual joystick + right-side action buttons.
 * DOM-based, pointer events, edge-accumulated taps so none are lost between ticks.
 */
export const createTouch = (mount: HTMLElement): InputSource => {
  let moveX = 0
  let moveY = 0
  let attackHeld = false
  let attackEdge = false
  let interactEdge = false
  let specialEdge = false
  let seq = 0

  // --- joystick (left half of screen) ---
  const stickBase = document.createElement('div')
  stickBase.style.cssText =
    'position:absolute;width:110px;height:110px;border-radius:50%;background:#ffffff14;' +
    'border:2px solid #ffffff2e;display:none;pointer-events:none'
  const stickNub = document.createElement('div')
  stickNub.style.cssText =
    'position:absolute;width:48px;height:48px;border-radius:50%;background:#ffffff30;pointer-events:none;display:none'
  mount.append(stickBase, stickNub)

  let stickPointer: number | null = null
  let originX = 0
  let originY = 0

  const zone = document.createElement('div')
  zone.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:50%;pointer-events:auto;touch-action:none'
  mount.appendChild(zone)

  zone.addEventListener('pointerdown', (ev) => {
    if (stickPointer !== null) return
    stickPointer = ev.pointerId
    zone.setPointerCapture(ev.pointerId)
    originX = ev.clientX
    originY = ev.clientY
    stickBase.style.display = 'block'
    stickNub.style.display = 'block'
    stickBase.style.left = `${originX - 55}px`
    stickBase.style.top = `${originY - 55}px`
    stickNub.style.left = `${originX - 24}px`
    stickNub.style.top = `${originY - 24}px`
  })
  zone.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== stickPointer) return
    const dx = ev.clientX - originX
    const dy = ev.clientY - originY
    const len = Math.hypot(dx, dy)
    const clamped = Math.min(len, STICK_RADIUS)
    const nx = len > 0 ? (dx / len) * clamped : 0
    const ny = len > 0 ? (dy / len) * clamped : 0
    moveX = nx / STICK_RADIUS
    moveY = ny / STICK_RADIUS
    stickNub.style.left = `${originX + nx - 24}px`
    stickNub.style.top = `${originY + ny - 24}px`
  })
  const endStick = (ev: PointerEvent): void => {
    if (ev.pointerId !== stickPointer) return
    stickPointer = null
    moveX = 0
    moveY = 0
    stickBase.style.display = 'none'
    stickNub.style.display = 'none'
  }
  zone.addEventListener('pointerup', endStick)
  zone.addEventListener('pointercancel', endStick)

  // --- action buttons (right side) ---
  const makeButton = (
    label: string,
    right: number,
    bottom: number,
    size: number,
    onDown: () => void,
    onUp?: () => void,
  ): void => {
    const b = document.createElement('div')
    b.textContent = label
    b.style.cssText =
      `position:absolute;right:${right}px;bottom:${bottom}px;width:${size}px;height:${size}px;border-radius:50%;` +
      'background:#ffffff1c;border:2px solid #ffffff38;color:#fff;display:flex;align-items:center;' +
      `justify-content:center;font:700 ${size / 4}px system-ui;pointer-events:auto;touch-action:none;` +
      'user-select:none;-webkit-user-select:none'
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      b.style.background = '#ffffff40'
      onDown()
    })
    const up = (): void => {
      b.style.background = '#ffffff1c'
      onUp?.()
    }
    b.addEventListener('pointerup', up)
    b.addEventListener('pointercancel', up)
    mount.appendChild(b)
  }

  makeButton('ATK', 24, 96, 84, () => {
    attackHeld = true
    attackEdge = true
  }, () => (attackHeld = false))
  makeButton('USE', 118, 40, 64, () => (interactEdge = true))
  makeButton('SPC', 24, 210, 64, () => (specialEdge = true))

  return {
    sample(): InputCmd {
      const cmd = emptyInput()
      cmd.seq = seq++
      cmd.moveX = moveX
      cmd.moveY = moveY
      cmd.attack = attackHeld || attackEdge
      cmd.interact = interactEdge
      cmd.special = specialEdge
      attackEdge = false
      interactEdge = false
      specialEdge = false
      if (Math.hypot(moveX, moveY) > 0.15) {
        cmd.aimX = moveX
        cmd.aimY = moveY
      }
      return cmd
    },
  }
}

/** OR-merge multiple input sources (keyboard for dev, touch on phone). */
export const mergeInputs = (...sources: InputSource[]): InputSource => ({
  sample(): InputCmd {
    const cmds = sources.map((s) => s.sample())
    const out = cmds[0]
    for (let i = 1; i < cmds.length; i++) {
      const c = cmds[i]
      if (Math.hypot(c.moveX, c.moveY) > Math.hypot(out.moveX, out.moveY)) {
        out.moveX = c.moveX
        out.moveY = c.moveY
        out.aimX = c.aimX
        out.aimY = c.aimY
      }
      out.attack ||= c.attack
      out.interact ||= c.interact
      out.special ||= c.special
    }
    return out
  },
})
