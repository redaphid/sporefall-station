// The LOADOUT panel — a slick, readable card that renders the loadoutModel view
// model on the pause and death screens. All DOM (layer boundary: `src/ui/`); it
// paints a pure `LoadoutModel` (loadoutModel.ts) and holds no sim state.
//
// Visual language matches the game's overlays (dark translucent card, system-ui,
// gold/green accents) but leans into the mod palette: each applied mod is a chip
// tinted with its signature gem colour (modPickupColor), stats read as base →
// resolved rows with an up/down arrow when a mod moves them, and resolved
// bullet-behaviour badges (pierce/explosive/element…) sit below. Responsive:
// fixed max-width, its own vertical scroll so it never overflows a portrait body.

import type { LoadoutModel, LoadoutStat } from './loadoutModel'
import { markUiChrome } from './chrome'

export interface LoadoutPanel {
  el: HTMLElement
  /** Repaint for the current loadout, or show the empty state for `null`. */
  update(model: LoadoutModel | null): void
}

/** Optional weapon-art thumbnail provider (renderer.weaponThumb) → data URL. */
export type WeaponThumb = (weaponId: string) => string | undefined

const ACCENT = '#7fd17f'
const GOLD = '#ffd76a'

const arrow = (dir: -1 | 0 | 1): string => (dir > 0 ? '▲' : dir < 0 ? '▼' : '')
const arrowColor = (dir: -1 | 0 | 1): string => (dir > 0 ? ACCENT : dir < 0 ? '#e0704f' : '#8b8b96')

