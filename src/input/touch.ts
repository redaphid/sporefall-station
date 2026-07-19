import type { RenderView } from '../app/session'
import { emptyInput, type InputCmd } from '../game/types'
import { hotbarSlots, type HotbarSlot } from '../ui/hotbarModel'
import { pinchZoom, type ZoomSink } from '../render/zoomModel'
import { aimFires, selectAim } from './aim'
import type { InputSource } from './input'
import { createPinchTracker } from './pinch'
import { createPressTracker, LONG_PRESS_MS } from '../ui/pressModel'
import { isUiChrome } from '../ui/chrome'
import { computeTouchLabels } from './touchLabels'

// Re-exported from the shared, DOM-free aim module so existing importers
// (`./touch`) keep working while readPad/gamepad reuse the same threshold.
export { aimFires } from './aim'

const STICK_RADIUS = 60 // px of thumb travel for full speed

/** An InputSource that also refreshes its button labels from live game state and
 * can hide itself when a gamepad takes over. */
export interface TouchInput extends InputSource {
  update(view: RenderView): void
  /** Show/hide every on-screen control. The policy (who wins between touch and
   * a gamepad, desktop vs phone) lives in stickVisibility.ts — this only
   * applies the verdict. Hiding is visual AND input-inert: the wrapper is
   * display:none, so nothing here hit-tests, and any in-flight stick drag or
   * pinch is cancelled cleanly (vectors zeroed, captures released). */
  setVisible(visible: boolean): void
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
  // with a single display toggle (setVisible). pointer-events:none lets
  // taps fall through to the canvas except where a child (stick zone / button /
  // hotbar slot) opts back in. data-role lets tests and e2e find it by meaning,
  // not by DOM position.
  const controls = document.createElement('div')
  controls.dataset.role = 'touch-controls'
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
  let press = createPressTracker() // recreated on hide (see setVisible)
  let inspectCb: ((mode: 'tap' | 'longpress', clientX: number, clientY: number) => void) | undefined
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  controls.addEventListener('pointerdown', (ev) => {
    // Interactive UI chrome (data-ui-chrome — settings gear, panels, …) owns
    // its tap outright: it never enters the press classification, even if a
    // future overlay ends up nested inside this wrapper (chrome.ts).
    if (isUiChrome(ev.target)) return
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
    // A press RELEASED over chrome (finger drifted onto the gear/panel) is the
    // chrome's business too — drop it instead of classifying (chrome.ts).
    if (isUiChrome(ev.target)) press.cancel(ev.pointerId)
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
    // Ghost buttons: visible enough to find with a thumb, dim enough that the
    // world stays the subject (they brighten on press for feedback).
    b.style.cssText =
      `position:absolute;right:${right}px;bottom:${bottom}px;width:${BTN}px;height:${BTN}px;border-radius:50%;` +
      'background:#ffffff10;border:1px solid #ffffff2a;color:#ffffffb8;display:flex;align-items:center;' +
      `justify-content:center;font:600 12px system-ui;pointer-events:auto;touch-action:none;` +
      'user-select:none;-webkit-user-select:none'
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      b.style.background = '#ffffff38'
      onDown()
    })
    const up = (): void => {
      b.style.background = '#ffffff10'
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
      // Quiet chrome: the WORLD is the subject. The active slot is a dark
      // translucent pill with a gold edge/text — an accent, not a gold slab
      // brighter than anything in the scene.
      el.style.cssText =
        `padding:4px 9px;border-radius:6px;font:600 12px system-ui;pointer-events:auto;touch-action:none;` +
        'user-select:none;-webkit-user-select:none;border:1px solid ' +
        (slot.active ? '#d4af3799' : '#ffffff24') +
        ';background:' +
        (slot.active ? '#151009c0' : '#00000080') +
        ';color:' +
        (slot.active ? '#e8c96a' : '#cfcfcf')
      // Equip the tapped slot's REAL inventory index (display order skips the
      // briefcase, so never send the strip position).
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault()
        hotbarEdge = slot.index
      })
      hotbar.appendChild(el)
    }
  }

  let shown = true
  return {
    setInspectHandler(cb): void {
      inspectCb = cb
    },
    setVisible(visible: boolean): void {
      if (visible === shown) return
      shown = visible
      if (!visible) {
        // Hiding mid-gesture: a finger may be captured on a stick RIGHT NOW,
        // and once the wrapper is display:none its pointerup will never reach
        // us. Release every in-flight claim (vector → 0, capture released, art
        // hidden) so no input sticks, and wipe the pinch tracker so a
        // half-tracked ghost finger can't pair into a phantom pinch later.
        // Already-latched button edges are NOT cleared: those presses happened
        // while the controls were live, so they still deliver once.
        for (const reg of stickRegs) reg.cancel()
        tracker.reset()
        // Same story for the inspect press: its pointerup will never arrive,
        // so drop any half-tracked press and its pending long-press timer —
        // a stale entry would wrongly disqualify the next fresh press.
        clearTimeout(pressTimer)
        press = createPressTracker()
      }
      // One toggle on the wrapper covers sticks + buttons + hotbar; a hidden
      // wrapper is hit-test-inert, so taps in former stick zones flow through
      // to the canvas underneath (inspect, annotations) instead of being
      // claimed here.
      controls.style.display = visible ? 'block' : 'none'
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
