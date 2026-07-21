// Mission panel + objective hyperlinks — thin DOM glue over the pure models
// (missionModel.ts builds the rows, locatorModel.ts does every projection,
// focusModel.ts owns the camera-focus lifecycle in main.ts). All DOM, all view:
// nothing here writes sim state, so determinism is untouched.
//
// Three unobtrusive pieces, all pooled/change-detected like the HUD:
//   • CHIP (top-centre): one compact tappable line — parity with the old plain
//     mission text. Tapping toggles…
//   • PANEL: the objective list. Rows show live progress glyphs (○ active,
//     ✓ done, 🔒 locked); a row with a link is a hyperlink — tapping it asks
//     main.ts to focus the camera on the target (view-layer pan only) and the
//     panel folds itself away again.
//   • MARKERS: while an objective link exists, an on-screen caret (🎯 target /
//     🏁 exit) sits over it and an edge-pinned gold ➤ + distance points at it
//     whenever it is off-screen. Once the mission completes, the exit row's
//     point link becomes the objective — the SAME machinery, no separate exit
//     compass. During an active focus the target gets a pulsing ring.
//     None of it accepts pointer events — gameplay input is never blocked.

import type { RenderView } from '../app/session'
import { missionObjectives, missionChipText, resolveLink, type Objective, type ObjectiveLink } from './missionModel'
import { pointMarker, type CameraState } from './locatorModel'
import { markUiChrome } from './chrome'
import type { CameraSource } from './screens'

export interface MissionPanel {
  update(view: RenderView): void
}

export interface MissionPanelOpts {
  /** Read-only camera state for world→screen projection (same as the locator). */
  cameraSource?: CameraSource
  /** Tap on a linked objective row → main.ts starts a camera focus. */
  onFocus?: (link: ObjectiveLink) => void
  /** The link currently being camera-focused (main.ts owns the FocusState). */
  focusSource?: () => ObjectiveLink | undefined
}

const GOLD = '#ffd76a'
/** Expanded panel folds itself back to the chip after this idle time (ms). */
const AUTO_COLLAPSE_MS = 6000

const GLYPH: Record<Objective['state'], string> = { active: '○', done: '✓', locked: '🔒' }

let cssInjected = false
const injectCss = (): void => {
  if (cssInjected) return
  cssInjected = true
  const style = document.createElement('style')
  style.textContent =
    '@keyframes sporefall-focus-pulse{0%{transform:scale(.85);opacity:.95}50%{transform:scale(1.15);opacity:.55}100%{transform:scale(.85);opacity:.95}}' +
    '@keyframes sporefall-target-bob{0%{transform:translate(-50%,-100%) translateY(0)}50%{transform:translate(-50%,-100%) translateY(-4px)}100%{transform:translate(-50%,-100%) translateY(0)}}'
  document.head.appendChild(style)
}

