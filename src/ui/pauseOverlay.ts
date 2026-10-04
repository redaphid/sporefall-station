// The pause overlay: PAUSED, the gun+mods loadout, the reorderable wand strip,
// and the Resume / New Seed / Run it back / Refresh / Share state actions.
// DOM only. The session owns pause itself; this paints and dispatches.

import type { RenderView } from '../app/session'
import type { ShareResult } from '../app/stateShare'
import { previewSwaps, type ModSwapQueue } from '../input/modSwapQueue'
import { markUiChrome } from './chrome'
import { createLoadoutPanel, type WeaponThumb } from './loadoutPanel'
import { buildLoadout } from './loadoutModel'
import { buildSequence } from './sequenceModel'
import { installGamepadMenuNav } from './gamepadMenu'
import { createTwoPressGroup, MAIN_MENU_ARMED_LABEL, MAIN_MENU_LABEL } from './twoPress'
import { createSequenceStrip, stripChips } from './sequenceStrip'
import {
  initialShare,
  shareAction,
  shareButtonLabel,
  shareCopyRetried,
  shareFailed,
  shareStarted,
  shareStatusText,
  shareSucceeded,
  shareUrl,
  type ShareState,
} from './shareModel'

/** Standard-mapping face buttons: A is the bottom one, B the right one. */
const PAD_A = 0
const PAD_B = 1

/**
 * Best-effort clipboard write. Reports whether it actually landed instead of
 * swallowing the rejection, because the caller shows a different (and honest)
 * screen when it did not — see ui/shareModel.ts. Fails legitimately in an
 * insecure context, in a WebView that withholds the permission, and possibly
 * after a slow await has outlived the tap's transient user activation.
 */
const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false // `navigator.clipboard` may not even exist; the catch covers both
  }
}

/** The pause overlay: the big PAUSED title plus the shared gun+mods loadout
 * panel and the Resume / New Seed / Run-it-back / Refresh / Share-state actions.
 * `onResume` unpauses, `onNewSeed`/`onRestart`/`onRefresh`/`onShare` are wired only on
 * host/solo (undefined hides the button). Reachable via Escape, the pad's
 * Start button, or the ⏸ chrome button (main.ts — the only one of the three a
 * phone has). */