/** One "Damage  14 → 35 ▲" stat row. */
const statRow = (s: LoadoutStat): string => {
  const changed = s.changed
  const val = changed
    ? `<span style="color:#9aa0b0">${s.baseText}</span>
       <span style="color:#6b6b76;margin:0 3px">→</span>
       <span style="color:${arrowColor(s.direction)};font-weight:800">${s.resolvedText}</span>
       <span style="color:${arrowColor(s.direction)};font-size:10px;margin-left:2px">${arrow(s.direction)}</span>`
    : `<span style="color:#e7e7ee;font-weight:700">${s.resolvedText}</span>`
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;
      padding:5px 9px;border-radius:7px;background:${changed ? '#ffffff10' : '#ffffff06'}">
      <span style="color:#aeb2be;font-size:12px">${s.label}</span>
      <span style="font-size:13px;text-align:right">${val}</span>
    </div>`
}

// An inert chip is greyed and struck through; a downside-only one keeps its
// colour but carries a red reason. Either way the reason is on the chip itself,
// not in a hover title a gamepad player can never see.
const modChip = (m: LoadoutModel['mods'][number]): string => {
  const v = m.verdict
  const inert = v.kind === 'inert'
  const color = inert ? '#6b6b76' : m.color
  return `<div data-mod-id="${m.id}" data-verdict="${v.kind}" title="${escapeAttr(m.desc)}" style="display:inline-flex;align-items:center;gap:5px;
      padding:4px 9px 4px 7px;border-radius:999px;font-size:12px;font-weight:700;color:${inert ? '#9a9aa6' : '#fff'};
      background:linear-gradient(180deg, ${color}33, ${color}18);
      border:1px ${inert ? 'dashed' : 'solid'} ${v.kind === 'penalty' ? '#e0704f' : color};
      box-shadow:${inert ? 'none' : `0 0 10px ${color}55, inset 0 0 6px ${color}22`}">
      <span style="display:inline-block;width:11px;height:11px;border-radius:3px;transform:rotate(45deg);
        background:${color};box-shadow:${inert ? 'none' : `0 0 6px ${color}`}"></span>
      <span style="${inert ? 'text-decoration:line-through' : ''}">${m.icon} ${escapeHtml(m.name)}</span>
      ${m.stacks > 1 ? `<span style="font-size:11px;color:${color};background:#0006;border-radius:6px;padding:0 5px;font-weight:800">×${m.stacks}</span>` : ''}
      ${v.kind !== 'live' ? `<span class="mod-verdict" style="font-size:10px;font-weight:600;color:${inert ? '#b0b0bc' : '#ff9a7a'}">${escapeHtml(v.reason)}</span>` : ''}
    </div>`
}

/** A trait row: what it does, in the card's own words, so a pad player reads it without a tooltip. */
const traitRow = (t: LoadoutModel['traits'][number]): string => {
  const inert = t.verdict.kind !== 'live'
  return `<div data-trait-id="${t.id}" data-verdict="${t.verdict.kind}" style="display:flex;align-items:center;gap:8px;
      padding:5px 9px;border-radius:9px;background:${inert ? '#ffffff06' : '#6ff0b014'};
      border:1px ${inert ? 'dashed #6b6b76' : 'solid #6ff0b055'}">
      <span style="font-size:18px;line-height:1">${t.icon}</span>
      <span style="min-width:0">
        <span style="font-weight:800;color:${inert ? '#9a9aa6' : '#bff7d9'}">${escapeHtml(t.name)}${t.stacks > 1 ? ` ×${t.stacks}` : ''}</span>
        <span style="display:block;font-size:11px;color:#aeb2be">${escapeHtml(t.desc)}</span>
        ${t.verdict.kind !== 'live' ? `<span class="trait-verdict" style="display:block;font-size:10px;font-weight:700;color:#b0b0bc;text-transform:uppercase">${escapeHtml(t.verdict.reason)}</span>` : ''}
      </span>
    </div>`
}

const behaviorBadge = (b: LoadoutModel['behaviors'][number]): string =>
  `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;
      font-size:11px;font-weight:700;color:#e7e7ee;background:#ffffff12;border:1px solid #ffffff1f">
      ${b.icon} ${escapeHtml(b.label)}</span>`

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const escapeAttr = (s: string): string => escapeHtml(s)

/**
 * Build a loadout panel element. `update(model)` re-renders it; pass `null` to
 * show a gentle empty state (no weapon). `weaponThumb` (optional) supplies the
 * procedural weapon art as a data URL — omitted → a glyph stands in.
 */
export const createLoadoutPanel = (weaponThumb?: WeaponThumb): LoadoutPanel => {
  const el = document.createElement('div')
  markUiChrome(el)
  el.style.cssText =
    'width:min(340px,86vw);max-height:52vh;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;' +
    'background:linear-gradient(180deg,#141822f2,#0c0f16f2);border:1px solid #ffffff1f;border-radius:14px;' +
    'padding:14px 14px 16px;color:#e7e7ee;font:13px system-ui;text-align:left;' +
    'box-shadow:0 12px 40px #000a, inset 0 1px 0 #ffffff14;-webkit-overflow-scrolling:touch'

  const update = (model: LoadoutModel | null): void => {
    if (!model) {
      el.innerHTML = `<div style="text-align:center;color:#8b8b96;padding:18px 6px">No weapon equipped</div>`
      return
    }
    const thumb = weaponThumb?.(model.weaponId)
    const visual = thumb
      ? `<img src="${thumb}" alt="" style="width:44px;height:44px;image-rendering:pixelated;object-fit:contain;
           filter:drop-shadow(0 2px 4px #000b)">`
      : `<div style="font-size:30px;line-height:1">${model.glyph}</div>`

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:52px;height:52px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
            border-radius:11px;background:radial-gradient(circle at 50% 40%, #2a3040, #10131b);
            border:1px solid #ffffff1f">${visual}</div>
        <div style="min-width:0">
          <div style="font:800 18px system-ui;color:${GOLD};letter-spacing:.3px;line-height:1.1">${escapeHtml(model.name)}</div>
          <div style="font-size:11px;color:#8b8b96;text-transform:uppercase;letter-spacing:1px;margin-top:2px">
            ${model.unarmed ? 'Innate' : model.kind} weapon
          </div>
        </div>
      </div>

      ${model.mods.length > 0
        ? `<div style="margin-bottom:12px">
             <div style="font-size:10px;letter-spacing:1.5px;color:#7a7f8c;text-transform:uppercase;margin-bottom:6px">Mods</div>
             <div style="display:flex;flex-wrap:wrap;gap:6px">${model.mods.map(modChip).join('')}</div>
           </div>`
        : model.unarmed
          ? ''
          : `<div style="margin-bottom:12px;font-size:12px;color:#7a7f8c;font-style:italic">No mods installed — clean build.</div>`}

      ${model.traits.length > 0
        ? `<div style="margin-bottom:12px">
             <div style="font-size:10px;letter-spacing:1.5px;color:#7a7f8c;text-transform:uppercase;margin-bottom:6px">You</div>
             <div style="display:flex;flex-direction:column;gap:4px">${model.traits.map(traitRow).join('')}</div>
           </div>`
        : ''}

      <div style="font-size:10px;letter-spacing:1.5px;color:#7a7f8c;text-transform:uppercase;margin-bottom:6px">Stats${model.statsScope === 'next shot' ? ' · next shot' : ''}</div>
      <div style="display:flex;flex-direction:column;gap:4px">${model.stats.map(statRow).join('')}</div>

      ${model.behaviors.length > 0
        ? `<div style="margin-top:12px">
             <div style="font-size:10px;letter-spacing:1.5px;color:#7a7f8c;text-transform:uppercase;margin-bottom:6px">Effects</div>
             <div style="display:flex;flex-wrap:wrap;gap:5px">${model.behaviors.map(behaviorBadge).join('')}</div>
           </div>`
        : ''}
    `
  }

  update(null)
  return { el, update }
}
