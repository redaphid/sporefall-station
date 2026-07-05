import { CLASSES } from '../game/data/classes'

const CLASS_BLURBS: Record<string, string> = {
  soldier: 'Guns, grenades, punches harder',
  thief: 'Fast, cloaks, pops easy locks',
  doctor: 'Chloroform, double heals, fast revives',
  hacker: 'Remote-unlocks doors, shorts out enemies',
}

/** Fullscreen class picker shown at boot. Resolves with the chosen class id. */
export const pickClass = (mount: HTMLElement): Promise<string> =>
  new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText =
      'position:absolute;inset:0;background:#0b0b12;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:10px;pointer-events:auto;color:#eee;font:16px system-ui;padding:16px'
    overlay.innerHTML = `<div style="font:800 26px system-ui;margin-bottom:8px">STREETS OF ROGUE-ish</div>
      <div style="opacity:.7;margin-bottom:10px">Pick your troublemaker</div>`
    for (const cls of Object.values(CLASSES)) {
      const b = document.createElement('button')
      b.style.cssText =
        'font:600 16px system-ui;padding:12px 18px;border-radius:10px;border:2px solid #ffffff2e;' +
        'background:#ffffff10;color:#eee;cursor:pointer;width:min(320px,80vw);text-align:left'
      b.innerHTML = `${cls.name} <span style="opacity:.6;font-weight:400;font-size:13px"><br>${CLASS_BLURBS[cls.id] ?? ''}</span>`
      b.addEventListener('click', () => {
        overlay.remove()
        resolve(cls.id)
      })
      overlay.appendChild(b)
    }
    mount.appendChild(overlay)
  })