export interface PauseOverlay {
  update(paused: boolean, view: RenderView): void
}
export const createPauseOverlay = (
  mount: HTMLElement,
  actions: {
    onResume: () => void
    onNewSeed?: () => void
    onRestart?: () => void
    /** Abandon the run and go to the start menu. */
    onMainMenu?: () => void
    /** False when there is no run to go back to (a client whose host left):
     * Resume is hidden, so the cursor opens on Main menu. Read each frame. */
    canResume?: () => boolean
    /** The heading, read each frame. A net session's menu does not stop the
     * shared sim, so it is not "PAUSED", and a client's says why it opened. */
    title?: () => string
    /** True once the session itself is over (a client whose host left or whose
     * link died). The menu then shows even over the death or game-over screen,
     * which would otherwise wait for a host that is gone. Read each frame. */
    sessionOver?: () => boolean
    /** Save, fetch the newest build, go to the picker. `show` paints its status. */
    onRefresh?: (show: (text: string) => void) => void
    onShare?: (note?: string) => Promise<ShareResult>
    weaponThumb?: WeaponThumb
    modSwaps?: ModSwapQueue
  },
): PauseOverlay => {
  const el = document.createElement('div')
  markUiChrome(el)
  el.style.cssText =
    'position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:16px;z-index:60;background:#0009;pointer-events:auto;text-align:center;padding:20px;box-sizing:border-box'
  const heading = document.createElement('div')
  heading.dataset.role = 'pause-title'
  heading.style.cssText = 'font:800 40px system-ui;color:#fff;letter-spacing:6px;text-shadow:0 2px 8px #000'
  const title = actions.title ?? (() => 'PAUSED')
  heading.textContent = title()
  el.appendChild(heading)
  const panel = createLoadoutPanel(actions.weaponThumb)
  el.appendChild(panel.el)
  // Sequenced mods: the wand order, reorderable while paused. The sim is
  // stopped, so swaps queue and apply on the first tick after Resume; the strip
  // previews the queued order meanwhile. Touch and mouse tap two chips; a pad
  // taps them with A (see the controller nav below).
  const swaps = actions.modSwaps
  let lastView: RenderView | undefined
  const paintSeq = (): void => {
    const v = lastView
    seq.update(
      v && swaps
        ? buildSequence(v.self, v.simTick ?? v.tick, (mods) => previewSwaps(mods, swaps.pending()))
        : null,
    )
  }
  const seq = createSequenceStrip((a, b) => {
    swaps?.push(a, b)
    paintSeq()
  })
  seq.el.style.cssText += ';width:min(340px,86vw);box-sizing:border-box;padding:8px 10px;border-radius:10px;background:#141822f2;text-align:left;color:#e7e7ee;font:12px system-ui'
  el.appendChild(seq.el)
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center'
  const btn = (label: string, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = primary
      ? 'font:600 16px system-ui;padding:10px 24px;border-radius:8px;border:0;background:#7fd17f;color:#0b0b12;cursor:pointer'
      : 'font:600 16px system-ui;padding:10px 24px;border-radius:8px;border:1px solid #ffd76a;background:#1b1e28;color:#ffd76a;cursor:pointer'
    return b
  }
  const resumeBtn = btn('Resume', true)
  resumeBtn.addEventListener('click', actions.onResume)
  row.appendChild(resumeBtn)
  // New Seed, Run it back and Main menu each end the run, so each takes two
  // presses (twoPress.ts). Closing the menu disarms them all.
  const runEnders = createTwoPressGroup()
  const twoPress = (role: string, label: string, armedLabel: string, act: () => void): HTMLButtonElement => {
    const b = btn(label, false)
    b.dataset.role = role
    runEnders.wire(b, armedLabel, act)
    return b
  }
  if (actions.onNewSeed) row.appendChild(twoPress('pause-new-seed', '🎲 New Seed', '🎲 Wipe this run? Press again', actions.onNewSeed))
  if (actions.onRestart) row.appendChild(twoPress('pause-run-it-back', 'Run it back', 'Restart this run? Press again', actions.onRestart))
  const mainMenuBtn = actions.onMainMenu ? twoPress('pause-main-menu', MAIN_MENU_LABEL, MAIN_MENU_ARMED_LABEL, actions.onMainMenu) : null
  if (mainMenuBtn) row.appendChild(mainMenuBtn)
  el.appendChild(row)
  const onRefresh = actions.onRefresh
  if (onRefresh) {
    const refreshBtn = btn('⟳ Refresh', false)
    refreshBtn.dataset.role = 'pause-refresh'
    const status = document.createElement('div')
    status.dataset.role = 'refresh-status'
    status.style.cssText = 'font:600 14px system-ui;color:#cfd3e0;display:none'
    refreshBtn.addEventListener('click', () => {
      // One way out: nothing else on this panel may act on a run that is leaving.
      for (const b of row.querySelectorAll('button')) {
        b.disabled = true
        b.style.opacity = '0.6'
      }
      onRefresh((text) => {
        status.textContent = text
        status.style.display = 'block'
      })
    })
    row.appendChild(refreshBtn)
    el.appendChild(status)
  }
  // ── Share state ───────────────────────────────────────────────────────────
  // One tap: snapshot the live world (with the ring's run-up), verify it replays
  // to itself, upload it, put the URL on the clipboard. The state machine and
  // every word on screen are in ui/shareModel.ts, unit-tested, so this block is
  // only DOM. Nothing here can paint a success that did not happen.
  //
  // KNOWN, AND DELIBERATE: the last link SURVIVES a New Seed / Run it back, so
  // reopening the menu after a restart still shows it. It is not stale — an
  // uploaded snapshot stays valid whatever the live world does next — and
  // clearing it would throw away a link he may not have finished sending. The
  // cost is that after a restart the link describes the PREVIOUS run.
  const onShare = actions.onShare
  if (onShare) {
    const shareBtn = btn('🔗 Share state', false)
    row.appendChild(shareBtn)
    let share = initialShare()
    const status = document.createElement('div')
    status.dataset.role = 'share-status'
    status.style.cssText = 'font:500 13px system-ui;color:#cfd3e0;max-width:min(92vw,540px);display:none'
    // A READ-ONLY INPUT, not a <div>: on Android a long-press on plain text in a
    // full-screen overlay does not reliably raise the selection handles, and the
    // fallback path is worthless if it cannot actually be copied. An input gives
    // the native select-all/copy affordance, and tapping it selects the lot so
    // the long-press only has to hit "Copy".
    const link = document.createElement('input')
    link.readOnly = true
    link.dataset.role = 'share-url'
    link.setAttribute('aria-label', 'Shared state link')
    link.style.cssText =
      'font:500 13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 10px;border-radius:8px;' +
      'border:1px solid #4a4f60;background:#11131b;color:#ffd76a;width:min(92vw,540px);display:none;' +
      'text-align:center;box-sizing:border-box;pointer-events:auto'
    const selectAll = (): void => link.select()
    link.addEventListener('focus', selectAll)
    link.addEventListener('click', selectAll)

    const paint = (): void => {
      shareBtn.textContent = shareButtonLabel(share)
      const busy = shareAction(share) === 'none'
      shareBtn.disabled = busy
      shareBtn.style.opacity = busy ? '0.6' : '1'
      const text = shareStatusText(share)
      status.textContent = text ?? ''
      status.style.display = text === null ? 'none' : 'block'
      status.style.color = share.phase === 'failed' ? '#ff9a9a' : '#cfd3e0'
      const url = shareUrl(share)
      link.value = url ?? ''
      link.style.display = url === null ? 'none' : 'block'
    }

    const set = (next: ShareState): void => {
      share = next
      paint()
    }

    shareBtn.addEventListener('click', () => {
      const action = shareAction(share)
      if (action === 'none') return
      if (action === 'copy') {
        // Retry inside a FRESH gesture — the whole reason this is a second tap
        // rather than an automatic retry. No re-upload: same URL, same world.
        const url = shareUrl(share)
        const before = share
        if (url !== null) void copyToClipboard(url).then((copied) => set(shareCopyRetried(before, copied)))
        return
      }
      set(shareStarted())
      // Fire-and-forget on purpose: the handler must return at once so the tap
      // feels answered, and the pending state is what says "still working".
      // Capture + a full replay self-check + gzip + upload is seconds, not
      // milliseconds, which is also why the clipboard write below may find the
      // tap's user activation expired — handled, not assumed away.
      void (async () => {
        try {
          const r = await onShare('shared from the pause menu')
          set(shareSucceeded(r.url, r.rewindTicks, await copyToClipboard(r.url)))
        } catch (err) {
          set(shareFailed(err))
        }
      })()
    })
    el.appendChild(status)
    el.appendChild(link)
    paint()
  }
  mount.appendChild(el)
  // Controller: the wand strip is the top row and the actions the bottom one.
  // Up/Down change row, Left/Right walk it, A presses, B resumes. Start is not
  // a confirm here: it already toggles pause. Every open lands on Resume, or on
  // Main menu when there is nothing to resume, and a button still held from
  // the press that opened the menu cannot act.
  const resumable = (): boolean => resumeBtn.style.display !== 'none'
  installGamepadMenuNav(() => [stripChips(seq), [...row.querySelectorAll('button')]], {
    suppress: () => el.style.display === 'none',
    confirmButtons: [PAD_A],
    back: {
      buttons: [PAD_B],
      run: () => {
        if (!resumeBtn.disabled && resumable()) resumeBtn.click()
      },
    },
    home: () => (resumable() ? resumeBtn : mainMenuBtn),
  })
  let wasPaused = false
  return {
    update(paused, view) {
      // Never over the death/game-over overlay — that screen owns its own panel —
      // unless the session is over, when only this menu has a way out.
      const over = actions.sessionOver?.() ?? false
      const show = paused && (over || (!view.gameOver && !view.self?.dead))
      // Opaque when it covers a death screen, so its "Waiting for the host…"
      // does not show through.
      el.style.background = over ? '#0b0b12' : '#0009'
      if (show && !wasPaused) panel.update(buildLoadout(view.self)) // refresh on open
      if (!show) runEnders.disarmAll()
      if (show) {
        lastView = view
        paintSeq()
        const text = title()
        if (heading.textContent !== text) heading.textContent = text
        // Hidden, not disabled: Refresh's lockout owns `disabled`.
        resumeBtn.style.display = (actions.canResume?.() ?? true) ? '' : 'none'
      }
      wasPaused = show
      el.style.display = show ? 'flex' : 'none'
    },
  }
}
