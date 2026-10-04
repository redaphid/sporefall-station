// Buttons that end a run (New Seed, Run it back, Main menu) act only on a
// second press. The first press arms the button and says so; the second acts.
// A group keeps at most one button armed, and leaving a button disarms it. The
// owner closes a menu with disarmAll(), because a tap never focuses the button
// and so never blurs it.

export interface TwoPressGroup {
  /** Make `b` arm on its first press (showing `armedLabel`) and run `act` on its second. */
  wire(b: HTMLButtonElement, armedLabel: string, act: () => void): void
  disarmAll(): void
}

const ARMED_BACKGROUND = '#5a1f22'
const ARMED_COLOR = '#ffd76a'

export const createTwoPressGroup = (): TwoPressGroup => {
  const disarms: (() => void)[] = []
  const disarmAll = (): void => disarms.forEach((d) => d())
  return {
    disarmAll,
    wire(b, armedLabel, act) {
      const label = b.textContent ?? ''
      const { background, color } = b.style
      const disarm = (): void => {
        delete b.dataset.armed
        b.textContent = label
        b.style.background = background
        b.style.color = color
      }
      disarms.push(disarm)
      b.addEventListener('click', () => {
        if (b.dataset.armed !== undefined) {
          disarm()
          act()
          return
        }
        disarmAll()
        b.dataset.armed = ''
        b.textContent = armedLabel
        b.style.background = ARMED_BACKGROUND
        b.style.color = ARMED_COLOR
      })
      b.addEventListener('blur', disarm)
      // A held Enter autorepeats its keydown, and each one clicks: one hold
      // would arm and then act. Only a fresh keypress may count.
      b.addEventListener('keydown', (e) => {
        if (e.repeat) e.preventDefault()
      })
    },
  }
}

export const MAIN_MENU_LABEL = 'Main menu'
export const MAIN_MENU_ARMED_LABEL = 'Quit to the menu? Press again'