export const createMissionPanel = (mount: HTMLElement, opts: MissionPanelOpts = {}): MissionPanel => {
  injectCss()

  // ---- top-centre chip + fold-out panel. The root ignores pointer events;
  // only the chip/rows opt back in, so gameplay input is never blocked.
  const root = document.createElement('div')
  root.style.cssText =
    'position:absolute;top:calc(env(safe-area-inset-top, 0px) + 34px);left:50%;transform:translateX(-50%);' +
    'display:flex;flex-direction:column;align-items:center;gap:6px;z-index:72;pointer-events:none;max-width:min(78vw,340px)'
  mount.appendChild(root)

  const chip = document.createElement('button')
  chip.dataset.missionChip = ''
  markUiChrome(chip) // press-exempt UI chrome (chrome.ts) — never a game press
  // Quiet chrome: smaller, dimmer — a reference card, not a headline over the world.
  chip.style.cssText =
    'pointer-events:auto;appearance:none;border:1px solid rgba(255,255,255,.12);border-radius:999px;' +
    'background:rgba(12,14,22,.55);color:#cfcfcf;font:600 12px system-ui;padding:3px 11px;cursor:pointer;' +
    'text-shadow:0 1px 3px #000;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  root.appendChild(chip)

  const panel = document.createElement('div')
  panel.dataset.missionPanel = ''
  markUiChrome(panel)
  panel.style.cssText =
    'pointer-events:auto;display:none;flex-direction:column;gap:4px;min-width:220px;max-width:100%;' +
    'background:rgba(12,14,22,.88);border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:8px;' +
    'box-shadow:0 4px 14px #0008'
  root.appendChild(panel)

  let expanded = false
  let collapseTimer: ReturnType<typeof setTimeout> | undefined
  const setExpanded = (on: boolean): void => {
    expanded = on
    panel.style.display = on ? 'flex' : 'none'
    clearTimeout(collapseTimer)
    if (on) collapseTimer = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS)
  }
  chip.addEventListener('click', () => setExpanded(!expanded))

  // ---- markers layer: target caret / edge arrow / focus ring. Never interactive.
  const markers = document.createElement('div')
  markers.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:64'
  mount.appendChild(markers)

  const caret = document.createElement('div')
  caret.dataset.missionMarker = 'target'
  caret.textContent = '🎯'
  caret.style.cssText =
    'position:absolute;left:0;top:0;display:none;font-size:18px;line-height:1;' +
    'filter:drop-shadow(0 1px 2px #000);animation:sporefall-target-bob 1.6s ease-in-out infinite'
  markers.appendChild(caret)

  const edge = document.createElement('div')
  edge.dataset.missionMarker = 'edge'
  edge.style.cssText =
    `position:absolute;left:0;top:0;display:none;flex-direction:column;align-items:center;gap:1px;color:${GOLD};` +
    'font:800 12px system-ui;text-shadow:0 1px 3px #000;transform-origin:center'
  edge.innerHTML =
    '<div data-edge-arrow style="font-size:26px;line-height:1">➤</div><div data-edge-label style="white-space:nowrap"></div>'
  markers.appendChild(edge)
  const edgeArrow = edge.querySelector<HTMLElement>('[data-edge-arrow]')!
  const edgeLabel = edge.querySelector<HTMLElement>('[data-edge-label]')!

  const ring = document.createElement('div')
  ring.dataset.missionMarker = 'ring'
  ring.style.cssText =
    'position:absolute;left:0;top:0;display:none;width:56px;height:56px;border-radius:50%;' +
    `border:3px solid ${GOLD};box-shadow:0 0 10px ${GOLD},inset 0 0 10px ${GOLD};` +
    'animation:sporefall-focus-pulse 1.1s ease-in-out infinite'
  markers.appendChild(ring)

  // ---- per-frame update, cheap change-detection everywhere.
  let lastChip = ''
  let lastRowsKey = ''
  let rows: Objective[] = []

  const renderRows = (list: Objective[]): void => {
    panel.replaceChildren(
      ...list.map((o) => {
        const row = document.createElement(o.link ? 'button' : 'div')
        row.dataset.objective = o.key
        row.dataset.state = o.state
        const base =
          'display:flex;align-items:center;gap:8px;text-align:left;font:600 13px system-ui;color:#eee;' +
          'text-shadow:0 1px 2px #000;border-radius:7px;padding:5px 8px;background:transparent;border:0;'
        const dim = o.state === 'active' ? '' : 'opacity:.55;'
        const linky = o.link ? `cursor:pointer;color:${GOLD};text-decoration:underline;text-underline-offset:3px;` : ''
        row.style.cssText = base + dim + linky + (o.link ? 'pointer-events:auto' : 'pointer-events:none')
        const glyph = document.createElement('span')
        glyph.textContent = GLYPH[o.state]
        glyph.style.cssText = `flex:0 0 auto;color:${o.state === 'done' ? '#7fd17f' : '#eee'};text-decoration:none`
        const label = document.createElement('span')
        label.textContent = o.text
        label.style.cssText = 'flex:1 1 auto;min-width:0'
        row.append(glyph, label)
        if (o.link) {
          const locate = document.createElement('span')
          locate.dataset.locate = o.key
          locate.textContent = '➤'
          locate.style.cssText = `flex:0 0 auto;color:${GOLD};text-decoration:none`
          row.appendChild(locate)
          const link = o.link
          row.addEventListener('click', () => {
            opts.onFocus?.(link)
            // Fold away shortly after — the tap's job is done, stay unobtrusive.
            setTimeout(() => setExpanded(false), 150)
          })
        }
        return row
      }),
    )
  }

  // ---- markers: the current objective gets a persistent locator; the
  // currently-focused link (entity OR point) gets the pulsing ring.
  const updateMarkers = (view: RenderView): void => {
    const camRaw = opts.cameraSource?.()
    const cam: CameraState | undefined = camRaw ? { ...camRaw, levelW: view.level.w, levelH: view.level.h } : undefined
    const self = view.self

    // Persistent objective locator — the FIRST active linked row: the mission
    // target while the objective is live (entity link), then the exit once it
    // opens (point link). ONE mechanism for both — the old separate "exit
    // compass" (fixed window-pinned arrow, no projection) is gone; the exit
    // gets the same on-target caret / canvas-bounds edge arrow as any target.
    const objective = rows.find((o) => o.state === 'active' && o.link)
    const isExit = objective?.key === 'exit'
    const target = objective?.link && resolveLink(objective.link, view.entities)
    const m = target && self && cam ? pointMarker(self.pos, target, cam) : undefined
    if (m && m.onScreen) {
      caret.textContent = isExit ? '🏁' : '🎯'
      caret.style.display = 'block'
      caret.style.left = `${Math.round(m.sx)}px`
      caret.style.top = `${Math.round(m.sy - 18)}px`
    } else {
      caret.style.display = 'none'
    }
    if (m && !m.onScreen) {
      edge.style.display = 'flex'
      edge.style.transform = `translate(${Math.round(m.sx)}px, ${Math.round(m.sy)}px) translate(-50%,-50%)`
      edgeArrow.style.transform = `rotate(${m.angle}rad)`
      edgeLabel.textContent = isExit ? `LAUNCH BAY · ${m.dist}m` : `🎯 ${m.dist}m`
    } else {
      edge.style.display = 'none'
    }

    // Focus ring on whatever link is being camera-focused right now.
    const focused = opts.focusSource?.()
    const fpos = focused && resolveLink(focused, view.entities)
    const fscreen = fpos && cam ? pointMarker(self?.pos ?? fpos, fpos, cam) : undefined
    if (fscreen && fscreen.onScreen) {
      ring.style.display = 'block'
      ring.style.left = `${Math.round(fscreen.sx - 28)}px`
      ring.style.top = `${Math.round(fscreen.sy - 28)}px`
    } else {
      ring.style.display = 'none'
    }
  }

  return {
    update(view: RenderView): void {
      rows = missionObjectives({
        floor: view.floor,
        missionText: view.missionText,
        missionComplete: view.missionComplete,
        gameOver: view.gameOver,
        missionTargetId: view.missionTargetId,
        entities: view.entities,
        exit: view.level.exit,
      })

      // Chip: hide entirely when there is nothing to say (game over).
      const chipText = rows.length === 0 ? '' : `${missionChipText(view)} ${expanded ? '▾' : '▸'}`
      if (chipText !== lastChip) {
        lastChip = chipText
        chip.textContent = chipText
        chip.style.display = chipText ? '' : 'none'
        if (!chipText) setExpanded(false)
      }

      // Rows: rebuild only when content/links actually changed.
      const rowsKey = rows.map((o) => `${o.key}:${o.state}:${o.text}:${o.link ? (o.link.targetId ?? `${o.link.x},${o.link.y}`) : ''}`).join('|')
      if (rowsKey !== lastRowsKey) {
        lastRowsKey = rowsKey
        renderRows(rows)
      }

      updateMarkers(view)
    },
  }
}
