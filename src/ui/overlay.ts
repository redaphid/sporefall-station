// The Claude/player communication overlay — a DOM layer drawn OVER the pixi
// scene each frame. Two INDEPENDENT general capabilities share this surface:
//
//   • Annotations (draw-on-screen): inert `w.annotations` any system can add —
//     entity-anchored labels the ENGINE positions over live sprites, plus free
//     pins/arrows/circles/text banners. Text is legible by construction (measured,
//     clamped fully on-screen, de-overlapped, backed + shadowed — see
//     annotationLayout.ts, which is unit-tested).
//   • Inspect: the player clicks (desktop) or taps/long-presses (touch) an
//     entity to pop up information on it. A quick tap opens a compact CHIP
//     (name + one line); a long-press — or a desktop click, or tapping the
//     chip — opens the full CARD (hp bar, per-kind rows from inspectModel's
//     buildInfoCard, mission locate action). The card anchors BESIDE the
//     entity, clamped fully on-screen (cardAnchor), follows it as it moves,
//     shows a brief "destroyed" state if it dies mid-inspect, and auto-closes
//     on a timeout. The inspected entity keeps the highlight ring via the same
//     inert `Entity.selected` flag an agent uses, so determinism is untouched.
//
// Touch gestures arrive via inspectAt() from the touch layer (which owns the
// stick/pinch claiming rules — the press discrimination itself is pressModel.ts)
// or, when the touch controls are hidden (controller active), from this
// overlay's own listeners. The popup never blocks gameplay input: the card root
// ignores pointer events and only its close/locate/expand affordances opt in.
//
// All positions come from the read-only camera projection (locatorModel.ts);
// the renderer's draw code is untouched.

import type { RenderView } from '../app/session'
import type { Annotation } from '../game/types'
import { visibleAnnotations } from '../game/annotations'
import { pickNearestEntity, pickRadiusAt, clearSelection, setSelected, selectedEntities } from '../game/select'
import { TILE_PX } from '../render/art'
import {
  cardAnchor,
  clampToViewport,
  deOverlap,
  entityLabelAnchor,
  wrapLabel,
  LABEL_LINE_HEIGHT,
  MAX_LABEL_WIDTH,
  type Rect,
} from './annotationLayout'
import { projectToScreen, screenToWorld, type CameraState } from './locatorModel'
import { buildInfoCard, type InfoCard } from './inspectModel'
import { createPressTracker, LONG_PRESS_MS } from './pressModel'
import { isUiChrome, markUiChrome } from './chrome'
import { themeDisplayName } from '../render/themeState'
import type { CameraSource } from './screens'

/** How the popup was asked for — a compact chip (quick tap) or the full card. */
export type InspectMode = 'chip' | 'card'

export interface Overlay {
  update(view: RenderView): void
  /** Open the info popup for whatever entity is under screen point (clientX/Y).
   * The touch input layer calls this AFTER its claiming rules ruled the press
   * neutral (never a stick, pinch, or button). A miss dismisses any open popup. */
  inspectAt(mode: InspectMode, clientX: number, clientY: number): void
}

export interface OverlayOpts {
  /** Mission-panel camera focus (focusModel via main.ts) — the card's locate
   * action for the mission target routes here; no camera logic is duplicated. */
  onFocus?: (link: { targetId: number }) => void
  /** Sprite thumbnail for an art key as a data URL (renderer extract), if any. */
  thumbnail?: (artKey: string) => string | undefined
  /** Where the popup element lives. On phones this must be the UI layer (#ui),
   * which paints ABOVE the touch stick zones — otherwise the chip/✕/locate
   * affordances would be unreachable under them. Defaults to `mount`. Both
   * mounts are full-viewport fixed layers, so coordinates line up 1:1. */
  cardMount?: HTMLElement
}

const DEFAULT_COLOR = '#ffd76a'
const SELECT_COLOR = '#5aa9ff'
/** Sim ticks a chip stays up before auto-dismissing (≈5s at 30tps). */
const CHIP_TICKS = 150
/** Sim ticks the full card stays up before auto-dismissing (≈20s). */
const CARD_TICKS = 600
/** Sim ticks the "destroyed" state lingers before the popup closes (≈1.2s). */
const DESTROYED_TICKS = 36

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

