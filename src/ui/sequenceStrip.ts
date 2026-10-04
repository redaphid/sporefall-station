// The mod sequence strip: the wielded weapon's mod order as a row of chips,
// the next cast outlined, stowed mods dimmed after a divider, and a recharge
// bar when the sequence has wrapped. Tap one chip, then another, to swap them
// (works with a mouse too). DOM only; paints a SequenceModel (sequenceModel.ts)
// and owns no sim state. The swap itself goes out as a player input.

import { markUiChrome } from './chrome'
import { installGamepadMenuNav, type GamepadMenuNavOptions } from './gamepadMenu'
import type { SequenceModel } from './sequenceModel'

export interface SequenceStrip {
  el: HTMLElement
  update(model: SequenceModel | null): void
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A stable key for a model, so the DOM is only rebuilt when something visible changed. */
const keyOf = (m: SequenceModel | null, picked: number): string =>
  m
    ? `${m.weaponName}|${m.rechargeLeft}|${picked}|` +
      m.entries.map((e) => `${e.id}:${e.stacks}:${e.live ? 1 : 0}${e.next ? 1 : 0}:${e.verdict ?? ''}`).join(',')
    : ''

export const createSequenceStrip = (onSwap: (a: number, b: number) => void, opts: { compact?: boolean } = {}): SequenceStrip => {
  const el = document.createElement('div')
  markUiChrome(el)
  el.dataset.role = 'mod-sequence'
  el.style.cssText = 'pointer-events:auto;user-select:none;-webkit-user-select:none;touch-action:manipulation;margin-top:6px'
  let model: SequenceModel | null = null
  let picked = -1
  let lastKey = '-'

  const paint = (): void => {
    const key = keyOf(model, picked)
    if (key === lastKey) return
    lastKey = key
    if (!model) {
      el.style.display = 'none'
      el.innerHTML = ''
      return
    }
    el.style.display = 'block'
    const size = opts.compact ? 24 : 32
    const recharging = model.rechargeLeft > 0
    const chips = model.entries
      .map((e, n) => {
        const divider =
          n > 0 && model!.entries[n - 1].live && !e.live
            ? `<span style="width:1px;align-self:stretch;background:#ffffff40;margin:0 3px"></span>`
            : ''
        const outline = e.listIndex === picked ? '#ffffff' : e.next && !recharging ? '#ffd76a' : e.payload ? e.color : '#ffffff30'
        const glow = e.next && !recharging ? `box-shadow:0 0 8px #ffd76a;` : ''
        const shape = e.payload ? 'border-radius:50%;' : 'border-radius:6px;'
        return `${divider}<button data-i="${e.listIndex}" title="${esc(e.name)}${e.payload ? ' (element)' : ' (modifier)'}${e.live ? '' : ' (stowed)'}${e.verdict ? ` (${esc(e.verdict)})` : ''}"
          data-verdict="${e.verdict ? esc(e.verdict) : ''}"
          style="all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;
          width:${size}px;height:${size}px;${shape}font-size:${Math.round(size * 0.55)}px;
          background:${e.payload ? `${e.color}40` : '#00000080'};border:2px ${e.verdict ? 'dashed' : 'solid'} ${outline};${glow}
          opacity:${e.live ? (recharging || e.verdict ? 0.45 : 1) : 0.35}">${e.icon}${
            e.verdict ? `<span style="position:absolute;left:-3px;top:-4px;font:800 9px system-ui;color:#fff;background:#b0413e;border-radius:4px;padding:0 2px">✕</span>` : ''
          }${
            e.stacks > 1 ? `<span style="position:absolute;right:-3px;bottom:-4px;font:800 9px system-ui;color:#fff;background:#000c;border-radius:4px;padding:0 2px">${e.stacks}</span>` : ''
          }</button>`
      })
      .join('')
    const pct = recharging && model.rechargeTotal > 0 ? Math.min(1, model.rechargeLeft / model.rechargeTotal) : 0
    const bar = recharging
      ? `<div data-role="mod-recharge" style="height:4px;margin-top:3px;background:#ffffff1a;border-radius:2px;overflow:hidden">
           <div style="height:100%;width:${(1 - pct) * 100}%;background:#e0704f"></div></div>`
      : ''
    const hint = picked >= 0 ? 'tap another to swap' : recharging ? 'recharging' : `next: ${model.entries.filter((e) => e.next).map((e) => e.icon).join('') || 'plain'}`
    el.innerHTML = `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">${chips}</div>${bar}
      <div style="font-size:10px;opacity:.75;margin-top:2px">${esc(hint)}</div>`
  }

  el.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('button[data-i]')
    if (!btn) return
    ev.stopPropagation()
    const i = Number(btn.dataset.i)
    if (picked < 0) picked = i
    else if (picked === i) picked = -1
    else {
      onSwap(picked, i)
      picked = -1
    }
    lastKey = '-'
    paint()
  })

  return {
    el,
    update(next) {
      model = next
      if (!model || picked >= model.entries.length) picked = -1
      paint()
    },
  }
}

/** Controller reordering for a strip: the d-pad or left stick walks the chips
 * and a face button taps the focused one, so two taps swap, exactly as two
 * finger taps do. Start is not a tap here: it resumes the run. Returns the
 * teardown. `hidden` is true while the strip is off screen. */
export const installStripPadNav = (
  strip: SequenceStrip,
  hidden: () => boolean,
  clock: Pick<GamepadMenuNavOptions, 'schedule' | 'cancel'> = {},
): (() => void) =>
  installGamepadMenuNav(() => [...strip.el.querySelectorAll<HTMLButtonElement>('button[data-i]')], {
    ...clock,
    suppress: hidden,
    confirmButtons: [0, 1, 2, 3],
  })
