// The Claude/player communication overlay — a DOM layer drawn OVER the pixi
// scene each frame. Two INDEPENDENT general capabilities share this surface:
//
//   • Annotations (draw-on-screen): inert `w.annotations` any system can add —
//     entity-anchored labels the ENGINE positions over live sprites, plus free
//     pins/arrows/circles/text banners. Text is legible by construction (measured,
//     clamped fully on-screen, de-overlapped, backed + shadowed — see
//     annotationLayout.ts, which is unit-tested).
//   • Selection: the player taps an entity to point it out; it gets a highlight
//     ring and a friendly tap-inspect card. Selection is a plain per-entity flag
//     (Entity.selected), so an agent reads it with a normal `entities` query.
//
// All positions come from the read-only camera projection (locatorModel.ts); the
// renderer's draw code is untouched. Selection writes only the inert `selected`
// flag, so determinism is preserved.

import type { RenderView } from '../app/session'
import type { Entity } from '../game/entity'
import type { Annotation } from '../game/types'
import { visibleAnnotations } from '../game/annotations'
import { pickNearestEntity, clearSelection, setSelected, selectedEntities } from '../game/select'
import { TILE_PX } from '../render/art'
import {
  clampToViewport,
  deOverlap,
  entityLabelAnchor,
  wrapLabel,
  LABEL_LINE_HEIGHT,
  MAX_LABEL_WIDTH,
  type Rect,
} from './annotationLayout'
import { projectToScreen, screenToWorld, type CameraState } from './locatorModel'
import { inspectCard } from './inspectModel'
import { themeDisplayName } from '../render/themeState'
import type { CameraSource } from './screens'

export interface Overlay {
  update(view: RenderView): void
}

const DEFAULT_COLOR = '#ffd76a'
const SELECT_COLOR = '#5aa9ff'
/** Tap vs drag: a pointer that travels more than this (px) is a joystick drag, not a tap. */
const TAP_SLOP = 10
/** World-tile radius a tap snaps to the nearest entity within. */
const PICK_RADIUS = 1.2

/** Common legibility styling every annotation TEXT element shares: a backing
 * plate, a text-shadow, a min-legible font, and word-boundary wrapping. The
 * overlay pre-wraps into ≤3 nowrap lines so width/height stay bounded and nothing
 * clips (scrollWidth==clientWidth). */
const TEXT_CSS =
  'position:absolute;left:0;top:0;box-sizing:border-box;' +
  `font:600 13px/${LABEL_LINE_HEIGHT}px system-ui;color:#fff;` +
  'background:rgba(12,14,22,.85);border:1px solid rgba(255,255,255,.20);border-radius:6px;' +
  'padding:2px 7px;text-shadow:0 1px 3px #000,0 0 2px #000;box-shadow:0 2px 8px #0007;' +
  'pointer-events:none;white-space:nowrap'

interface TextEl {
  root: HTMLElement
}

/** One placement request routed through the measure→clamp→de-overlap pipeline. */
interface TextItem {
  key: string
  text: string
  color: string
  /** Screen anchor the text hangs off (sprite point, projected world point, or banner point). */
  ax: number
  ay: number
  mode: 'entity' | 'point' | 'banner'
  /** Entity this caption is anchored to (entity mode only) — exposed as a data
   * attribute so an e2e can prove the label never covers its target sprite. */
  targetId?: number
}

