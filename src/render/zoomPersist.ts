/**
 * Zoom-preference persistence (view-only). The player's chosen zoom TARGET is
 * remembered across sessions in localStorage, same discipline as the button
 * remap (input/remap.ts): a versioned envelope ({ v: 1, zoom }), validated on
 * read, with any garbage — wrong version, wrong type, NaN, out-of-range —
 * collapsing to a clamped default rather than propagating. Restore happens at
 * boot in main.ts (an explicit `?zoom=` URL param still wins: it is applied
 * AFTER the restore and writes nothing back, so a shared debug link never
 * overwrites the player's preference); saves ride the ZoomSink wrapper below,
 * debounced so a held pad button / long pinch costs one write, not hundreds.
 */

import { clampZoom, ZOOM_DEFAULT, type ZoomSink } from './zoomModel'

const STORAGE_KEY = 'sporefall.zoom'

/** How long after the last zoom change before the target is written. Long
 * enough to swallow a whole gesture, short enough to survive a quick exit. */
export const ZOOM_SAVE_DEBOUNCE_MS = 400

/** Parse a persisted (or arbitrary) value into a valid zoom level. Pure.
 * Anything that is not a `{ v: 1, zoom: finite number }` envelope falls back
 * to ZOOM_DEFAULT; a finite but out-of-range zoom is clamped, not rejected —
 * it is an honest preference from a build whose bounds may have differed. */
export const parseStoredZoom = (raw: unknown): number => {
  if (typeof raw !== 'object' || raw === null) return ZOOM_DEFAULT
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || typeof r.zoom !== 'number' || !Number.isFinite(r.zoom)) return ZOOM_DEFAULT
  return clampZoom(r.zoom)
}

export const loadZoom = (): number => {
  try {
    if (typeof localStorage === 'undefined') return ZOOM_DEFAULT
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ZOOM_DEFAULT
    return parseStoredZoom(JSON.parse(raw))
  } catch {
    return ZOOM_DEFAULT // corrupt JSON / privacy-locked storage → default
  }
}

export const saveZoom = (z: number): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, zoom: clampZoom(z) }))
  } catch {
    // Private-mode / quota failures are non-fatal; the zoom just won't persist.
  }
}

/**
 * Wrap a ZoomSink so every zoom change (wheel, pinch, pad, reset) schedules a
 * debounced save of the resulting TARGET. The debounce collapses a continuous
 * gesture into one write; reading the target through the inner sink at fire
 * time (not at schedule time) means the LAST value of the gesture is what
 * lands. `save` and the timer functions are injectable for tests.
 */
export const persistZoomSink = (
  sink: ZoomSink,
  save: (z: number) => void = saveZoom,
  debounceMs: number = ZOOM_SAVE_DEBOUNCE_MS,
): ZoomSink => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      save(sink.get())
    }, debounceMs)
  }
  return {
    get: () => sink.get(),
    set: (z, ax, ay) => {
      sink.set(z, ax, ay)
      schedule()
    },
    reset: () => {
      sink.reset()
      schedule()
    },
  }
}
