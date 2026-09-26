// The floor-draft screen (#84): "pick 1 of 3" between floors. Pure DOM, drawn
// from sim state every frame. The hand and each player's cursor live on
// `playerCtl.draft`, steered by the player's own InputCmd (stick = move, A or
// interact = take), so pads, keyboard and remote peers all go through the sim.
// A tap or click on a card calls `onPick(index)`, which queues a `draftPick`
// input for the local player; this screen never edits a loadout.

import { draftCards, type DraftCard } from '../game/systems/draft'
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

export interface DraftScreen {
  /** Show `offer` with each seat's cursor, or hide when `offer` is null. */
  update(offer: readonly string[] | null, seats: readonly DraftSeat[], secondsLeft: number): void
  readonly visible: boolean
}

export const createDraftScreen = (mount: HTMLElement, onPick: (index: number) => void): DraftScreen => {
  const root = document.createElement('div')
  root.className = 'draft-screen'
  root.dataset.role = 'draft-screen'
  markUiChrome(root) // press-exempt UI chrome (chrome.ts)
  root.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:rgba(6,8,14,.82);z-index:60;backdrop-filter:blur(2px);overflow-y:auto'
  mount.appendChild(root)

  let shownKey = ''
  let cardEls: HTMLButtonElement[] = []
  let chipRows: HTMLDivElement[] = []
  let timer: HTMLDivElement | null = null

  const build = (offer: readonly string[]): void => {
    root.replaceChildren()
    const panel = document.createElement('div')
    panel.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;padding:20px 16px'

    const title = document.createElement('div')
    title.textContent = 'FLOOR CLEARED — take one mod for your gun'
    title.style.cssText = 'font:800 22px system-ui;color:#ffd75e;text-shadow:0 2px 6px #000;text-align:center'
    panel.appendChild(title)

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;justify-content:center'
    cardEls = []
    chipRows = []
    draftCards(offer).forEach((c, i) => {
      const card = document.createElement('button')
      card.className = 'draft-card'
      card.dataset.modId = c.id
      card.dataset.index = String(i)
      card.style.cssText =
        `width:190px;min-height:240px;border-radius:14px;border:2px solid ${RARITY_COLOR[c.rarity]};` +
        'background:linear-gradient(#1a1f2e,#0c0f18);color:#eee;display:flex;flex-direction:column;' +
        'align-items:center;gap:12px;padding:18px 14px;cursor:pointer;box-shadow:0 6px 20px #000a;' +
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
      blurb.textContent = c.blurb
      blurb.style.cssText = 'font:13px/1.4 system-ui;text-align:center;opacity:.88'

      const rar = document.createElement('div')
      rar.textContent = c.rarity.toUpperCase()
      rar.style.cssText = `margin-top:auto;font:700 11px system-ui;letter-spacing:1.5px;color:${RARITY_COLOR[c.rarity]}`

      card.append(chips, icon, name, blurb, rar)
      card.onclick = () => onPick(i)
      row.appendChild(card)
      cardEls.push(card)
      chipRows.push(chips)
    })
    panel.appendChild(row)

    const hint = document.createElement('div')
    hint.textContent = '◀ ▶ choose  ·  A / fire / E takes it  ·  or tap a card'
    hint.style.cssText = 'font:600 14px system-ui;color:#cfd6e4;opacity:.85;text-align:center'
    timer = document.createElement('div')
    timer.style.cssText = 'font:600 13px system-ui;color:#8a93a6'
    panel.append(hint, timer)
    root.appendChild(panel)
  }

  const screen: DraftScreen = {
    get visible() {
      return shownKey !== ''
    },
    update(offer, seats, secondsLeft) {
      if (!offer || offer.length === 0 || seats.length === 0) {
        if (shownKey) {
          root.style.display = 'none'
          root.replaceChildren()
          shownKey = ''
        }
        return
      }
      const key = offer.join(',')
      if (key !== shownKey) {
        build(offer)
        shownKey = key
        root.style.display = 'flex'
      }
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
