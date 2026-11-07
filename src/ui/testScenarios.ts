// The start menu's "Test scenarios" page: one card per playable scenario
// (src/playable), grouped by section, each with its action screenshot, title,
// subtitle, what it tests and what to look for, and a Play button that boots it
// at `./?play=<id>`. Opens over the start menu; Back (or a pad's B) closes it.
//
// Phone first: the stage may be a rotated landscape box (orientation.ts), so the
// layout keys off a container query on the overlay, never the viewport.

import { PLAYABLES } from '../playable/registry'
import { playHref, SECTIONS, shotPath, type Playable, type Section } from '../playable/types'
import { markUiChrome } from './chrome'
import { installGamepadMenuNav, type MenuNavControl } from './gamepadMenu'

/** `<base>#test-scenarios` opens the start menu with this page already up:
 * Main menu from inside a scenario lands here. */
export const TEST_SCENARIOS_HASH = '#test-scenarios'

const CSS = `
.sf-ts{position:absolute;inset:0;z-index:5;container-type:size;overflow-x:hidden;overflow-y:auto;
  overscroll-behavior:contain;touch-action:pan-y;pointer-events:auto;background:#0b0b12;color:#eee;font:16px/1.35 system-ui}
.sf-ts__inner{box-sizing:border-box;max-width:820px;margin:0 auto;
  padding:max(10px,var(--sf-safe-top,0px)) max(12px,var(--sf-safe-right,0px))
    max(16px,var(--sf-safe-bottom,0px)) max(12px,var(--sf-safe-left,0px))}
.sf-ts__bar{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:6px 0 8px;background:#0b0b12}
.sf-ts__title{font:800 20px system-ui;margin:0;flex:1 1 auto}
.sf-ts__btn{box-sizing:border-box;min-height:44px;min-width:44px;padding:8px 14px;border-radius:10px;cursor:pointer;
  border:2px solid #ffffff2e;background:#ffffff10;color:#eee;font:600 15px system-ui;touch-action:manipulation}
.sf-ts__jump{display:flex;gap:6px;flex-wrap:wrap}
.sf-ts__chip{min-height:36px;padding:4px 10px;font-size:13px}
.sf-ts__lede{margin:0 0 6px;color:#ffffff99;font-size:13px}
.sf-ts__section{font:800 13px system-ui;letter-spacing:2px;text-transform:uppercase;color:#7fd17f;margin:14px 0 8px}
.sf-ts__list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.sf-ts__card{display:grid;grid-template-columns:minmax(0,46%) minmax(0,1fr);gap:10px;align-items:start;
  padding:8px;border-radius:10px;border:2px solid #ffffff22;background:#ffffff0c}
.sf-ts__shot{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:#1b1f2a;
  image-rendering:pixelated}
.sf-ts__name{font:700 17px/1.2 system-ui;margin:0}
.sf-ts__sub{margin:2px 0 6px;color:#ffd76a;font-size:14px}
.sf-ts__p{margin:0 0 4px;font-size:13px;color:#ffffffc8}
.sf-ts__p b{color:#fff;font-weight:600}
.sf-ts__tags{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;padding:0;list-style:none}
.sf-ts__tag{font:600 11px system-ui;padding:2px 7px;border-radius:999px;background:#ffffff14;color:#ffffffb0}
.sf-ts__play{border-color:#7fd17f;background:#7fd17f22;color:#c9f5c9;font-weight:800;letter-spacing:1px;width:100%}
@container (max-width:520px){
  .sf-ts__card{grid-template-columns:minmax(0,1fr)}
}
`

const STYLE_ID = 'sf-test-scenarios-style'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const para = (label: string, text: string): HTMLParagraphElement => {
  const p = el('p', 'sf-ts__p')
  p.append(el('b', '', `${label} `), document.createTextNode(text))
  return p
}

export interface TestScenariosPage {
  readonly el: HTMLElement
  /** The Play buttons, in list order. */
  readonly plays: readonly HTMLButtonElement[]
  close(): void
}

/**
 * Open the list over `mount`. `go(href)` navigates to a scenario (injectable for
 * tests; defaults to `location.assign`). `onClose` runs once when Back closes it.
 */
export const openTestScenarios = (
  mount: HTMLElement,
  opts: { onClose?: () => void; go?: (href: string) => void; entries?: readonly Playable[] } = {},
): TestScenariosPage => {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  const go = opts.go ?? ((href: string) => location.assign(href))
  const entries = opts.entries ?? PLAYABLES
  const overlay = el('div', 'sf-ts')
  markUiChrome(overlay)
  overlay.dataset.role = 'test-scenarios'
  const inner = el('div', 'sf-ts__inner')
  overlay.append(inner)

  const bar = el('div', 'sf-ts__bar')
  const back = el('button', 'sf-ts__btn', '‹ Menu')
  back.dataset.role = 'test-scenarios-back'
  bar.append(back, el('h1', 'sf-ts__title', 'Test scenarios'))
  const jump = el('div', 'sf-ts__jump')
  bar.append(jump)
  inner.append(bar, el('p', 'sf-ts__lede', 'Drop straight into a moment worth testing. Your own run is not touched.'))

  const plays: HTMLButtonElement[] = []
  const chips: HTMLButtonElement[] = []
  for (const section of Object.keys(SECTIONS) as Section[]) {
    const items = entries.filter((p) => p.section === section)
    if (items.length === 0) continue
    const heading = el('h2', 'sf-ts__section', `${SECTIONS[section]} (${items.length})`)
    heading.id = `sf-ts-${section}`
    const chip = el('button', 'sf-ts__btn sf-ts__chip', SECTIONS[section])
    chip.addEventListener('click', () => heading.scrollIntoView({ block: 'start' }))
    chips.push(chip)
    jump.append(chip)
    const list = el('ul', 'sf-ts__list')
    for (const p of items) {
      const li = el('li', 'sf-ts__card')
      li.dataset.playable = p.id
      const img = el('img', 'sf-ts__shot')
      img.src = shotPath(p.id)
      img.alt = `${p.title}: ${p.subtitle}`
      img.loading = 'lazy'
      img.decoding = 'async'
      const text = el('div', '')
      const tags = el('ul', 'sf-ts__tags')
      for (const t of p.tags) tags.append(el('li', 'sf-ts__tag', t))
      const playBtn = el('button', 'sf-ts__btn sf-ts__play', 'PLAY ▶')
      playBtn.dataset.role = 'play'
      playBtn.dataset.playable = p.id
      playBtn.addEventListener('click', () => go(playHref(p.id)))
      plays.push(playBtn)
      text.append(
        el('h3', 'sf-ts__name', p.title),
        el('p', 'sf-ts__sub', p.subtitle),
        para('Tests:', p.tests),
        para('Look for:', p.lookFor),
        tags,
        playBtn,
      )
      li.append(img, text)
      list.append(li)
    }
    inner.append(heading, list)
  }

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    stopNav()
    overlay.remove()
    opts.onClose?.()
  }
  back.addEventListener('click', close)
  // Controller: Back + the section chips on the first row, then one Play per row.
  const layout = (): MenuNavControl[][] => [[back, ...chips], ...plays.map((b) => [b])]
  const stopNav = installGamepadMenuNav(layout, {
    confirmButtons: [0, 2, 3, 9], // B is Back here, never confirm
    back: { buttons: [1], run: close },
  })
  mount.appendChild(overlay)
  return { el: overlay, plays, close }
}
