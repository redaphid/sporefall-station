// Playing a shared debug link back: restore the world from ~1 s before the
// interesting moment, run the recorded inputs forward at NORMAL SPEED so it
// reads as gameplay, then hand control over at the captured frame.
//
// WHY NORMAL SPEED: the point is to watch a bug happen. A bug that only makes
// sense at 30 Hz — a hitbox overlapping for two ticks, a spawn landing inside a
// wall — is unreadable fast-forwarded, and this is at most two seconds. The
// replay is driven by the SAME fixed-timestep accumulator as live play
// (`SIM_DT` in main.ts's frame loop), so it is not merely "about" normal speed,
// it is the identical clock the sim always runs on.
//
// WHY A BANNER: without one, a viewer whose inputs do nothing for two seconds
// concludes the game is broken. It says a replay is running, how far along it
// is, and — loudly — when it ends.
//
// THE VERIFY IS THE FEATURE, NOT A TEST. Replaying from T-1s must land exactly
// on the state captured at T. That comparison runs HERE, on the real played
// world, on every load. Match means determinism is proven for this capture.
// Mismatch means the capture is incomplete, and a debugging tool that quietly
// shows something plausible and wrong is worse than none — so it turns red and
// names the tick and the field.

import { type StateLinkCheck, type StateLinkPayload } from '../debug/stateLink'
import { compareWorlds } from '../debug/worldCompare'
import { APP_VERSION } from './version'
import { serializeWorld } from '../game/serialize'
import { SIM_RATE, type InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'

export interface StateReplay {
  /** True while recorded frames remain. main.ts drives `step()` instead of
   * `session.tick()` for exactly this long. */
  readonly active: boolean
  step(): void
}

const BASE_STYLE =
  'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:60;' +
  'font:600 13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;padding:7px 13px;' +
  'border-radius:6px;pointer-events:none;white-space:pre;text-align:center;' +
  'box-shadow:0 2px 10px rgba(0,0,0,.45);transition:opacity .4s ease'

const banner = (mount: HTMLElement): HTMLDivElement => {
  const el = document.createElement('div')
  el.dataset['role'] = 'state-replay-banner'
  el.setAttribute('style', BASE_STYLE)
  mount.appendChild(el)
  return el
}

const show = (el: HTMLDivElement, text: string, bg: string, fg = '#fff'): void => {
  el.textContent = text
  el.setAttribute('style', `${BASE_STYLE};background:${bg};color:${fg};opacity:1`)
}

/**
 * Drive a loaded payload's rewind forward.
 *
 * `world` must already BE the rewind world (main.ts injects
 * `payload.rewind.world` before calling this) — this only advances it.
 */
export const startStateReplay = (
  payload: StateLinkPayload,
  getWorld: () => World,
  mount: HTMLElement,
  onDone?: (check: StateLinkCheck) => void,
): StateReplay => {
  const frames = payload.rewind?.frames ?? []
  const total = frames.length
  const el = banner(mount)
  let i = 0
  // The first replayed tick whose per-tick signature disagreed with the
  // sender's. Those signatures (`StateFrame.sig` = [rng cursor, entity count])
  // are recorded on every capture and were, until now, thrown away on the LOAD
  // path — so a diverging link could say WHICH FIELD ended up wrong but never
  // WHEN it started going wrong. The tick is most of the diagnosis: tick 3 of
  // 60 means the restore itself is incomplete, tick 58 means something late and
  // situational. Two integer compares per tick, so it stays armed for free.
  let divergedAtTick: number | undefined

  const finish = (): void => {
    // Compare the world we actually PLAYED against the frame that was captured.
    //
    // TOLERANT, not bit-exact — and only here. `Math.sin`/`cos`/`atan2`/`hypot`
    // are not required to be correctly rounded, so a link captured on a phone
    // and opened on a laptop can land a fraction of an ULP away on some
    // positions. Refusing to show the bug over that is the worse failure.
    // Everything that could make the world BEHAVE differently — the PRNG
    // cursors, the entity set, ids, tick, seed, floor and every integer
    // quantity — is still compared exactly; see `worldCompare.ts`.
    //
    // Within tolerance is SILENT. Not a softer banner, not a console.warn: a
    // difference in the last bits of a double is not information, and saying
    // anything about it trains the viewer to ignore the message that matters.
    const played = serializeWorld(getWorld())
    const difference = compareWorlds(payload.world, played)
    const check: StateLinkCheck = difference
      ? {
          ok: false,
          rewindTicks: total,
          difference,
          ...(divergedAtTick !== undefined ? { divergedAtTick } : {}),
          // `difference.reason` already names the field, BOTH values, and how
          // far apart they are versus how far apart they were allowed to be —
          // which is what separates "last-bit noise" from "the sim is wrong".
          reason:
            `replay did not reconverge` +
            `${divergedAtTick !== undefined ? ` from tick ${divergedAtTick}` : ''}; ${difference.reason}`,
        }
      : { ok: true, rewindTicks: total }

    // Publish the verdict AND the exact world the replay landed on. Read live
    // by `e2e/state-link-roundtrip.mjs`: the game keeps ticking the instant
    // control is handed back, so "what did it reconverge to" is unobservable a
    // few frames later. Anyone automating a bug report can read this too.
    ;(window as unknown as { __stateReplay: unknown }).__stateReplay = {
      ok: check.ok,
      reason: check.reason,
      difference: check.difference,
      tick: played.tick,
      world: played,
    }

    if (check.ok) {
      show(el, `▶ LIVE — you have control${payload.meta.note ? `\n"${payload.meta.note}"` : ''}`, 'rgba(20,120,60,.92)')
      setTimeout(() => (el.style.opacity = '0'), 2200)
      setTimeout(() => el.remove(), 3000)
    } else {
      // Deliberately persistent and red: this link does NOT reproduce what the
      // sender saw, and silently continuing would waste the viewer's time.
      // The MAGNITUDE line is the point of the whole feature. Anything that
      // reaches here is already past the float tolerance, so the reader's next
      // question is "past it by a hair, or by a mile?" — a position out by
      // 1e-11 means the tolerance wants widening; one out by 3 means the sim is
      // wrong. Telling those apart is the judgement this check exists to serve.
      const scale =
        difference!.kind === 'float'
          ? `off by ${difference!.delta!.toExponential(2)} · relative ${difference!.relative!.toExponential(2)} · tolerance ${difference!.tolerance!.toExponential(0)}`
          : `${difference!.kind} field — always compared exactly, never with tolerance`
      // BUILD SKEW IS THE FIRST THING TO SUSPECT, so say it on the banner
      // rather than burying it in the console line main.ts already logs. A link
      // captured on a different build replays against different sim CODE, which
      // is not a determinism failure at all — it is the expected outcome, and a
      // viewer who does not know that will go hunting for a bug that is not
      // there.
      const skew =
        payload.meta.build && payload.meta.build !== APP_VERSION
          ? `\ncaptured on build ${payload.meta.build}, you are on ${APP_VERSION} — likely the cause`
          : ''
      show(
        el,
        `⚠ REPLAY DIVERGED — this link does not reproduce the sender's state\n` +
          `${divergedAtTick !== undefined ? `first drifted at tick ${divergedAtTick}\n` : ''}` +
          `first difference: ${difference!.path}\n` +
          `expected ${difference!.expected} · got ${difference!.actual}\n` +
          scale +
          skew,
        'rgba(160,30,30,.95)',
      )
      console.error(`sporefall: ${check.reason}`)
    }
    onDone?.(check)
  }

  const step = (): void => {
    const frame = frames[i]
    if (!frame) return
    i++
    const world = getWorld()
    tickWorld(world, new Map(frame.inputs.map(([slot, cmd]: [number, InputCmd]) => [slot, { ...cmd }])))
    // Signature check, deliberately EXACT: both halves are integers (a PRNG
    // cursor and an entity count), and neither is subject to float noise.
    if (divergedAtTick === undefined && frame.sig) {
      const [rng, entityCount] = frame.sig
      if (world.rng.state() !== rng || world.entities.length !== entityCount) divergedAtTick = world.tick
    }
    const left = ((total - i) / SIM_RATE).toFixed(1)
    show(el, `⏵ REPLAY  ${i}/${total} ticks  ·  ${left}s to live`, 'rgba(30,30,40,.88)', '#ffd479')
    if (i >= total) finish()
  }

  if (total === 0) {
    // No run-up was recorded (the sender had no ring armed). The captured frame
    // is already loaded, so there is nothing to play — just say so.
    show(el, `▶ LIVE — captured frame${payload.meta.note ? `\n"${payload.meta.note}"` : ''}`, 'rgba(20,120,60,.92)')
    setTimeout(() => (el.style.opacity = '0'), 2200)
    setTimeout(() => el.remove(), 3000)
  } else {
    show(el, `⏵ REPLAY  0/${total} ticks  ·  ${(total / SIM_RATE).toFixed(1)}s to live`, 'rgba(30,30,40,.88)', '#ffd479')
  }

  return {
    get active(): boolean {
      return i < total
    },
    step,
  }
}
