/**
 * Policy for "the frame threw" — pure, so it is testable without a DOM.
 *
 * The failure this exists for: `frame()` re-armed `requestAnimationFrame` as its
 * LAST statement, with no try/catch anywhere. One throw therefore did not drop a
 * frame, it ended that phone's rendering FOR THE REST OF THE SESSION — while the
 * host kept simulating and client-side prediction kept the player walking around.
 * From the inside it reads as "everybody else froze".
 *
 * The loop is now crash-proof (main.ts re-arms in a `finally`), which creates the
 * opposite hazard: a client that is quietly broken and says nothing is exactly
 * what made this take a playtest and a bug hunt to find. So nothing here
 * swallows. Every failure is reported — the question this module answers is only
 * HOW LOUDLY, because a fault that repeats every frame at 60 Hz would otherwise
 * bury the log (and cost more than the render it replaced).
 */

/** Console lines written for a newly-seen message before throttling kicks in. */
const LOG_BURST = 3
/** Once throttled, write one line per this many repeats (~5 s at 60 fps). */
const LOG_EVERY = 300

export interface FrameErrorState {
  /** Frames that threw since boot. */
  total: number
  /** Frames that threw back-to-back; 0 after any frame completes cleanly. */
  consecutive: number
  /** The most recent failure text (`name: message`). */
  message: string
  /** How many times the CURRENT message has fired in a row. */
  messageCount: number
}

export const initialFrameErrors = (): FrameErrorState => ({
  total: 0,
  consecutive: 0,
  message: '',
  messageCount: 0,
})

/** Human-readable one-liner for anything a `catch` can receive. */
export const frameErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}

/**
 * Record a thrown frame. `log` is the throttle decision: always true the first
 * few times a given message appears — a NEW fault is never silent, even if an
 * old one is mid-throttle — then once per `LOG_EVERY` repeats.
 */
export const noteFrameError = (
  state: FrameErrorState,
  message: string,
): { state: FrameErrorState; log: boolean } => {
  const same = message === state.message
  const messageCount = same ? state.messageCount + 1 : 1
  return {
    state: {
      total: state.total + 1,
      consecutive: state.consecutive + 1,
      message,
      messageCount,
    },
    log: messageCount <= LOG_BURST || messageCount % LOG_EVERY === 0,
  }
}

/** Record a frame that completed. Clears the streak, keeps the history. */
export const noteFrameOk = (state: FrameErrorState): FrameErrorState =>
  state.consecutive === 0 ? state : { ...state, consecutive: 0 }

/**
 * What to put on screen, or null while nothing has ever failed. Deliberately
 * says the game is still running (it is — that is the fix) and stays up after
 * recovery, because a fault that came and went is still a fault worth reporting.
 */
export const frameErrorBannerText = (state: FrameErrorState): string | null => {
  if (state.total === 0) return null
  const count = state.total > 1 ? ` (x${state.total})` : ''
  const stuck = state.consecutive > 1 ? ' — display stalled, still trying' : ''
  return `Display error${count}${stuck} — ${state.message}`
}

/**
 * Run one frame body with the re-arm guaranteed.
 *
 * The whole bug in one function: `rearm` lives in a `finally`, so no throw
 * anywhere in `body` can stop the next frame from being scheduled. Extracted
 * from main.ts's closure specifically so the guarantee is TESTABLE — the version
 * that shipped was structurally correct-looking too, right up until something
 * threw.
 *
 * A reporter that throws is caught separately: losing the report is bad, but
 * losing it AND the original error would be worse, so the fallback log carries
 * both.
 */
export const guardFrame = (body: () => void, onError: (err: unknown) => void, rearm: () => void): void => {
  try {
    body()
  } catch (err) {
    try {
      onError(err)
    } catch (reportErr) {
      console.error('[frame] error reporting itself failed:', reportErr, '— original error:', err)
    }
  } finally {
    rearm()
  }
}
