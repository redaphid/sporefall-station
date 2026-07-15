import type { RenderView } from '../app/session'

export interface Screens {
  update(view: RenderView): void
}

/** Mission banner, floor-change flash, and the run-over overlay. All DOM. */
export const createScreens = (mount: HTMLElement, onRestart?: () => void): Screens => {
  const mission = document.createElement('div')
  mission.style.cssText =
    'position:absolute;top:10px;left:50%;transform:translateX(-50%);color:#eee;font:600 14px system-ui;' +
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
    <div style="font:800 34px system-ui;color:#e0483f">YOU GOT ROLLED</div>
    <div id="stats"></div>
    <button id="restart" style="font:600 16px system-ui;padding:10px 26px;border-radius:8px;border:0;
      background:#7fd17f;color:#0b0b12;cursor:pointer">Run it back</button>
  `
  mount.appendChild(overlay)

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

  let lastMission = ''
  let shownGameOver = false
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

      if (view.gameOver && !shownGameOver) {
        shownGameOver = true
        stats.textContent = `Made it to floor ${view.floor} · $${view.self?.playerCtl?.cash ?? 0} collected`
        overlay.style.display = 'flex'
      } else if (!view.gameOver && shownGameOver) {
        // A fresh run began (host restart / play again) — clear the overlay so
        // the reconnected clients and host drop straight back into play.
        shownGameOver = false
        overlay.style.display = 'none'
      }
    },
  }
}