/** The live inspect popup. */
interface InspectState {
  id: number
  mode: InspectMode
  openedTick: number
  /** Tick we noticed the entity dead/gone — drives the destroyed lingering. */
  deadTick?: number
  /** Last screen anchor, kept when the entity vanishes mid-inspect. */
  sx: number
  sy: number
}

export const createOverlay = (mount: HTMLElement, cameraSource?: CameraSource, opts: OverlayOpts = {}): Overlay => {
  // Layers: shapes under text under selection under the inspect popup.
  const shapeLayer = layer(mount, 66)
  const textLayer = layer(mount, 67)
  const selectLayer = layer(mount, 68)

  // The popup root: never blocks gameplay — only its affordances opt back in.
  const card = document.createElement('div')
  card.className = 'inspect-card'
  markUiChrome(card) // its chip/✕/locate taps are chrome, never game presses
  card.style.cssText =
    'position:absolute;left:0;top:0;display:none;z-index:69;pointer-events:none;' +
    'box-sizing:border-box;max-width:250px;background:rgba(12,14,22,.93);' +
    'border:1px solid var(--theme-accent, #5aa9ff);border-radius:10px;padding:8px 10px;' +
    'color:#eee;font:13px system-ui;text-shadow:0 1px 2px #000;box-shadow:0 3px 14px #000a'
  ;(opts.cardMount ?? mount).appendChild(card)

  const shapeEls = new Map<string, HTMLElement>()
  const textEls = new Map<string, TextEl>()
  const selectEls = new Map<number, HTMLElement>()

  let lastView: RenderView | undefined
  let inspect: InspectState | undefined
  let lastCard: InfoCard | undefined
  let lastCardKey = ''
  /** Wall-clock when the popup (re)opened — the chip ignores clicks for its
   * first instants so a touch tap's COMPATIBILITY click (fired at the same
   * point right after touchend) can't ghost-expand a chip that just appeared
   * under the finger. */
  let openedAtMs = 0

  const camState = (view: RenderView): CameraState | undefined => {
    const cam = cameraSource?.()
    return cam ? { ...cam, levelW: view.level.w, levelH: view.level.h } : undefined
  }

  const close = (): void => {
    inspect = undefined
    lastCard = undefined
    lastCardKey = ''
    if (lastView) clearSelection(lastView.entities)
  }

  const openOn = (id: number, mode: InspectMode, tick: number): void => {
    inspect = { id, mode, openedTick: tick, sx: -9999, sy: -9999 }
    lastCard = undefined
    lastCardKey = ''
    openedAtMs = performance.now()
  }

  const expand = (): void => {
    if (!inspect || !lastView) return
    inspect = { ...inspect, mode: 'card', openedTick: lastView.tick }
    lastCardKey = ''
  }

  const inspectAt = (mode: InspectMode, clientX: number, clientY: number): void => {
    const view = lastView
    const cam = view && camState(view)
    if (!view || !cam) return
    const rect = mount.getBoundingClientRect()
    const w = screenToWorld(clientX - rect.left, clientY - rect.top, cam)
    // Zoom-aware pick reach: pickRadiusAt is pure game-side math — the VIEW
    // passes the current px-per-tile in, so src/game stays camera-free.
    // Projectiles are skipped so a tap lands on the actor/prop the player means;
    // fire IS inspectable ("Burning — stay clear").
    const hit = pickNearestEntity(view.entities, w.x, w.y, pickRadiusAt(TILE_PX * cam.zoom), (e) => e.kind !== 'projectile')
    if (!hit) {
      close() // tap on empty space dismisses
      return
    }
    if (inspect?.id === hit.id && inspect.mode === mode) {
      close() // tapping the same entity the same way again toggles it off
      return
    }
    clearSelection(view.entities)
    setSelected(hit, true)
    openOn(hit.id, mode, view.tick)
  }

  // --- pointer wiring on the canvas mount. On phones the touch layer's stick
  // zones sit above this mount and forward neutral presses via inspectAt(); this
  // path serves the desktop mouse and the controller-active case (touch controls
  // hidden → taps land here). Same pure press discrimination (pressModel.ts).
  const press = createPressTracker()
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  mount.addEventListener('pointerdown', (ev) => {
    // Presses on interactive UI chrome (settings gear/panel, …) belong to the
    // chrome, never to inspect (chrome.ts) — structural, not per-widget.
    if (isUiChrome(ev.target)) return
    press.down(ev.pointerId, ev.clientX, ev.clientY, performance.now())
    clearTimeout(pressTimer)
    if (ev.pointerType !== 'mouse') {
      pressTimer = setTimeout(() => {
        const at = press.origin()
        if (at && press.poll(performance.now()) === 'longpress') inspectAt('card', at.x, at.y)
      }, LONG_PRESS_MS)
    }
  })
  mount.addEventListener('pointermove', (ev) => press.move(ev.pointerId, ev.clientX, ev.clientY))
  mount.addEventListener('pointerup', (ev) => {
    clearTimeout(pressTimer)
    if (isUiChrome(ev.target)) press.cancel(ev.pointerId) // released over chrome → never inspect
    const outcome = press.up(ev.pointerId, performance.now())
    if (outcome === null) return
    // Desktop click = the full card straight away; a touch tap opens the chip,
    // a threshold-crossing release (late timer) still opens the card.
    if (ev.pointerType === 'mouse') inspectAt('card', ev.clientX, ev.clientY)
    else inspectAt(outcome === 'longpress' ? 'card' : 'chip', ev.clientX, ev.clientY)
  })
  mount.addEventListener('pointercancel', (ev) => {
    clearTimeout(pressTimer)
    press.cancel(ev.pointerId)
    press.up(ev.pointerId, performance.now())
  })

  // ---- popup DOM rendering (change-detected; repositioned every frame).
  const renderPopup = (c: InfoCard, mode: InspectMode, destroyed: boolean): void => {
    const key = `${mode}:${destroyed}:${JSON.stringify(c)}`
    if (key === lastCardKey) return
    lastCardKey = key
    card.dataset.mode = mode
    card.replaceChildren()
    card.style.opacity = destroyed ? '0.75' : '1'

    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;gap:8px'
    const thumbUrl = opts.thumbnail?.(c.artKey)
    if (thumbUrl) {
      const img = document.createElement('img')
      img.src = thumbUrl
      img.alt = ''
      img.style.cssText =
        `width:${mode === 'card' ? 36 : 26}px;height:${mode === 'card' ? 36 : 26}px;flex:0 0 auto;` +
        'image-rendering:pixelated;object-fit:contain;filter:drop-shadow(0 1px 2px #000)'
      header.appendChild(img)
    } else {
      const glyph = document.createElement('span')
      glyph.textContent = c.glyph
      glyph.style.cssText = `font-size:${mode === 'card' ? 22 : 16}px;line-height:1;flex:0 0 auto`
      header.appendChild(glyph)
    }
    const titleBox = document.createElement('div')
    titleBox.style.cssText = 'flex:1 1 auto;min-width:0'
    const title = document.createElement('div')
    title.dataset.inspectTitle = ''
    title.textContent = destroyed ? `${c.title} — destroyed` : c.title
    title.style.cssText =
      'font:700 14px system-ui;color:var(--theme-accent, #5aa9ff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    titleBox.appendChild(title)
    if (mode === 'card') {
      const sub = document.createElement('div')
      sub.textContent = c.kind
      sub.style.cssText = 'font:600 11px system-ui;opacity:.6;text-transform:capitalize'
      titleBox.appendChild(sub)
    }
    header.appendChild(titleBox)
    if (mode === 'card') {
      // ✕ — one of the popup's few interactive spots; the rest passes through.
      const x = document.createElement('button')
      x.dataset.inspectClose = ''
      x.textContent = '✕'
      x.style.cssText =
        'pointer-events:auto;appearance:none;border:0;background:transparent;color:#eee;opacity:.7;' +
        'font:700 14px system-ui;cursor:pointer;padding:2px 4px;flex:0 0 auto;align-self:flex-start'
      x.addEventListener('pointerdown', (ev) => ev.stopPropagation())
      x.addEventListener('click', close)
      header.appendChild(x)
    }
    card.appendChild(header)

    // hp bar (both modes — the one vital stat worth the chip's pixels). Hidden
    // on a destroyed card: a corpse with a "full" bar reads as a lie.
    if (c.hp && c.hp.max > 0 && !destroyed) {
      const bar = document.createElement('div')
      bar.dataset.inspectHp = `${c.hp.hp}/${c.hp.max}`
      bar.style.cssText = 'height:6px;border-radius:3px;background:#ffffff22;margin:6px 0 2px;overflow:hidden'
      const fill = document.createElement('div')
      const frac = Math.max(0, Math.min(1, c.hp.hp / c.hp.max))
      fill.style.cssText = `height:100%;width:${Math.round(frac * 100)}%;border-radius:3px;background:${
        frac > 0.5 ? '#7fd17f' : frac > 0.25 ? '#ffd76a' : '#ff6b6b'
      }`
      bar.appendChild(fill)
      card.appendChild(bar)
    }

    if (c.tagline) {
      const tag = document.createElement('div')
      tag.dataset.inspectTagline = ''
      tag.textContent = destroyed ? 'Destroyed' : c.tagline
      tag.style.cssText = 'font:600 12px system-ui;opacity:.85;margin-top:4px'
      card.appendChild(tag)
    }

    if (mode === 'card' && !destroyed) {
      for (const row of c.rows) {
        const r = document.createElement('div')
        r.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font:13px system-ui;line-height:1.5'
        const k = document.createElement('span')
        k.textContent = row.label
        k.style.opacity = '0.7'
        const v = document.createElement('span')
        v.textContent = row.value
        v.style.cssText = 'font-weight:600;text-align:right'
        r.append(k, v)
        card.appendChild(r)
      }
      if (c.mission && opts.onFocus) {
        const m = document.createElement('button')
        m.dataset.inspectMission = ''
        m.textContent = '🎯 Mission target — locate'
        m.style.cssText =
          'pointer-events:auto;appearance:none;display:block;width:100%;margin-top:6px;border-radius:7px;' +
          'border:1px solid var(--theme-accent, #ffd76a);background:transparent;color:var(--theme-accent, #ffd76a);' +
          'font:700 12px system-ui;padding:4px 6px;cursor:pointer'
        const targetId = c.mission.targetId
        m.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        m.addEventListener('click', () => opts.onFocus?.({ targetId }))
        card.appendChild(m)
      }
    }

    // The whole CHIP is tappable — expanding to the full card is its one job.
    const chipTappable = mode === 'chip' && !destroyed
    card.style.cursor = chipTappable ? 'pointer' : 'default'
    card.style.pointerEvents = chipTappable ? 'auto' : 'none'
  }
  // Chip-expand wiring (the card mode never reaches these: pointer-events:none).
  card.addEventListener('pointerdown', (ev) => ev.stopPropagation())
  card.addEventListener('click', () => {
    // Ghost-click guard: the compatibility click of the very tap that opened
    // this chip must not immediately expand it.
    if (inspect?.mode === 'chip' && performance.now() - openedAtMs > 250) expand()
  })

  const updatePopup = (view: RenderView, cam: CameraState | undefined, vw: number, vh: number): void => {
    if (!inspect) {
      card.style.display = 'none'
      return
    }
    const e = view.entities.find((t) => t.id === inspect!.id)
    const gone = !e || !!e.dead

    // Death/despawn mid-inspect: linger briefly in a destroyed state, then close.
    if (gone && inspect.deadTick === undefined) inspect.deadTick = view.tick
    if (!gone) inspect.deadTick = undefined
    const timedOut =
      (inspect.deadTick !== undefined && view.tick - inspect.deadTick >= DESTROYED_TICKS) ||
      view.tick - inspect.openedTick >= (inspect.mode === 'chip' ? CHIP_TICKS : CARD_TICKS)
    if (timedOut) {
      close()
      card.style.display = 'none'
      return
    }

    const c = e
      ? buildInfoCard(e, { selfId: view.self?.id, missionTargetId: view.missionTargetId }, themeDisplayName)
      : lastCard // entity despawned entirely — show its last known card as destroyed
    if (!c) {
      close()
      card.style.display = 'none'
      return
    }
    lastCard = c
    renderPopup(c, inspect.mode, gone)
    card.style.display = 'block'

    // Anchor beside the LIVE entity (follows it); keep the last anchor if gone.
    if (e && cam) {
      const p = projectToScreen(e.pos.x, e.pos.y, cam)
      inspect.sx = p.x
      inspect.sy = p.y
    }
    const at = cardAnchor(inspect.sx, inspect.sy, card.offsetWidth, card.offsetHeight, vw, vh)
    card.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`
  }

  return {
    inspectAt,
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

      // ---- selection rings: every selected entity (player-inspected or
      // agent-multi-selected) gets the highlight.
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

      updatePopup(view, cam, vw, vh)
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
