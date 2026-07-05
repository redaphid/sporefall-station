import { WEAPONS } from '../game/data/items'
import type { RenderView } from '../app/session'

export interface Hud {
  update(view: RenderView): void
}

export const createHud = (mount: HTMLElement): Hud => {
  const root = document.createElement('div')
  root.style.cssText =
    'position:absolute;left:12px;top:10px;color:#eee;font:14px system-ui;text-shadow:0 1px 2px #000;pointer-events:none;'
  root.innerHTML = `
    <div style="width:160px;height:14px;background:#3338;border:1px solid #000;border-radius:3px;overflow:hidden">
      <div id="hp" style="width:100%;height:100%;background:linear-gradient(#7fd17f,#4a9a4a);transition:width .15s"></div>
    </div>
    <div id="info" style="margin-top:4px;opacity:.9"></div>
  `
  mount.appendChild(root)
  const hpBar = root.querySelector<HTMLElement>('#hp')!
  const info = root.querySelector<HTMLElement>('#info')!

  let lastHp = -1
  let lastInfo = ''
  return {
    update(view: RenderView): void {
      const self = view.self
      if (!self) return
      const hp = self.health ? Math.max(0, self.health.hp) / self.health.max : 0
      if (hp !== lastHp) {
        lastHp = hp
        hpBar.style.width = `${hp * 100}%`
        hpBar.style.background = hp > 0.35 ? 'linear-gradient(#7fd17f,#4a9a4a)' : 'linear-gradient(#d17f7f,#9a4a4a)'
      }
      const weapon = WEAPONS[self.combat?.weapon ?? 'fists']?.name ?? '—'
      const cash = self.playerCtl?.cash ?? 0
      const bandages = self.playerCtl?.inventory.reduce((n, s) => n + s.qty, 0) ?? 0
      const text = `${weapon} · $${cash}${bandages > 0 ? ` · ${bandages}🩹` : ''}`
      if (text !== lastInfo) {
        lastInfo = text
        info.textContent = text
      }
    },
  }
}
