// The floor-draft screen (#84): "pick 1 of 3" between floors. Pure DOM, drawn
// from sim state every frame. The hand and each player's cursor live on
// `playerCtl.draft`, steered by the player's own InputCmd (stick = move, A or
// interact = take), so pads, keyboard and remote peers all go through the sim.
// A tap or click on a card calls `onPick(index)`, which queues a `draftPick`
// input for the local player; this screen never edits a loadout.
//
// Two layouts. While every local player is choosing, nobody at this screen is
// in the fight, so the hand takes the whole screen. Once any local player is
// back in play (a couch partner picked first), the hand shrinks to an
// undimmed strip along the bottom edge that lets clicks through to the world,
// so the player who picked can see the fight they were returned to.

import { draftCards, type DraftCard, type DraftLoadout } from '../game/systems/draft'
import type { Entity } from '../game/entity'
import { markUiChrome } from './chrome'

const RARITY_COLOR: Record<DraftCard['rarity'], string> = {
  common: '#9aa4b2',
  rare: '#5aa9ff',
  legendary: '#ffb347',
}

/** Seat colours for local players 1-4, so two pads on one couch can tell their cursors apart. */
const SEAT_COLOR = ['#ffd75e', '#5ee0ff', '#ff7ad9', '#7dff8a']

/** One local player still choosing: whose cursor sits on which card. */
export interface DraftSeat {
  playerId: number
  cursor: number
}

/** What the local screen should draw for the floor draft this frame. */
export interface LocalDraft {
  offer: readonly string[] | null
  seats: DraftSeat[]
  /** Latest deadline tick among the seats. */
  until: number
  /** A live local player without an open hand is back in the fight and must see it. */
  inPlay: boolean
}

/**
 * Collect the local players still holding a hand. `answeredUntil` hides the
 * `self` seat after a tap, until a hand with a different deadline arrives
 * (a net client hears its hand closed only on the next state message).
 */
export const localDraft = (
  entities: readonly Entity[],
  localIds: ReadonlySet<number>,
  self: Entity | undefined,
  answeredUntil: number,
): LocalDraft => {
  const out: LocalDraft = { offer: null, seats: [], until: 0, inPlay: false }
  for (const e of entities) {
    const ctl = e.playerCtl
    if (!ctl || e.dead || !localIds.has(ctl.playerId)) continue
    const hand = ctl.draft
    if (!hand || (e === self && hand.until === answeredUntil)) {
      out.inPlay = true
      continue
    }
    out.offer ??= hand.offer
    out.until = Math.max(out.until, hand.until)
    out.seats.push({ playerId: ctl.playerId, cursor: hand.cursor })
  }
  return out
}

export type DraftLayout = 'full' | 'strip'

export interface DraftScreen {
  /** Show `offer` with each seat's cursor, or hide when `offer` is null. `loadout`
   * (the local player's gun) marks cards that would do nothing on it. */
  update(
    offer: readonly string[] | null,
    seats: readonly DraftSeat[],
    secondsLeft: number,
    layout?: DraftLayout,
    loadout?: DraftLoadout,
  ): void
  readonly visible: boolean
  readonly layout: DraftLayout
}

const ROOT_STYLE: Record<DraftLayout, string> = {
  full:
    'position:absolute;inset:0;align-items:center;justify-content:center;' +
    'background:rgba(6,8,14,.82);z-index:60;backdrop-filter:blur(2px);overflow-y:auto;pointer-events:auto',
  // Bottom edge only, no dim or blur, and clicks pass through except on cards.
  strip:
    'position:absolute;left:0;right:0;bottom:0;top:auto;align-items:flex-end;justify-content:center;' +
    'background:none;z-index:60;backdrop-filter:none;overflow:visible;pointer-events:none',
}

