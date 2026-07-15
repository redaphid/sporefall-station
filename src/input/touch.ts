import type { RenderView } from '../app/session'
import { emptyInput, type InputCmd } from '../game/types'
import { hotbarSlots, type HotbarSlot } from '../ui/hotbarModel'
import { aimFires, selectAim } from './aim'
import type { InputSource } from './input'
import { computeTouchLabels } from './touchLabels'

// Re-exported from the shared, DOM-free aim module so existing importers
// (`./touch`) keep working while readPad/gamepad reuse the same threshold.
export { aimFires } from './aim'

const STICK_RADIUS = 60 // px of thumb travel for full speed

/** An InputSource that also refreshes its button labels from live game state and
 * can hide itself when a gamepad takes over. */
export interface TouchInput extends InputSource {
  update(view: RenderView): void
  /** Hide the on-screen sticks/buttons while a controller is driving (and show
   * them again when it leaves). */
  setControllerActive(active: boolean): void
}

/**
 * Twin virtual joysticks (left = move, right = aim/fire) + right-side action
 * buttons + a tappable hotbar strip and throw button. DOM/pointer based, with
 * edge-accumulated taps so none are lost between sim ticks.
 */
export const createTouch = (mount: HTMLElement): TouchInput => {
  // One wrapper owns every touch control, so a controller takeover hides them all
  // with a single display toggle (setControllerActive). pointer-events:none lets
  // taps fall through to the canvas except where a child (stick zone / button /
  // hotbar slot) opts back in.
  const controls = document.createElement('div')
  controls.style.cssText = 'position:absolute;inset:0;pointer-events:none;touch-action:none'
  mount.appendChild(controls)

  let moveX = 0
  let moveY = 0
  let aimX = 0
  let aimY = 0
  let interactEdge = false
  let specialEdge = false
  let throwEdge = false
  let rollEdge = false
  let hotbarEdge = -1
  let seq = 0

  // A virtual stick that pops up under the thumb on its half of the screen and
  // reports a -1..1 vector via `onMove`. Shared by the move and aim sticks.
  const makeStick = (side: 'left' | 'right', onMove: (x: number, y: number) => void): void => {
    const base = document.createElement('div')
    base.style.cssText =
      'position:absolute;width:110px;height:110px;border-radius:50%;background:#ffffff14;' +
      'border:2px solid #ffffff2e;display:none;pointer-events:none'
    const nub = document.createElement('div')
    nub.style.cssText =
      'position:absolute;width:48px;height:48px;border-radius:50%;background:#ffffff30;pointer-events:none;display:none'
    // Append the zone AFTER the art but BEFORE the buttons/hotbar (created later)
    // so those interactive controls sit on top and capture their own taps.
    const zone = document.createElement('div')
    zone.style.cssText = `position:absolute;${side}:0;top:0;bottom:0;width:50%;pointer-events:auto;touch-action:none`
    controls.append(base, nub, zone)

    let pointer: number | null = null
    let ox = 0
    let oy = 0
    zone.addEventListener('pointerdown', (ev) => {
      if (pointer !== null) return
      pointer = ev.pointerId
      zone.setPointerCapture(ev.pointerId)
      ox = ev.clientX
      oy = ev.clientY
      base.style.display = 'block'
      nub.style.display = 'block'
      base.style.left = `${ox - 55}px`
      base.style.top = `${oy - 55}px`
      nub.style.left = `${ox - 24}px`
      nub.style.top = `${oy - 24}px`
    })
    zone.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== pointer) return
      const dx = ev.clientX - ox
      const dy = ev.clientY - oy
      const len = Math.hypot(dx, dy)
      const clamped = Math.min(len, STICK_RADIUS)
      const nx = len > 0 ? (dx / len) * clamped : 0
      const ny = len > 0 ? (dy / len) * clamped : 0
      onMove(nx / STICK_RADIUS, ny / STICK_RADIUS)
      nub.style.left = `${ox + nx - 24}px`
      nub.style.top = `${oy + ny - 24}px`
    })
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointer) return
      pointer = null
      onMove(0, 0)
      base.style.display = 'none'
      nub.style.display = 'none'
    }
    zone.addEventListener('pointerup', end)
    zone.addEventListener('pointercancel', end)
  }

  makeStick('left', (x, y) => {
    moveX = x
    moveY = y
  })
  makeStick('right', (x, y) => {
    aimX = x
    aimY = y
  })

  // --- action buttons: a compact 2×2 cluster tucked into the bottom-right,
  // thumb-reachable and small (BTN px), with the most-used verb (USE) lowest.
  // Grid pitch (PITCH) leaves a clear gap so none overlap each other, the hotbar
  // (bottom-centre), or the aim zone drag. ATK is gone — aiming fires. ---
  const BTN = 52
  const PITCH = 64
  const makeButton = (
    label: string,
    col: 0 | 1,
    row: 0 | 1,
    onDown: () => void,
  ): HTMLElement => {
    const right = 20 + col * PITCH
    const bottom = 92 + row * PITCH
    const b = document.createElement('div')
    b.textContent = label
    b.style.cssText =
      `position:absolute;right:${right}px;bottom:${bottom}px;width:${BTN}px;height:${BTN}px;border-radius:50%;` +
      'background:#ffffff1c;border:2px solid #ffffff38;color:#fff;display:flex;align-items:center;' +
      `justify-content:center;font:700 12px system-ui;pointer-events:auto;touch-action:none;` +
      'user-select:none;-webkit-user-select:none'
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      b.style.background = '#ffffff40'
      onDown()
    })
    const up = (): void => {
      b.style.background = '#ffffff1c'
    }
    b.addEventListener('pointerup', up)
    b.addEventListener('pointercancel', up)
    controls.appendChild(b)
    return b
  }

  // Lower row (row 0) sits closest to the thumb: USE (inner) + ROLL (outer).
  // Upper row (row 1): THRW (inner) + SPC (outer).
  const useBtn = makeButton('USE', 0, 0, () => (interactEdge = true))
  makeButton('ROLL', 1, 0, () => (rollEdge = true))
  const throwBtn = makeButton('THRW', 0, 1, () => (throwEdge = true))
  const spcBtn = makeButton('SPC', 1, 1, () => (specialEdge = true))

  // --- tappable hotbar strip (bottom centre, between the two sticks) ---
  const hotbar = document.createElement('div')
  hotbar.style.cssText =
    'position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:8px;' +
    'pointer-events:none;touch-action:none' // container passes taps through; slots opt back in
  controls.appendChild(hotbar)

  // Rewrite a label/dim only when it changes — same lastX guard the HUD uses.
  let lastUse = ''
  let lastUseEnabled = true
  let lastSpc = ''
  let lastSpcEnabled = true
  let lastThrowEnabled = true
  let lastHotbar = ''
  const setLabel = (b: HTMLElement, text: string): void => {
    b.textContent = text
  }
  const setEnabled = (b: HTMLElement, on: boolean): void => {
    b.style.opacity = on ? '1' : '0.4'
  }

  const renderHotbar = (slots: HotbarSlot[]): void => {
    hotbar.replaceChildren()
    for (const slot of slots) {
      const el = document.createElement('div')
      el.textContent = `${slot.label} ${slot.qty}`
      el.style.cssText =
        `padding:6px 10px;border-radius:6px;font:700 13px system-ui;pointer-events:auto;touch-action:none;` +
        'user-select:none;-webkit-user-select:none;border:2px solid ' +
        (slot.active ? '#d4af37' : '#ffffff38') +
        ';background:' +
        (slot.active ? '#d4af37cc' : '#000000aa') +
        ';color:' +
        (slot.active ? '#111' : '#eee')
      // Equip the tapped slot's REAL inventory index (display order skips the
      // briefcase, so never send the strip position).
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault()
        hotbarEdge = slot.index
      })
      hotbar.appendChild(el)
    }
  }

  return {
    setControllerActive(active: boolean): void {
      // A gamepad has taken over → hide every on-screen control (and reveal them
      // again when it leaves). One toggle on the wrapper covers sticks + buttons +
      // hotbar; hidden controls receive no pointer events, so sampling idles out.
      controls.style.display = active ? 'none' : 'block'
    },
    update(view: RenderView): void {
      const { use, useEnabled, spc, spcEnabled, throwEnabled } = computeTouchLabels(view)
      if (use !== lastUse) {
        lastUse = use
        setLabel(useBtn, use)
      }
      if (useEnabled !== lastUseEnabled) {
        lastUseEnabled = useEnabled
        setEnabled(useBtn, useEnabled)
      }
      if (spc !== lastSpc) {
        lastSpc = spc
        setLabel(spcBtn, spc)
      }
      if (spcEnabled !== lastSpcEnabled) {
        lastSpcEnabled = spcEnabled
        setEnabled(spcBtn, spcEnabled)
      }
      if (throwEnabled !== lastThrowEnabled) {
        lastThrowEnabled = throwEnabled
        setEnabled(throwBtn, throwEnabled)
      }

      const inv = view.self?.playerCtl?.inventory ?? []
      const active = view.self?.playerCtl?.activeSlot ?? -1
      const slots = hotbarSlots(inv, active)
      const key = slots.map((s) => `${s.index}:${s.itemId}·${s.qty}${s.active ? '*' : ''}`).join(',')
      if (key !== lastHotbar) {
        lastHotbar = key
        renderHotbar(slots)
      }
    },
    sample(): InputCmd {
      const cmd = emptyInput()
      cmd.seq = seq++
      cmd.moveX = moveX
      cmd.moveY = moveY
      cmd.attack = aimFires(aimX, aimY)
      cmd.interact = interactEdge
      cmd.special = specialEdge
      cmd.throwItem = throwEdge
      cmd.roll = rollEdge
      cmd.hotbar = hotbarEdge
      interactEdge = false
      specialEdge = false
      throwEdge = false
      rollEdge = false
      hotbarEdge = -1
      const aim = selectAim(moveX, moveY, aimX, aimY)
      cmd.aimX = aim.x
      cmd.aimY = aim.y
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
      }
      // Aim: whichever source is actually aiming wins (keeps twin-stick aim from
      // being clobbered by a second, centred source).
      if (Math.hypot(c.aimX, c.aimY) > Math.hypot(out.aimX, out.aimY)) {
        out.aimX = c.aimX
        out.aimY = c.aimY
      }
      out.attack ||= c.attack
      out.interact ||= c.interact
      out.special ||= c.special
      out.throwItem ||= c.throwItem
      out.roll ||= c.roll
      if (c.hotbar >= 0) out.hotbar = c.hotbar
    }
    return out
  },
})