export const createOverlay = (mount: HTMLElement, cameraSource?: CameraSource): Overlay => {
  // Layers: shapes under text under selection under the inspect card.
  const shapeLayer = layer(mount, 66)
  const textLayer = layer(mount, 67)
  const selectLayer = layer(mount, 68)

  const card = document.createElement('div')
  card.style.cssText =
    'position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);right:12px;max-width:240px;display:none;' +
    'flex-direction:column;gap:8px;z-index:69;pointer-events:auto;font:13px system-ui'
  mount.appendChild(card)

  const shapeEls = new Map<string, HTMLElement>()
  const textEls = new Map<string, TextEl>()
  const selectEls = new Map<number, HTMLElement>()

  let lastView: RenderView | undefined

  const camState = (view: RenderView): CameraState | undefined => {
    const cam = cameraSource?.()
    return cam ? { ...cam, levelW: view.level.w, levelH: view.level.h } : undefined
  }

  // --- tap-to-select: pick the nearest entity under a tap, toggle its `selected`
  // flag; a tap on empty space clears the selection. Never consumes movement input
  // (listener is passive and only reacts to non-drag taps).
  let downX = 0
  let downY = 0
  let downId = -1
  mount.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX
    downY = ev.clientY
    downId = ev.pointerId
  })
  mount.addEventListener('pointerup', (ev) => {
    if (ev.pointerId !== downId) return
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > TAP_SLOP) return // a drag, not a tap
    const view = lastView
    const cam = view && camState(view)
    if (!view || !cam) return
    const rect = mount.getBoundingClientRect()
    const w = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, cam)
    // Ignore projectiles/fire so a tap lands on the actor/prop the player means.
    const hit = pickNearestEntity(view.entities, w.x, w.y, PICK_RADIUS, (e) => e.kind !== 'projectile' && e.kind !== 'fire')
    if (hit) setSelected(hit, !hit.selected)
    else clearSelection(view.entities)
  })

  return {
    update(view: RenderView): void {
      lastView = view
      const cam = camState(view)
      const vw = mount.clientWidth
      const vh = mount.clientHeight
      const anns = visibleAnnotations(view.annotations ?? [], view.tick)
      const T = TILE_PX * (cam?.zoom ?? 1)

      // Resolve an annotation's screen anchor: entity-anchored reads the LIVE
      // entity position (so the mark follows it); else the world point; text banners
      // fall back to a fixed screen point. Returns undefined when it should not draw
      // (target gone / off-screen / no camera).
      const anchorOf = (a: Annotation): { x: number; y: number; onScreen: boolean } | undefined => {
        if (a.targetId !== undefined) {
          const e = view.entities.find((t) => t.id === a.targetId)
          if (!e || e.dead || !cam) return undefined
          const p = projectToScreen(e.pos.x, e.pos.y, cam)
          const onScreen = p.x >= 0 && p.x <= vw && p.y >= 0 && p.y <= vh
          return { ...p, onScreen }
        }
        if (a.x !== undefined && a.y !== undefined) {
          if (a.kind === 'text') return { x: a.x, y: a.y, onScreen: true } // text x/y are screen px
          if (!cam) return undefined
          const p = projectToScreen(a.x, a.y, cam)
          return { ...p, onScreen: p.x >= 0 && p.x <= vw && p.y >= 0 && p.y <= vh }
        }
        return { x: vw / 2, y: 24, onScreen: true } // bannerless text default
      }

      // ---- shapes (pin / circle / arrow), each an inert SVG-free DOM glyph.
      const liveShapes = new Set<string>()
      for (const a of anns) {
        if (a.kind !== 'pin' && a.kind !== 'circle' && a.kind !== 'arrow') continue
        const at = anchorOf(a)
        if (!at || !at.onScreen) continue
        const key = `${a.kind}:${a.id}`
        liveShapes.add(key)
        const el = shapeEls.get(key) ?? mkShape(shapeLayer, key)
        shapeEls.set(key, el)
        paintShape(el, a, at, T, cam)
      }
      for (const [k, el] of shapeEls)
        if (!liveShapes.has(k)) {
          el.remove()
          shapeEls.delete(k)
        }

      // ---- collect every TEXT placement (labels, banners, and shape captions).
      const items: TextItem[] = []
      for (const a of anns) {
        const at = anchorOf(a)
        if (a.kind === 'text') {
          if (at) items.push({ key: `text:${a.id}`, text: a.text ?? '', color: a.color ?? DEFAULT_COLOR, ax: at.x, ay: at.y, mode: 'banner' })
          continue
        }
        if (!at || !at.onScreen) continue
        // A `label` is pure text; a shape's optional `text` is a caption beside it.
        if (a.text) {
          const mode = a.targetId !== undefined ? 'entity' : 'point'
          items.push({
            key: `label:${a.id}`,
            text: a.text,
            color: a.color ?? (a.kind === 'label' ? DEFAULT_COLOR : SELECT_COLOR),
            ax: at.x,
            ay: at.y,
            mode,
            targetId: a.targetId,
          })
        }
      }

      // ---- place text: write content, MEASURE, compute desired top-left, then
      // de-overlap and clamp fully on-screen (annotationLayout.ts — unit-tested).
      const liveText = new Set<string>()
      const placed: { item: TextItem; el: HTMLElement; rect: Rect }[] = []
      for (const it of items) {
        liveText.add(it.key)
        const te = textEls.get(it.key) ?? mkText(textLayer, it.key)
        textEls.set(it.key, te)
        if (it.targetId !== undefined) te.root.dataset.target = String(it.targetId)
        else delete te.root.dataset.target
        setText(te.root, it.text, it.color)
        const w = te.root.offsetWidth
        const h = te.root.offsetHeight
        let x: number
        let y: number
        if (it.mode === 'banner') {
          x = it.ax - w / 2
          y = it.ay
        } else if (it.mode === 'entity') {
          const a = entityLabelAnchor(it.ax, it.ay, w, h)
          x = a.x
          y = a.y
        } else {
          x = it.ax - w / 2
          y = it.ay - 14 - h // just above the point/shape
        }
        placed.push({ item: it, el: te.root, rect: { x, y, w, h } })
      }
      // Spread overlapping boxes, then clamp each fully inside the viewport.
      const spread = deOverlap(placed.map((p) => p.rect))
      placed.forEach((p, i) => {
        const c = clampToViewport(spread[i], vw, vh)
        p.el.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`
      })
      for (const [k, te] of textEls)
        if (!liveText.has(k)) {
          te.root.remove()
          textEls.delete(k)
        }

      // ---- selection: a highlight ring on every selected entity + the inspect card.
      const selected = selectedEntities(view.entities)
      const liveSel = new Set<number>()
      if (cam) {
        for (const e of selected) {
          liveSel.add(e.id)
          const p = projectToScreen(e.pos.x, e.pos.y, cam)
          const el = selectEls.get(e.id) ?? mkRing(selectLayer)
          selectEls.set(e.id, el)
          const d = Math.max(22, e.radius * 2 * T + 14)
          el.style.width = `${d}px`
          el.style.height = `${d}px`
          el.style.transform = `translate(${Math.round(p.x - d / 2)}px, ${Math.round(p.y - d / 2)}px)`
        }
      }
      for (const [id, el] of selectEls)
        if (!liveSel.has(id)) {
          el.remove()
          selectEls.delete(id)
        }

      renderCard(card, selected)
    },
  }
}

// ---------------------------------------------------------------------------
// DOM builders (kept tiny + pooled by key, like the locator in screens.ts).

const layer = (mount: HTMLElement, z: number): HTMLElement => {
  const el = document.createElement('div')
  el.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:${z}`
  mount.appendChild(el)
  return el
}

const mkText = (parent: HTMLElement, key: string): TextEl => {
  const root = document.createElement('div')
  root.dataset.annotation = key
  root.className = 'annotation-text'
  root.style.cssText = TEXT_CSS
  parent.appendChild(root)
  return { root }
}

/** Set the caption to pre-wrapped ≤3 nowrap lines so width/height stay bounded and
 * text never clips (scrollWidth==clientWidth). */
const setText = (el: HTMLElement, text: string, color: string): void => {
  const lines = wrapLabel(text)
  el.replaceChildren(
    ...lines.map((ln) => {
      const d = document.createElement('div')
      d.textContent = ln
      d.style.cssText = 'white-space:nowrap'
      return d
    }),
  )
  el.style.color = color
  el.style.maxWidth = `${MAX_LABEL_WIDTH}px`
}

const mkShape = (parent: HTMLElement, key: string): HTMLElement => {
  const el = document.createElement('div')
  el.dataset.shape = key
  el.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none'
  parent.appendChild(el)
  return el
}

/** Paint a pin (dropped marker), circle (world-radius ring), or arrow (tail→head line). */
const paintShape = (
  el: HTMLElement,
  a: Annotation,
  at: { x: number; y: number },
  T: number,
  cam: CameraState | undefined,
): void => {
  const color = a.color ?? DEFAULT_COLOR
  el.replaceChildren()
  if (a.kind === 'circle') {
    const r = (a.radius ?? 1) * T
    el.style.width = `${r * 2}px`
    el.style.height = `${r * 2}px`
    el.style.transform = `translate(${Math.round(at.x - r)}px, ${Math.round(at.y - r)}px)`
    el.style.border = `3px solid ${color}`
    el.style.borderRadius = '50%'
    el.style.background = 'transparent'
    el.style.boxShadow = `0 0 6px ${color}, inset 0 0 6px ${color}`
  } else if (a.kind === 'pin') {
    el.style.width = '0'
    el.style.height = '0'
    el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`
    el.style.border = 'none'
    el.style.borderRadius = '0'
    el.style.boxShadow = 'none'
    const dot = document.createElement('div')
    dot.textContent = '📍'
    dot.style.cssText = `position:absolute;transform:translate(-50%,-100%);font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px #000)`
    el.appendChild(dot)
  } else if (a.kind === 'arrow') {
    // Tail defaults to a point up-left of the head so a bare arrow still shows.
    const head = at
    const tail =
      a.x2 !== undefined && a.y2 !== undefined && cam
        ? projectToScreen(a.x2, a.y2, cam)
        : { x: at.x - 60, y: at.y - 60 }
    const dx = head.x - tail.x
    const dy = head.y - tail.y
    const len = Math.hypot(dx, dy) || 1
    const ang = Math.atan2(dy, dx)
    el.style.width = '0'
    el.style.height = '0'
    el.style.transform = `translate(${Math.round(tail.x)}px, ${Math.round(tail.y)}px)`
    el.style.border = 'none'
    el.style.boxShadow = 'none'
    const line = document.createElement('div')
    line.style.cssText =
      `position:absolute;left:0;top:0;height:3px;width:${Math.round(len)}px;background:${color};` +
      `transform-origin:0 50%;transform:rotate(${ang}rad);border-radius:2px;box-shadow:0 0 4px ${color}`
    const headGlyph = document.createElement('div')
    headGlyph.textContent = '➤'
    headGlyph.style.cssText =
      `position:absolute;left:${Math.round(dx)}px;top:${Math.round(dy)}px;color:${color};font-size:18px;line-height:1;` +
      `transform:translate(-60%,-50%) rotate(${ang}rad);filter:drop-shadow(0 1px 2px #000)`
    el.append(line, headGlyph)
  }
}

const mkRing = (parent: HTMLElement): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'selection-ring'
  el.style.cssText =
    'position:absolute;left:0;top:0;border-radius:50%;pointer-events:none;' +
    `border:3px solid ${SELECT_COLOR};box-shadow:0 0 8px ${SELECT_COLOR},inset 0 0 8px ${SELECT_COLOR}`
  parent.appendChild(el)
  return el
}

/** The tap-inspect readout — one friendly card per selected entity (multi-select). */
const renderCard = (card: HTMLElement, selected: readonly Entity[]): void => {
  if (selected.length === 0) {
    card.style.display = 'none'
    card.replaceChildren()
    return
  }
  card.style.display = 'flex'
  card.replaceChildren(
    ...selected.map((e) => {
      const c = inspectCard(e, themeDisplayName)
      const box = document.createElement('div')
      box.className = 'inspect-card'
      box.style.cssText =
        'background:rgba(12,14,22,.92);border:1px solid rgba(90,169,255,.5);border-radius:8px;padding:8px 10px;' +
        'color:#eee;text-shadow:0 1px 2px #000;box-shadow:0 3px 12px #0009'
      const title = document.createElement('div')
      title.textContent = c.title
      title.style.cssText = 'font:700 14px system-ui;color:#5aa9ff;margin-bottom:4px'
      box.appendChild(title)
      for (const row of c.rows) {
        const r = document.createElement('div')
        r.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font:13px system-ui;line-height:1.5'
        const k = document.createElement('span')
        k.textContent = row.label
        k.style.opacity = '0.7'
        const v = document.createElement('span')
        v.textContent = row.value
        v.style.fontWeight = '600'
        r.append(k, v)
        box.appendChild(r)
      }
      return box
    }),
  )
}
