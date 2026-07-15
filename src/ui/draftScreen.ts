// The between-floor mod DRAFT screen (#53 P3). A ROUNDS-style "pick 1 of N cards"
// overlay: kid-legible, low-APM, one shared beat. Pure DOM — it takes a list of
// offered mod ids (from the deterministic `floorDraftOffer`) and calls back with
// the chosen id. Presentation only; the sim data (the deterministic offer + the
// applied pick) lives in `game/systems/draft.ts`.

import { draftCards, type DraftCard } from '../game/systems/draft'

const RARITY_COLOR: Record<DraftCard['rarity'], string> = {
  common: '#9aa4b2',
  rare: '#5aa9ff',
  legendary: '#ffb347',
}

export interface DraftScreen {
  /** Show the hand; `onPick(id)` fires when a card is chosen (screen auto-hides). */
  show(offer: readonly string[], onPick: (id: string) => void): void
  hide(): void
  readonly visible: boolean
}

export const createDraftScreen = (mount: HTMLElement): DraftScreen => {
  const root = document.createElement('div')
  root.className = 'draft-screen'
  root.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:rgba(6,8,14,.82);z-index:60;backdrop-filter:blur(2px)'
  mount.appendChild(root)
  let visible = false

  return {
    get visible() {
      return visible
    },
    show(offer, onPick) {
      const cards = draftCards(offer)
      root.replaceChildren()

      const panel = document.createElement('div')
      panel.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px'

      const title = document.createElement('div')
      title.textContent = 'FLOOR CLEARED — pick a mod for your gun'
      title.style.cssText = 'font:800 22px system-ui;color:#ffd75e;text-shadow:0 2px 6px #000'
      panel.appendChild(title)

      const row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;justify-content:center'
      for (const c of cards) {
        const card = document.createElement('button')
        card.className = 'draft-card'
        card.dataset.modId = c.id
        card.style.cssText =
          `width:190px;min-height:240px;border-radius:14px;border:2px solid ${RARITY_COLOR[c.rarity]};` +
          'background:linear-gradient(#1a1f2e,#0c0f18);color:#eee;display:flex;flex-direction:column;' +
          'align-items:center;gap:12px;padding:18px 14px;cursor:pointer;box-shadow:0 6px 20px #000a'

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

        card.append(icon, name, blurb, rar)
        card.onclick = () => {
          this.hide()
          onPick(c.id)
        }
        row.appendChild(card)
      }
      panel.appendChild(row)
      root.appendChild(panel)
      root.style.display = 'flex'
      visible = true
    },
    hide() {
      root.style.display = 'none'
      root.replaceChildren()
      visible = false
    },
  }
}
