import { TILE_PX } from '../render/art'

/**
 * Co-op teammate locator (issue #34). Pure geometry so it's fully unit-tested:
 * screens.ts feeds it the camera/screen state each frame and renders the DOM
 * overlays it returns. Mirrors the EXIT compass math (atan2 on the world delta,
 * rounded distance) — no pixi involvement, DOM markers only.
 */

/** Stable per-slot caret colours; teammates keep the same hue all game.
 * Eight distinct hues so an 8-player run (slots 0..7) has no colour collisions. */
const SLOT_COLORS = ['#5aa9ff', '#7fd17f', '#ffd76a', '#d17fd1', '#ff9a5a', '#6ad1c8', '#c98cff', '#ff7fa8'] as const
/** Downed teammates override their slot colour with a loud red — rush to revive. */
export const DOWNED_COLOR = '#ff4d4d'

/** Stable caret colour for a player slot (playerId). Wraps past the palette. */
export const playerColor = (playerId: number): string =>
  SLOT_COLORS[((playerId % SLOT_COLORS.length) + SLOT_COLORS.length) % SLOT_COLORS.length]

/** Short stable label for a player slot: P1, P2, … (1-based, human-facing). */
export const playerLabel = (playerId: number): string => `P${playerId + 1}`

/** A teammate as the locator sees them — a player entity that is not `self`. */
export interface Teammate {
  playerId: number
  x: number
  y: number
  downed: boolean
}

/** Everything screens.ts must know to project world → screen, mirroring Camera.apply. */
export interface CameraState {
  /** Camera centre in world tiles (unclamped, as the follow target left it). */
  x: number
  y: number
  zoom: number
  screenW: number
  screenH: number
  levelW: number
  levelH: number
}

/** One teammate's on-screen marker (visible) or off-screen edge arrow (radar). */
export interface LocatorMarker {
  playerId: number
  color: string
  label: string
  downed: boolean
  /** Visible on-screen → name caret at (sx,sy); off-screen → edge arrow at (sx,sy). */
  onScreen: boolean
  /** Screen px: the caret anchor when on-screen, the edge-pinned arrow when off. */
  sx: number
  sy: number
  /** Off-screen only: glyph rotation (rad) and rounded world distance for the label. */
  angle: number
  dist: number
}

/** Pixels the marker anchor is inset from the raw screen edge so carets/arrows don't clip. */
const EDGE_MARGIN = 28

/**
 * Project a world tile coord to a screen pixel, replicating Camera.apply's edge
 * clamp exactly (read-only — the renderer is untouched). Shake is intentionally
 * ignored: it's sub-pixel jitter that would only make markers twitch.
 */
export const projectToScreen = (wx: number, wy: number, cam: CameraState): { x: number; y: number } => {
  const T = TILE_PX * cam.zoom
  const halfW = cam.screenW / 2 / T
  const halfH = cam.screenH / 2 / T
  const cx = cam.levelW * T > cam.screenW ? clamp(cam.x, halfW, cam.levelW - halfW) : cam.levelW / 2
  const cy = cam.levelH * T > cam.screenH ? clamp(cam.y, halfH, cam.levelH - halfH) : cam.levelH / 2
  return { x: cam.screenW / 2 + (wx - cx) * T, y: cam.screenH / 2 + (wy - cy) * T }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Inverse of {@link projectToScreen}: a screen pixel back to a world tile coord,
 * replicating Camera.apply's edge clamp exactly (read-only — the renderer is
 * untouched). Used to turn a tap/click into the world point under it so the
 * nearest entity can be picked. `projectToScreen(screenToWorld(p)) === p`.
 */
export const screenToWorld = (sx: number, sy: number, cam: CameraState): { x: number; y: number } => {
  const T = TILE_PX * cam.zoom
  const halfW = cam.screenW / 2 / T
  const halfH = cam.screenH / 2 / T
  const cx = cam.levelW * T > cam.screenW ? clamp(cam.x, halfW, cam.levelW - halfW) : cam.levelW / 2
  const cy = cam.levelH * T > cam.screenH ? clamp(cam.y, halfH, cam.levelH - halfH) : cam.levelH / 2
  return { x: cx + (sx - cam.screenW / 2) / T, y: cy + (sy - cam.screenH / 2) / T }
}

/**
 * Locate ONE world point relative to the viewer: on-screen → its projected
 * screen position; off-screen → an edge-pinned anchor with the glyph rotation
 * to point at it. `angle`/`dist` are measured from `from` (usually the player)
 * so the readout means "that way, N tiles". Returns undefined on any non-finite
 * input (never emit a NaN-transformed DOM node). Shared by the co-op teammate
 * locator and the mission-objective indicator.
 */
export interface PointMarker {
  onScreen: boolean
  /** Screen px: the projected point when on-screen, the edge-pinned anchor when off. */
  sx: number
  sy: number
  /** Rotation (rad) of a ➤ glyph pointing from `from` toward the target. */
  angle: number
  /** Rounded world-tile distance from `from` to the target. */
  dist: number
}

export const pointMarker = (
  from: { x: number; y: number },
  target: { x: number; y: number },
  cam: CameraState,
): PointMarker | undefined => {
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) return undefined
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return undefined
  const dx = target.x - from.x
  const dy = target.y - from.y
  // ➤ points east at 0°, matching world +x; +y is screen-down — same as the EXIT compass.
  const angle = Math.atan2(dy, dx)
  const dist = Math.round(Math.hypot(dx, dy))
  const p = projectToScreen(target.x, target.y, cam)
  const onScreen =
    p.x >= EDGE_MARGIN && p.x <= cam.screenW - EDGE_MARGIN && p.y >= EDGE_MARGIN && p.y <= cam.screenH - EDGE_MARGIN
  if (onScreen) return { onScreen: true, sx: p.x, sy: p.y, angle, dist }
  const edge = edgePoint(angle, cam.screenW, cam.screenH)
  return { onScreen: false, sx: edge.x, sy: edge.y, angle, dist }
}

/**
 * Build the render list for the co-op locator. Off-screen teammates become an
 * edge-pinned arrow (rotated toward them, world distance readout); visible ones
 * become an on-screen caret at their projected position. Downed teammates sort
 * last so their red marker paints on top. Skips any teammate with a non-finite
 * position (never emit a NaN-transformed DOM node).
 */
export const locatorMarkers = (self: { x: number; y: number }, teammates: readonly Teammate[], cam: CameraState): LocatorMarker[] => {
  const markers: LocatorMarker[] = []
  for (const t of teammates) {
    const m = pointMarker(self, t, cam)
    if (!m) continue
    const color = t.downed ? DOWNED_COLOR : playerColor(t.playerId)
    const label = playerLabel(t.playerId)
    markers.push({ playerId: t.playerId, color, label, downed: t.downed, ...m })
  }
  // Alive first, downed last → downed carets/arrows render on top (higher priority).
  markers.sort((a, b) => Number(a.downed) - Number(b.downed))
  return markers
}

/** Where a ray from screen-centre at `angle` meets the inset screen rect. */
const edgePoint = (angle: number, screenW: number, screenH: number): { x: number; y: number } => {
  const cx = screenW / 2
  const cy = screenH / 2
  const halfW = Math.max(0, cx - EDGE_MARGIN)
  const halfH = Math.max(0, cy - EDGE_MARGIN)
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  // t is finite whenever the screen has area; guard the pathological zero-size case.
  return Number.isFinite(t) ? { x: cx + dx * t, y: cy + dy * t } : { x: cx, y: cy }
}
