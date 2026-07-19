import type { RenderView } from '../app/session'
import { emptyInput, type InputCmd } from '../game/types'
import { hotbarSlots, type HotbarSlot } from '../ui/hotbarModel'
import { pinchZoom, type ZoomSink } from '../render/zoomModel'
import { aimFires, selectAim } from './aim'
import type { InputSource } from './input'
import { createPinchTracker } from './pinch'
import { createPressTracker, LONG_PRESS_MS } from '../ui/pressModel'
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
  /** Receive neutral tap / long-press gestures for tap-to-inspect (screen
   * client px). Only presses the claiming rules ruled NEUTRAL arrive here —
   * a press that became a stick, pinch, or button never does (pressModel.ts). */
  setInspectHandler(cb: (mode: 'tap' | 'longpress', clientX: number, clientY: number) => void): void
}

/**
 * Twin virtual joysticks (left = move, right = aim/fire) + right-side action
 * buttons + a tappable hotbar strip and throw button. DOM/pointer based, with
 * edge-accumulated taps so none are lost between sim ticks.
 *
 * With a `zoom` sink, two fingers on the SAME half also pinch-to-zoom (claiming
 * rules + rationale: pinch.ts). Pinching fingers emit no stick input; buttons
 * and the hotbar are never part of a pinch (their touches target those elements,
 * not the stick zones, so the tracker never sees them).
 */
export const createTouch = (mount: HTMLElement, zoom?: ZoomSink): TouchInput => {
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

  // --- pinch-to-zoom plumbing (see pinch.ts for the claiming rules). The
  // tracker only ever sees touches that land on the stick zones; each stick
  // registers a cancel hook so a fresh claim converted to a pinch zeroes out
  // instantly (no phantom movement/aim).
  const tracker = createPinchTracker()
  const stickRegs: { pointerId(): number | null; cancel(): void }[] = []
  let pinchStartZoom = 1
  controls.addEventListener('pointermove', (ev) => {
    const st = tracker.move(ev.pointerId, ev.clientX, ev.clientY)
    if (st && zoom) {
      const rect = controls.getBoundingClientRect()
      zoom.set(pinchZoom(pinchStartZoom, st.startDist, st.dist), st.midX - rect.left, st.midY - rect.top)
    }
  })
  const pinchUp = (ev: PointerEvent): void => {
    if (tracker.up(ev.pointerId, performance.now()).resetTap) zoom?.reset()
  }
  controls.addEventListener('pointerup', pinchUp)
  controls.addEventListener('pointercancel', pinchUp)

  // --- tap / long-press to INSPECT (pressModel.ts owns the discrimination).
  // Listens at the controls level (zone events bubble here) but only presses
  // that BEGIN on a stick zone count — buttons and hotbar slots capture their
  // own taps and must never double as inspect presses. A press that becomes a
  // stick (>slop movement) or is joined by a second fresh finger (pinch/twin
  // plant) silently drops out inside the tracker; a clean quick release taps,
  // a clean 400ms hold long-presses. The stick claim is never cancelled, so
  // inspect steals no input in either direction.
  const press = createPressTracker()
  let inspectCb: ((mode: 'tap' | 'longpress', clientX: number, clientY: number) => void) | undefined
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  controls.addEventListener('pointerdown', (ev) => {
    if (!(ev.target instanceof HTMLElement) || ev.target.dataset.stickZone === undefined) return
    // Register EVERY zone press (even one the pinch just consumed): the
    // tracker's join rule is what disqualifies the other finger of a pinch.
    press.down(ev.pointerId, ev.clientX, ev.clientY, performance.now())
    clearTimeout(pressTimer)
    pressTimer = setTimeout(() => {
      const at = press.origin()
      if (at && press.poll(performance.now()) === 'longpress') inspectCb?.('longpress', at.x, at.y)
    }, LONG_PRESS_MS + 10)
  })
  controls.addEventListener('pointermove', (ev) => press.move(ev.pointerId, ev.clientX, ev.clientY))
  controls.addEventListener('pointerup', (ev) => {
    const out = press.up(ev.pointerId, performance.now())
    if (out !== null) inspectCb?.(out, ev.clientX, ev.clientY)
  })
  controls.addEventListener('pointercancel', (ev) => {
    press.cancel(ev.pointerId)
    press.up(ev.pointerId, performance.now())
  })

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
    zone.dataset.stickZone = side // inspect presses may only start on a zone
    zone.style.cssText = `position:absolute;${side}:0;top:0;bottom:0;width:50%;pointer-events:auto;touch-action:none`
    controls.append(base, nub, zone)

    let pointer: number | null = null
    let ox = 0
    let oy = 0
    const hide = (): void => {
      base.style.display = 'none'
      nub.style.display = 'none'
    }
    // A fresh claim converted into a pinch: zero the vector and drop the claim —
    // the touch had sub-threshold deflection, so nothing fired or moved yet.
    stickRegs.push({
      pointerId: () => pointer,
      cancel: () => {
        if (pointer === null) return
        try {
          zone.releasePointerCapture(pointer)
        } catch {
          /* already released */
        }
        pointer = null
        onMove(0, 0)
        hide()
      },
    })
    zone.addEventListener('pointerdown', (ev) => {
      const willClaim = pointer === null
      // Register with the pinch tracker FIRST: it may claim this touch (and a
      // fresh earlier one) for a pinch instead of the stick.
      const consumedIds = tracker.down(ev.pointerId, ev.clientX, ev.clientY, side, willClaim, performance.now())
      if (consumedIds.length > 0) {
        for (const reg of stickRegs) {
          const p = reg.pointerId()
          if (p !== null && consumedIds.includes(p)) reg.cancel()
        }
        if (zoom) pinchStartZoom = zoom.get()
        return // this touch belongs to the pinch, never to a stick
      }
      if (!willClaim || tracker.consumed(ev.pointerId)) return
      pointer = ev.pointerId
      try {
        zone.setPointerCapture(ev.pointerId)
      } catch {
        /* synthetic events (tests) have no active pointer to capture */
      }
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
      hide()
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
    setInspectHandler(cb): void {
      inspectCb = cb
    },
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