export const createDraftScreen = (mount: HTMLElement, onPick: (index: number) => void): DraftScreen => {
  const root = document.createElement('div')
  root.className = 'draft-screen'
  root.dataset.role = 'draft-screen'
  markUiChrome(root) // press-exempt UI chrome (chrome.ts)
  root.style.cssText = ROOT_STYLE.full + ';display:none'
  mount.appendChild(root)

  let shownKey = ''
  let layout: DraftLayout = 'full'
  let panelEl: HTMLDivElement | null = null
  let titleEl: HTMLDivElement | null = null
  let hintEl: HTMLDivElement | null = null
  let cardEls: HTMLButtonElement[] = []
  let chipRows: HTMLDivElement[] = []
  let timer: HTMLDivElement | null = null

  const build = (cards: readonly DraftCard[]): void => {
    root.replaceChildren()
    const panel = document.createElement('div')
    panelEl = panel

    const title = document.createElement('div')
    titleEl = title
    title.textContent = 'FLOOR CLEARED — take one mod for your gun'
    title.style.cssText = 'font:800 22px system-ui;color:#ffd75e;text-shadow:0 2px 6px #000;text-align:center'
    panel.appendChild(title)

    const row = document.createElement('div')
    row.className = 'draft-row'
    cardEls = []
    chipRows = []
    cards.forEach((c, i) => {
      const card = document.createElement('button')
      card.className = 'draft-card'
      card.dataset.modId = c.id
      card.dataset.index = String(i)
      card.style.cssText =
        `border-radius:14px;border:2px solid ${RARITY_COLOR[c.rarity]};` +
        'background:linear-gradient(#1a1f2e,#0c0f18);color:#eee;display:flex;flex-direction:column;' +
        'align-items:center;cursor:pointer;box-shadow:0 6px 20px #000a;pointer-events:auto;' +
        'touch-action:manipulation;transition:transform .08s'

      const chips = document.createElement('div')
      chips.style.cssText = 'display:flex;gap:6px;min-height:22px'

      const icon = document.createElement('div')
      icon.textContent = c.icon
      icon.style.cssText = 'font-size:56px;line-height:1'

      const name = document.createElement('div')
      name.textContent = c.name
      name.style.cssText = `font:800 19px system-ui;color:${RARITY_COLOR[c.rarity]}`

      const blurb = document.createElement('div')
      blurb.className = 'draft-blurb'
      blurb.textContent = c.blurb
      blurb.style.cssText = 'font:13px/1.4 system-ui;text-align:center;opacity:.88'

      const rar = document.createElement('div')
      rar.textContent = c.rarity.toUpperCase()
      rar.style.cssText = `margin-top:auto;font:700 11px system-ui;letter-spacing:1.5px;color:${RARITY_COLOR[c.rarity]}`

      card.append(chips, icon, name, blurb)
      // The blurb says what the mod is for; this says what it would do on YOUR
      // weapon, so a dead pick is visible before you take it.
      if (c.verdict && c.verdict.kind !== 'live') {
        const inert = c.verdict.kind === 'inert'
        const verdict = document.createElement('div')
        verdict.className = 'draft-verdict'
        verdict.textContent = c.verdict.reason.toUpperCase()
        verdict.style.cssText =
          `font:800 11px system-ui;letter-spacing:1px;padding:3px 8px;border-radius:6px;` +
          `color:${inert ? '#c8c8d2' : '#ffb39e'};background:${inert ? '#ffffff14' : '#e0704f33'}`
        card.appendChild(verdict)
        if (inert) card.dataset.inert = '1'
      }
      card.appendChild(rar)
      card.onclick = () => onPick(i)
      row.appendChild(card)
      cardEls.push(card)
      chipRows.push(chips)
    })
    panel.appendChild(row)

    const hint = document.createElement('div')
    hintEl = hint
    hint.textContent = '◀ ▶ choose  ·  A / fire / E takes it  ·  or tap a card'
    hint.style.cssText = 'font:600 14px system-ui;color:#cfd6e4;opacity:.85;text-align:center'
    timer = document.createElement('div')
    timer.style.cssText = 'font:600 13px system-ui;color:#8a93a6'
    panel.append(hint, timer)
    root.appendChild(panel)
  }

  /** Size the built hand for `next`. The strip keeps cards tappable but small. */
  const applyLayout = (next: DraftLayout): void => {
    layout = next
    const strip = next === 'strip'
    root.style.cssText = ROOT_STYLE[next] + ';display:flex'
    if (panelEl)
      panelEl.style.cssText =
        'display:flex;flex-direction:column;align-items:center;' + (strip ? 'gap:6px;padding:6px 8px' : 'gap:14px;padding:20px 16px')
    if (titleEl) titleEl.style.display = strip ? 'none' : ''
    if (hintEl) hintEl.style.display = strip ? 'none' : ''
    const row = root.querySelector<HTMLDivElement>('.draft-row')
    if (row) row.style.cssText = `display:flex;gap:${strip ? 8 : 18}px;flex-wrap:${strip ? 'nowrap' : 'wrap'};justify-content:center`
    for (const card of cardEls) {
      card.style.width = strip ? '112px' : '190px'
      card.style.minHeight = strip ? '0' : '240px'
      card.style.gap = strip ? '4px' : '12px'
      card.style.padding = strip ? '6px 6px' : '18px 14px'
      card.style.opacity = card.dataset.inert ? '0.6' : strip ? '0.92' : '1'
      const icon = card.children[1] as HTMLElement | undefined
      if (icon) icon.style.fontSize = strip ? '28px' : '56px'
      const blurb = card.querySelector<HTMLElement>('.draft-blurb')
      if (blurb) blurb.style.display = strip ? 'none' : ''
    }
  }

  const screen: DraftScreen = {
    get visible() {
      return shownKey !== ''
    },
    get layout() {
      return layout
    },
    update(offer, seats, secondsLeft, next = 'full', loadout) {
      if (!offer || offer.length === 0 || seats.length === 0) {
        if (shownKey) {
          root.style.display = 'none'
          root.replaceChildren()
          shownKey = ''
        }
        return
      }
      const cards = draftCards(offer, loadout)
      const key = cards.map((c) => `${c.id}:${c.verdict?.kind ?? 'live'}`).join(',')
      if (key !== shownKey) {
        build(cards)
        shownKey = key
        applyLayout(next)
      } else if (next !== layout) applyLayout(next)
      cardEls.forEach((card, i) => {
        const here = seats.filter((s) => s.cursor === i)
        const lead = here[0]
        card.style.outline = lead ? `3px solid ${SEAT_COLOR[lead.playerId % SEAT_COLOR.length]}` : 'none'
        card.style.outlineOffset = '3px'
        card.style.transform = lead ? 'translateY(-6px)' : 'none'
        const chips = chipRows[i]
        const want = here.map((s) => `P${s.playerId + 1}`).join(',')
        if (chips.dataset.seats === want) return
        chips.dataset.seats = want
        chips.replaceChildren(
          ...here.map((s) => {
            const chip = document.createElement('span')
            chip.textContent = `P${s.playerId + 1}`
            chip.style.cssText =
              `font:800 12px system-ui;padding:2px 7px;border-radius:9px;color:#111;` +
              `background:${SEAT_COLOR[s.playerId % SEAT_COLOR.length]}`
            return chip
          }),
        )
      })
      if (timer) timer.textContent = `auto-takes the highlighted card in ${Math.max(0, secondsLeft)}s`
    },
  }
  return screen
}
