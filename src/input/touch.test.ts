// @vitest-environment happy-dom
// The on-screen touch controls. Playtest fixes: the ATK button is GONE (the aim
// joystick fires, twin-stick style), the action buttons form a compact bottom-
// right cluster, and every control hides under an active gamepad.

import { beforeEach, describe, expect, it } from 'vitest'
import { aimFires, createTouch } from './touch'

const mount = (): HTMLElement => {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** Leaf (childless) divs carrying text — the action buttons at construction time
 * (the hotbar strip is empty until update() runs). */
const buttons = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('div')].filter((d) => d.children.length === 0 && (d.textContent?.trim() ?? '') !== '')

const labels = (root: HTMLElement): string[] => buttons(root).map((b) => b.textContent!.trim())

const px = (v: string): number => parseFloat(v || '0')
/** Bounding box in bottom-right-anchored coords (right/bottom grow left/up). */
const box = (b: HTMLElement): { r: number; b: number; w: number; h: number } => ({
  r: px(b.style.right),
  b: px(b.style.bottom),
  w: px(b.style.width),
  h: px(b.style.height),
})
const overlaps = (a: HTMLElement, c: HTMLElement): boolean => {
  const x = box(a)
  const y = box(c)
  // Two axis-aligned rects overlap iff they overlap on both axes.
  const xGap = Math.abs(x.r - y.r) >= (x.w + y.w) / 2
  const yGap = Math.abs(x.b - y.b) >= (x.h + y.h) / 2
  return !(xGap || yGap)
}

describe('touch controls — #2 the ATK button is removed (aim joystick fires)', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = mount()
  })

  it('renders no ATK / fire button', () => {
    createTouch(root)
    expect(labels(root)).not.toContain('ATK')
  })

  it('a deflected aim stick still produces an attack input — firing survives', () => {
    const touch = createTouch(root)
    const aimZone = [...root.querySelectorAll<HTMLElement>('div')].find(
      (z) => z.style.width === '50%' && z.style.right === '0px',
    )!
    aimZone.setPointerCapture = () => {}
    const PE = (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent
    aimZone.dispatchEvent(new PE('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }))
    aimZone.dispatchEvent(new PE('pointermove', { pointerId: 1, clientX: 200, clientY: 100 }))
    expect(touch.sample().attack).toBe(true)
  })

  it('aimFires: only a deflection past the fire threshold shoots', () => {
    expect(aimFires(0, 0)).toBe(false)
    expect(aimFires(0.4, 0)).toBe(false)
    expect(aimFires(0.9, 0)).toBe(true)
    expect(aimFires(0, -0.8)).toBe(true)
    expect(createTouch(mount()).sample().attack).toBe(false) // centred → no fire
  })
})

describe('touch controls — #3 the action buttons are a compact, non-overlapping cluster', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = mount()
  })

  it('renders exactly the four action verbs', () => {
    createTouch(root)
    expect(labels(root).sort()).toEqual(['ROLL', 'SPC', 'THRW', 'USE'])
  })

  it('every button is small (≤ 56px) — noticeably smaller than the old 64–84px', () => {
    createTouch(root)
    for (const b of buttons(root)) {
      expect(box(b).w).toBeLessThanOrEqual(56)
      expect(box(b).h).toBeLessThanOrEqual(56)
    }
  })

  it('no two buttons overlap, and all sit in the thumb-reachable bottom-right', () => {
    createTouch(root)
    const bs = buttons(root)
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) expect(overlaps(bs[i], bs[j])).toBe(false)
    // Bottom-right cluster: clears the centred hotbar (bottom:12) and hugs the corner.
    for (const b of bs) {
      expect(box(b).b).toBeGreaterThanOrEqual(60) // above the hotbar band
      expect(box(b).r).toBeLessThan(160) // near the right edge
    }
  })
})

describe('touch controls — #4 hide under an active controller', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = mount()
  })

  it('setVisible(false) hides all controls; (true) shows them', () => {
    const touch = createTouch(root)
    const wrapper = root.firstElementChild as HTMLElement
    expect(wrapper.style.display).not.toBe('none') // visible by default
    touch.setVisible(false)
    expect(wrapper.style.display).toBe('none')
    touch.setVisible(true)
    expect(wrapper.style.display).toBe('block')
  })
})

describe('touch controls — UI chrome is press-EXEMPT (the settings-gear bug class)', () => {
  let root: HTMLElement
  const PE = (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent
  const zoneOf = (side: 'left' | 'right'): HTMLElement =>
    root.querySelector<HTMLElement>(`[data-stick-zone="${side}"]`)!

  beforeEach(() => {
    root = mount()
  })

  it('a tap on a data-ui-chrome element nested in the touch layer NEVER classifies as inspect', () => {
    const touch = createTouch(root)
    const fired: string[] = []
    touch.setInspectHandler((mode) => fired.push(mode))
    // Adversarial: some future overlay mounts its chrome INSIDE a stick zone.
    const gearish = document.createElement('button')
    gearish.dataset.uiChrome = ''
    zoneOf('right').appendChild(gearish)
    gearish.dispatchEvent(new PE('pointerdown', { pointerId: 7, clientX: 30, clientY: 30, bubbles: true }))
    gearish.dispatchEvent(new PE('pointerup', { pointerId: 7, clientX: 30, clientY: 30, bubbles: true }))
    expect(fired).toEqual([]) // chrome owns its tap outright
  })

  it('control case: the same tap on the bare zone DOES classify as an inspect tap', () => {
    const touch = createTouch(root)
    const fired: string[] = []
    touch.setInspectHandler((mode) => fired.push(mode))
    const zone = zoneOf('right')
    zone.setPointerCapture = () => {}
    zone.dispatchEvent(new PE('pointerdown', { pointerId: 8, clientX: 30, clientY: 30, bubbles: true }))
    zone.dispatchEvent(new PE('pointerup', { pointerId: 8, clientX: 30, clientY: 30, bubbles: true }))
    expect(fired).toEqual(['tap'])
  })

  it('a press that starts on a zone but is RELEASED over chrome never inspects (sub-slop drift onto the gear)', () => {
    const touch = createTouch(root)
    const fired: string[] = []
    touch.setInspectHandler((mode) => fired.push(mode))
    const zone = zoneOf('right')
    zone.setPointerCapture = () => {}
    const gearish = document.createElement('button')
    gearish.dataset.uiChrome = ''
    zone.appendChild(gearish)
    zone.dispatchEvent(new PE('pointerdown', { pointerId: 9, clientX: 40, clientY: 40, bubbles: true }))
    gearish.dispatchEvent(new PE('pointerup', { pointerId: 9, clientX: 44, clientY: 42, bubbles: true }))
    expect(fired).toEqual([])
  })
})
