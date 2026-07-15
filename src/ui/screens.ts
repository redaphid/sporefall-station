import type { RenderView } from '../app/session'
import { locatorMarkers, type CameraState, type LocatorMarker, type Teammate } from './locatorModel'

export interface Screens {
  update(view: RenderView): void
}

/** Why the restart overlay is up (drives its heading), or null when it's down. */
export type RestartReason = 'gameOver' | 'downed' | 'dead'

export interface RestartAffordance {
  visible: boolean
  reason: RestartReason | null
}

/** When the restart overlay should be reachable. Beyond full game-over, it also
 * comes up the instant the LOCAL player is downed or dead — so a host/solo player
 * can restart the level immediately instead of waiting out the 30s bleed-out (#5).
 * Pure + exported so the visibility rule is unit-tested apart from the DOM. */
export const restartAffordance = (view: RenderView): RestartAffordance => {
  if (view.gameOver) return { visible: true, reason: 'gameOver' }
  const self = view.self
  if (self?.dead) return { visible: true, reason: 'dead' }
  if (self?.playerCtl?.downed) return { visible: true, reason: 'downed' }
  return { visible: false, reason: null }
}

/** Overlay heading per reason: game-over is terminal ("YOU GOT ROLLED"); a downed/
 * dead player gets a lighter prompt that a restart is available right now. */
const RESTART_HEADLINE: Record<RestartReason, string> = {
  gameOver: 'YOU GOT ROLLED',
  downed: "YOU'RE DOWN",
  dead: 'YOU DIED',
}

/**
 * Read-only camera/screen state for the teammate locator's world→screen
 * projection. main.ts supplies it from the renderer without the locator ever
 * touching pixi. Omitted (undefined) in solo/tests → the on-screen markers just
 * don't render and only the (projection-free) edge arrows would show.
 */
export type CameraSource = () => Omit<CameraState, 'levelW' | 'levelH'>

