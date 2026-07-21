import { SPECIAL_NAME } from '../game/player'
import { CONSUMABLES, WEAPONS } from '../game/data/items'
import type { RenderView } from '../app/session'
import { hotbarSlots } from './hotbarModel'

export interface Hud {
  update(view: RenderView): void
}

export const createHud = (mount: HTMLElement): Hud => {
  const root = document.createElement('div')
  // Offset by the notch/status-bar inset so the health bar clears the OS clock on
  // notched/foldable phones (Razr Ultra). env() needs viewport-fit=cover, set in index.html.
  root.style.cssText =
    'position:absolute;left:12px;top:calc(env(safe-area-inset-top, 0px) + 10px);color:#eee;font:14px system-ui;text-shadow:0 1px 2px #000;pointer-events:none;'
  root.innerHTML = `
    <div style="width:160px;height:14px;background:#3338;border:1px solid #000;border-radius:3px;overflow:hidden">
      <div id="hp" style="width:100%;height:100%;background:linear-gradient(#7fd17f,#4a9a4a);transition:width .15s"></div>
    </div>
    <div id="info" style="margin-top:4px;opacity:.9"></div>
    <div id="hotbar" style="display:flex;gap:4px;margin-top:6px"></div>
  `
  mount.appendChild(root)
  const hpBar = root.querySelector<HTMLElement>('#hp')!
  const info = root.querySelector<HTMLElement>('#info')!
  const hotbar = root.querySelector<HTMLElement>('#hotbar')!

  let lastHp = -1
  let lastInfo = ''
  let lastHotbar = ''
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
      const bandages = self.loadout?.inventory.filter((s) => CONSUMABLES[s.itemId]).reduce((n, s) => n + s.qty, 0) ?? 0
      const cd = self.playerCtl?.abilityCooldown ?? 0
      const ability = self.playerCtl ? ` · ${SPECIAL_NAME}${cd > 0 ? ` ${Math.ceil(cd / 30)}s` : ' ✓'}` : ''
      const briefcase = self.loadout?.inventory.some((s) => s.itemId === 'briefcase') ? ' · 🧪' : ''
      const text = `${weapon} · $${cash}${bandages > 0 ? ` · ${bandages}🩹` : ''}${ability}${briefcase}`
      if (text !== lastInfo) {
        lastInfo = text
        info.textContent = text
      }

      const inv = self.loadout?.inventory ?? []
      const active = self.loadout?.activeSlot ?? -1
      const slots = hotbarSlots(inv, active)
      const key = slots.map((s) => `${s.index}:${s.itemId}·${s.qty}${s.active ? '*' : ''}·${s.mods}`).join(',')
      if (key !== lastHotbar) {
        lastHotbar = key
        hotbar.innerHTML = slots
          .map((s) => {
            // Same quiet-chrome treatment as the touch hotbar: dark pill,
            // gold accent for the active slot — never a solid gold slab.
            const bg = s.active ? '#151009c0' : '#00000073'
            const col = s.active ? '#e8c96a' : '#c9c9c9'
            const border = s.active ? '#d4af3799' : '#ffffff1f'
            const badge = s.mods ? `<div style="font-size:10px;line-height:1.1;margin-top:1px">${s.mods}</div>` : ''
            return `<div style="padding:2px 7px;background:${bg};color:${col};border:1px solid ${border};border-radius:4px;font-size:11px">${s.label} <b>${s.qty}</b>${badge}</div>`
          })
          .join('')
      }
    },
  }
}
