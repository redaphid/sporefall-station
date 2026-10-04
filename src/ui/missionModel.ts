// Pure view-model for the mission panel (no DOM, no pixi — unit-tested).
// Turns the per-frame RenderView mission fields into a list of objective rows,
// each optionally carrying a LINK to a world entity or point the player can tap
// to focus the camera on it. All degenerate states (dead/despawned target,
// no mission, client placeholder text, game over) resolve here, so the DOM
// glue in missionPanel.ts stays a dumb renderer.

import { LOCKDOWN_TICKS } from '../game/systems/alarm'

/** What an objective row can point at: a live entity (preferred — the engine
 * reads its live position every frame) or a fixed world point (the exit tile). */
export interface ObjectiveLink {
  targetId?: number
  x?: number
  y?: number
}

export type ObjectiveState = 'active' | 'done' | 'locked'

export interface Objective {
  /** Stable key for DOM pooling ('mission' | 'exit'). */
  key: string
  text: string
  state: ObjectiveState
  /** Present iff tapping the row can focus the camera somewhere meaningful. */
  link?: ObjectiveLink
}

/** The slice of RenderView the mission model reads (structural, so tests can
 * feed plain objects and the model never depends on the full Entity shape). */
export interface MissionViewLike {
  floor: number
  missionText: string
  missionComplete: boolean
  gameOver: boolean
  /** The mission's target entity id (steal item / assassinate boss), if any. */
  missionTargetId?: number
  entities: readonly { id: number; dead?: boolean; pos: { x: number; y: number } }[]
  /** Exit tile (integer corner) — omitted on a client before the level arrives. */
  exit?: { x: number; y: number }
  /** Open `extraction` mission: the way out is this entry tile, not the exit. */
  extraction?: { x: number; y: number; held: boolean }
  /** #86 lockdown (RenderView.lockdown): the alarm sealed the way out. */
  lockdown?: { secondsLeft?: number }
}

/** The line that tells the player WHY the way out is shut, or undefined when no
 * lockdown is in force. An extraction's way out is the entry, not the Launch Bay. */
const lockdownText = (v: Pick<MissionViewLike, 'lockdown' | 'extraction'>): string | undefined => {
  if (!v.lockdown) return undefined
  if (v.lockdown.secondsLeft !== undefined) return `${v.extraction ? 'WAY OUT' : 'LAUNCH BAY'} SEALED · lockdown ${v.lockdown.secondsLeft}s`
  if (v.extraction) return `LOCKDOWN · the alarm will hold the way out ${LOCKDOWN_TICKS / 30}s after the grab`
  return `LOCKDOWN · the alarm will hold the Launch Bay ${LOCKDOWN_TICKS / 30}s after the objective`
}

export const EXTRACT_ROW_TEXT = 'Get out the way you came'

/** Case-insensitive "this mission IS the exit objective" test, so a `reach`
 * template doesn't render as two identical rows. The exit is the Launch Bay. */
const isReachText = (text: string): boolean => text.trim().toLowerCase() === 'reach the launch bay'

/**
 * Build the objective rows for the current frame.
 *
 * - Game over → no rows (the restart overlay owns the screen).
 * - Primary row: the mission description; linked to the target entity while it
 *   is alive and the objective incomplete. A dead/despawned target simply drops
 *   the link (the row keeps rendering — the text is still the mission).
 * - Exit row: locked until the mission completes; once open it links to the
 *   exit tile centre. A `reach` mission collapses to just this row.
 */
export const missionObjectives = (v: MissionViewLike): Objective[] => {
  if (v.gameOver) return []
  const x = v.extraction
  if (x) {
    // Prize on the floor → go get it; prize in hand → the entry is the objective,
    // unless a lockdown holds it shut.
    const sealed = lockdownText(v)
    return [
      { key: 'mission', text: v.missionText, state: x.held ? 'done' : 'active', link: x.held ? undefined : entityLink(v) },
      {
        key: 'exit',
        text: sealed ?? EXTRACT_ROW_TEXT,
        state: x.held && !sealed ? 'active' : 'locked',
        link: x.held ? { x: x.x + 0.5, y: x.y + 0.5 } : undefined,
      },
    ]
  }
  const rows: Objective[] = []
  if (!isReachText(v.missionText)) {
    rows.push({
      key: 'mission',
      text: v.missionText,
      state: v.missionComplete ? 'done' : 'active',
      link: v.missionComplete ? undefined : entityLink(v),
    })
  }
  if (v.exit) {
    const sealed = lockdownText(v)
    rows.push({
      key: 'exit',
      text: sealed ?? 'Reach the Launch Bay',
      state: v.missionComplete && !sealed ? 'active' : 'locked',
      link: v.missionComplete ? { x: v.exit.x + 0.5, y: v.exit.y + 0.5 } : undefined,
    })
  }
  return rows
}

/** Link to the mission target entity — only while it can actually be focused
 * (id known, entity still present and not dead). */
const entityLink = (v: MissionViewLike): ObjectiveLink | undefined => {
  if (v.missionTargetId === undefined) return undefined
  const e = v.entities.find((t) => t.id === v.missionTargetId)
  if (!e || e.dead) return undefined
  return { targetId: v.missionTargetId }
}

/** Collapsed-chip text — parity with the old one-line mission readout. */
export const missionChipText = (
  v: Pick<MissionViewLike, 'floor' | 'missionText' | 'missionComplete' | 'extraction' | 'lockdown'>,
): string => {
  const secs = v.lockdown?.secondsLeft
  if (v.extraction?.held)
    return secs !== undefined ? `Floor ${v.floor} — GOT IT! Way out sealed · ${secs}s` : `Floor ${v.floor} — GOT IT! Get out the way you came`
  if (v.missionComplete && secs !== undefined) return `Floor ${v.floor} — LAUNCH BAY SEALED · ${secs}s`
  if (v.missionComplete) return `Floor ${v.floor} — LAUNCH BAY is open!`
  return `Floor ${v.floor} — ${v.lockdown ? 'LOCKDOWN · ' : ''}${v.missionText}`
}

/**
 * Resolve a link to its CURRENT world position: a live entity's live pos, or
 * the fixed point. `undefined` when the entity is gone/dead mid-link — callers
 * treat that as "the link just died" (end focus, drop indicators).
 */
export const resolveLink = (
  link: ObjectiveLink,
  entities: readonly { id: number; dead?: boolean; pos: { x: number; y: number } }[],
): { x: number; y: number } | undefined => {
  if (link.targetId !== undefined) {
    const e = entities.find((t) => t.id === link.targetId)
    if (!e || e.dead) return undefined
    if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.y)) return undefined
    return { x: e.pos.x, y: e.pos.y }
  }
  if (link.x !== undefined && link.y !== undefined && Number.isFinite(link.x) && Number.isFinite(link.y))
    return { x: link.x, y: link.y }
  return undefined
}