/** Mission banner, floor-change flash, the run-over overlay, and the co-op locator. All DOM. */
export const createScreens = (mount: HTMLElement, onRestart?: () => void, cameraSource?: CameraSource): Screens => {
  const mission = document.createElement('div')
  // Offset by the notch/status-bar inset (env() → viewport-fit=cover in index.html), and
  // drop below the health-bar band so the centered mission text never overlaps the HUD's
  // top-left health bar on narrow/foldable screens.
  mission.style.cssText =
    'position:absolute;top:calc(env(safe-area-inset-top, 0px) + 34px);left:50%;transform:translateX(-50%);color:#eee;font:600 14px system-ui;' +
    'text-shadow:0 1px 3px #000;pointer-events:none;text-align:center;max-width:70vw'
  mount.appendChild(mission)

  const banner = document.createElement('div')
  banner.style.cssText =
    'position:absolute;top:35%;left:50%;transform:translate(-50%,-50%);color:#ffd76a;font:800 28px system-ui;' +
    'text-shadow:0 2px 6px #000;pointer-events:none;opacity:0;transition:opacity .4s;text-align:center'
  mount.appendChild(banner)

  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:absolute;inset:0;background:#000a;display:none;flex-direction:column;align-items:center;' +
    'justify-content:center;color:#eee;font:16px system-ui;pointer-events:auto;text-align:center;gap:12px'
  overlay.innerHTML = `
    <div id="headline" style="font:800 34px system-ui;color:#e0483f">YOU GOT ROLLED</div>
    <div id="stats"></div>
    <button id="restart" style="font:600 16px system-ui;padding:10px 26px;border-radius:8px;border:0;
      background:#7fd17f;color:#0b0b12;cursor:pointer">Run it back</button>
  `
  mount.appendChild(overlay)
  const headline = overlay.querySelector<HTMLElement>('#headline')!

  // Exit compass: once the exit is open, a rotating arrow at the bottom points
  // the way to the exit tile with a live distance readout, so it's obvious where
  // to go to finish the floor.
  const exitPtr = document.createElement('div')
  exitPtr.style.cssText =
    'position:absolute;bottom:76px;left:50%;transform:translateX(-50%);display:none;flex-direction:column;' +
    'align-items:center;gap:1px;color:#ffd76a;font:800 13px system-ui;text-shadow:0 1px 3px #000;pointer-events:none;z-index:70'
  exitPtr.innerHTML =
    '<div id="exitArrow" style="font-size:30px;line-height:1;transition:transform .1s">➤</div>' +
    '<div id="exitLabel">EXIT</div>'
  mount.appendChild(exitPtr)
  const exitArrow = exitPtr.querySelector<HTMLElement>('#exitArrow')!
  const exitLabel = exitPtr.querySelector<HTMLElement>('#exitLabel')!

  // Co-op teammate locator (issue #34): a DOM overlay of per-teammate markers.
  // Off-screen teammates get an edge-pinned rotating ➤ with a distance readout;
  // on-screen ones get a coloured name caret so players stay distinguishable.
  // Elements are pooled by playerId so we position, not rebuild, each frame.
  const locator = document.createElement('div')
  locator.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:65'
  mount.appendChild(locator)
  const locatorEls = new Map<number, LocatorEl>()

  const restartBtn = overlay.querySelector<HTMLButtonElement>('#restart')!
  if (onRestart) {
    // Host/solo own "play again": rebuild the run in place — NO page reload, so a
    // co-op BLE connection survives and clients resume over the same link.
    restartBtn.addEventListener('click', () => {
      overlay.style.display = 'none'
      onRestart()
    })
  } else {
    // Client: the host drives the restart; a fresh GameStart arrives over the link.
    restartBtn.textContent = 'Waiting for the host…'
    restartBtn.disabled = true
    restartBtn.style.cursor = 'default'
    restartBtn.style.background = '#3a3a44'
  }
  const stats = overlay.querySelector<HTMLElement>('#stats')!

  let bannerTimer: ReturnType<typeof setTimeout> | undefined
  const showBanner = (text: string): void => {
    banner.textContent = text
    banner.style.opacity = '1'
    clearTimeout(bannerTimer)
    bannerTimer = setTimeout(() => (banner.style.opacity = '0'), 2200)
  }

  let lastLocator = ''
  const updateLocator = (view: RenderView): void => {
    const cam = cameraSource?.()
    // Gather every OTHER player (self is the camera target, never located).
    const teammates: Teammate[] = []
    if (view.self) {
      for (const e of view.entities) {
        if (!e.playerCtl || e === view.self || e.dead) continue
        teammates.push({ playerId: e.playerCtl.playerId, x: e.pos.x, y: e.pos.y, downed: !!e.playerCtl.downed })
      }
    }
    // Solo (no teammates) or no camera to project with → clear and bail cheaply.
    if (!view.self || !cam || teammates.length === 0) {
      if (lastLocator !== '') {
        lastLocator = ''
        for (const el of locatorEls.values()) el.root.remove()
        locatorEls.clear()
      }
      return
    }
    const markers = locatorMarkers(view.self.pos, teammates, { ...cam, levelW: view.level.w, levelH: view.level.h })
    // Cheap change-detection (like the HUD): skip DOM writes when nothing moved.
    const key = markers
      .map((m) => `${m.playerId}:${m.onScreen ? 'o' : 'e'}${Math.round(m.sx)},${Math.round(m.sy)}:${m.angle.toFixed(2)}:${m.dist}:${m.color}`)
      .join('|')
    if (key === lastLocator) return
    lastLocator = key
    positionMarkers(locator, locatorEls, markers)
  }

  let lastMission = ''
  let shownReason: RestartReason | null = null
  let lastEventTick = -1
  return {
    update(view: RenderView): void {
      const text = view.missionComplete ? `Floor ${view.floor} — EXIT is open!` : `Floor ${view.floor} — ${view.missionText}`
      if (text !== lastMission) {
        lastMission = text
        mission.textContent = text
      }
      if (view.tick !== lastEventTick) {
        lastEventTick = view.tick
        for (const ev of view.events) {
          if (ev.type === 'missionComplete') showBanner('MISSION COMPLETE')
          else if (ev.type === 'floorChange') showBanner(`FLOOR ${ev.floor}`)
        }
      }
      // Point at the exit whenever it's open (mission done / reach missions).
      if (view.missionComplete && !view.gameOver && view.self) {
        const dx = view.level.exit.x - view.self.pos.x
        const dy = view.level.exit.y - view.self.pos.y
        const dist = Math.hypot(dx, dy)
        if (dist < 1.4) {
          exitPtr.style.display = 'none'
        } else {
          exitPtr.style.display = 'flex'
          // ➤ glyph points east at 0°, matching world +x; +y is screen-down.
          exitArrow.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`
          exitLabel.textContent = `EXIT · ${Math.round(dist)}m`
        }
      } else {
        exitPtr.style.display = 'none'
      }

      updateLocator(view)

      // Restart affordance: up at game-over AND the moment the local player is
      // downed/dead, so they can bail the level without waiting out the bleed-out.
      const affordance = restartAffordance(view)
      if (affordance.reason !== shownReason) {
        shownReason = affordance.reason
        if (affordance.reason) {
          headline.textContent = RESTART_HEADLINE[affordance.reason]
          stats.textContent =
            affordance.reason === 'gameOver'
              ? `Made it to floor ${view.floor} · $${view.self?.playerCtl?.cash ?? 0} collected`
              : onRestart
                ? 'Restart the run now, or wait for a revive.'
                : 'Waiting on your team…'
          overlay.style.display = 'flex'
        } else {
          // Revived / fresh run began — drop back into play.
          overlay.style.display = 'none'
        }
      }
    },
  }
}

/** Pooled DOM for one teammate marker: a rotating arrow glyph + a name/distance tag. */
interface LocatorEl {
  root: HTMLElement
  arrow: HTMLElement
  tag: HTMLElement
}

/** Build a fresh (detached) marker element; screens.ts pools these by playerId. */
const makeLocatorEl = (): LocatorEl => {
  const root = document.createElement('div')
  root.style.cssText =
    'position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:0;' +
    'transform-origin:center;will-change:transform;font:800 12px system-ui;text-shadow:0 1px 3px #000'
  const arrow = document.createElement('div')
  arrow.textContent = '➤'
  arrow.style.cssText = 'font-size:26px;line-height:1;transition:transform .1s'
  const tag = document.createElement('div')
  tag.style.cssText = 'line-height:1;margin-top:1px;white-space:nowrap'
  root.append(arrow, tag)
  return { root, arrow, tag }
}

/**
 * Reconcile the pooled marker elements against the computed markers: create for
 * new teammates, drop for departed ones, and (re)position/paint the rest. On-
 * screen teammates show just a coloured name caret; off-screen ones show the
 * rotating ➤ and a distance readout, edge-pinned by screens.ts's projection.
 */
const positionMarkers = (container: HTMLElement, pool: Map<number, LocatorEl>, markers: readonly LocatorMarker[]): void => {
  const live = new Set<number>()
  for (const m of markers) {
    live.add(m.playerId)
    let el = pool.get(m.playerId)
    if (!el) {
      el = makeLocatorEl()
      container.appendChild(el.root)
      pool.set(m.playerId, el)
    }
    el.root.style.color = m.color
    el.root.style.zIndex = m.downed ? '2' : '1'
    // Centre the marker on its anchor point (translate off its own half-size).
    el.root.style.transform = `translate(${m.sx}px, ${m.sy}px) translate(-50%, -50%)`
    if (m.onScreen) {
      // Visible: a downward caret + name so co-op players stay distinguishable.
      el.arrow.textContent = m.downed ? '✖' : '▼'
      el.arrow.style.transform = 'none'
      el.tag.textContent = m.downed ? `${m.label} DOWN` : m.label
    } else {
      // Off-screen: rotate the ➤ toward them with a live world-distance readout.
      el.arrow.textContent = '➤'
      el.arrow.style.transform = `rotate(${m.angle}rad)`
      el.tag.textContent = `${m.label}${m.downed ? ' DOWN' : ''} · ${m.dist}m`
    }
  }
  for (const [id, el] of pool) {
    if (!live.has(id)) {
      el.root.remove()
      pool.delete(id)
    }
  }
}
