import { CLASSES } from '../game/data/classes'
import { CONSUMABLES, THROWABLES, WEAPONS } from '../game/data/items'
import type { RenderView } from '../app/session'

export interface Hud {
  update(view: RenderView): void
}

const itemLabel = (itemId: string): string =>
  WEAPONS[itemId]?.name ?? THROWABLES[itemId]?.name ?? CONSUMABLES[itemId]?.name ?? (itemId === 'ammo' ? 'Ammo' : itemId)

export const createHud = (mount: HTMLElement): Hud => {
  const root = document.createElement('div')
  root.style.cssText =
    'position:absolute;left:12px;top:10px;color:#eee;font:14px system-ui;text-shadow:0 1px 2px #000;pointer-events:none;'
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
      const bandages = self.playerCtl?.inventory.filter((s) => CONSUMABLES[s.itemId]).reduce((n, s) => n + s.qty, 0) ?? 0
      const cls = CLASSES[self.playerCtl?.classId ?? '']
      const cd = self.playerCtl?.abilityCooldown ?? 0
      const ability = cls ? ` · ${cls.abilityName}${cd > 0 ? ` ${Math.ceil(cd / 30)}s` : ' ✓'}` : ''
      const briefcase = self.playerCtl?.inventory.some((s) => s.itemId === 'briefcase') ? ' · 💼' : ''
      const text = `${weapon} · $${cash}${bandages > 0 ? ` · ${bandages}🩹` : ''}${ability}${briefcase}`
      if (text !== lastInfo) {
        lastInfo = text
        info.textContent = text
      }

      const inv = self.playerCtl?.inventory ?? []
      const active = self.playerCtl?.activeSlot ?? -1
      const slots = inv
        .filter((s) => s.itemId !== 'briefcase')
        .map((s) => `${itemLabel(s.itemId)}·${s.qty}`)
      const key = `${active}|${slots.join(',')}`
      if (key !== lastHotbar) {
        lastHotbar = key
        const activeItemId = inv[active]?.itemId
        hotbar.innerHTML = inv
          .filter((s) => s.itemId !== 'briefcase')
          .map((s) => {
            const on = s.itemId === activeItemId
            const bg = on ? '#d4af37cc' : '#222a'
            const col = on ? '#111' : '#eee'
            return `<div style="padding:2px 7px;background:${bg};color:${col};border:1px solid #000;border-radius:4px;font-size:12px">${itemLabel(s.itemId)} <b>${s.qty}</b></div>`
          })
          .join('')
      }
    },
  }
}
