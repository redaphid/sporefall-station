import { linkChip, type ChipTone, type LinkStatus } from '../app/linkHealth'
import { markUiChrome } from './chrome'

const TONE: Record<ChipTone, string> = { good: '#7fd17f', fair: '#ffd76a', bad: '#ff7a7a' }

/** How often the chip re-reads the session. A quarter second is fast enough to
 * show a stall as it happens and slow enough to cost nothing. */
const REFRESH_MS = 250

/**
 * The online HUD chip: a coloured dot plus the round trip, or the words for a
 * weak or reconnecting link. Sits left of the ☰ and ⚙ buttons. Returns a stop.
 */
export const installLinkChip = (mount: HTMLElement, read: () => LinkStatus): (() => void) => {
  const el = document.createElement('div')
  markUiChrome(el)
  el.dataset.role = 'link-chip'
  el.style.cssText =
    'position:absolute;right:96px;top:14px;z-index:55;display:flex;align-items:center;gap:6px;' +
    'font:600 12px system-ui;color:#e7e7ee;background:#000a;padding:5px 10px;border-radius:9px;pointer-events:none'
  const dot = document.createElement('span')
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%'
  const text = document.createElement('span')
  el.append(dot, text)
  mount.appendChild(el)
  const paint = (): void => {
    const chip = linkChip(read())
    dot.style.background = TONE[chip.tone]
    text.textContent = chip.text
    el.dataset.tone = chip.tone
  }
  paint()
  const timer = setInterval(paint, REFRESH_MS)
  return () => {
    clearInterval(timer)
    el.remove()
  }
}
