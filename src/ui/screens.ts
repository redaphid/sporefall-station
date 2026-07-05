import type { RenderView } from '../app/session'

export interface Screens {
  update(view: RenderView): void
}

/** Mission banner, floor-change flash, and the run-over overlay. All DOM. */
export const createScreens = (mount: HTMLElement): Screens => {
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
  overlay.querySelector<HTMLButtonElement>('#restart')!.addEventListener('click', () => {
    const url = new URL(location.href)
    url.searchParams.set('seed', String((Math.random() * 0xffffffff) >>> 0))
    location.href = url.toString()
  })
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
      if (view.gameOver && !shownGameOver) {
        shownGameOver = true
        stats.textContent = `Made it to floor ${view.floor} · $${view.self?.playerCtl?.cash ?? 0} collected`
        overlay.style.display = 'flex'
      }
    },
  }
}
