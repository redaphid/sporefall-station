import { NPCS } from './data/npcs'
import { TIDE_FLOOD, TIDE_PERIOD } from './floorModifiers'
import { isSolidTile, rectContains } from './levelgen/level'
import type { Rect } from './levelgen/rooms'
import { spawnNpc } from './populate'
import { startFloorModifier } from './systems/modifierSystem'
import type { World } from './world'

export interface ArenaFoe {
  archetype: string
  count: number
  /** Merged over the archetype's own resist table. */
  resist?: Record<string, number>
  wet?: boolean
}

export interface ArenaSpec {
  question: string
  foes: readonly ArenaFoe[]
  /** The arena this one differs from in exactly the foe overrides, for a side-by-side census comparison. */
  control?: string
  /** Fought on a bog-tide floor whose tide floods the arena room as the fight
   * starts (EXPERIMENT_FLOODED_ROOMS). */
  tide?: boolean
}

/** How far into its cycle a tide arena's tide starts: the flood rises on the
 * first tick, holds TIDE_FLOOD ticks, and returns TIDE_PERIOD ticks later. */
export const TIDE_ARENA_AGE = TIDE_PERIOD - TIDE_FLOOD

const MIRECLAW_WEAK_TO_LIGHTNING: Record<string, number> = { electrified: 2 }

export const ARENAS: Readonly<Record<string, ArenaSpec>> = {
  'arena-brute': {
    question: 'An armoured closer: bullets do 35%, so low damage per second loses the race.',
    foes: [{ archetype: 'brute', count: 1 }],
  },
  'arena-brute-pair': {
    question: 'Two armoured closers: more than one element has to land.',
    foes: [{ archetype: 'brute', count: 2 }],
  },
  'arena-kiter': {
    question: 'Shooters that hold range and fire back: stop them shooting or lose the trade.',
    foes: [{ archetype: 'gangster', count: 3 }],
  },
  'arena-swarm': {
    question: 'A fast swarm: one bullet per body is too slow.',
    foes: [{ archetype: 'sporeling', count: 6 }],
  },
  'arena-cinder': {
    question: 'Ash-dwellers: fire does 20%, bullets do 110%.',
    foes: [{ archetype: 'cinder', count: 4 }],
  },
  'arena-boss': {
    question: 'Mireclaw Alpha with its stock resists.',
    foes: [{ archetype: 'boss', count: 1 }],
  },
  'arena-boss-lightning': {
    question: 'Mireclaw Alpha weak to lightning (electrified x2).',
    foes: [{ archetype: 'boss', count: 1, resist: MIRECLAW_WEAK_TO_LIGHTNING }],
    control: 'arena-boss',
  },
  'arena-boss-wet': {
    question: 'Mireclaw Alpha with its stock resists, standing wet.',
    foes: [{ archetype: 'boss', count: 1, wet: true }],
  },
  'arena-boss-lightning-wet': {
    question: 'Mireclaw Alpha weak to lightning and standing wet, so a shock chain could land.',
    foes: [{ archetype: 'boss', count: 1, resist: MIRECLAW_WEAK_TO_LIGHTNING, wet: true }],
    control: 'arena-boss-wet',
  },
  'arena-bog-boss-stock': {
    question: 'Mireclaw Alpha with its stock resists, in a lair the bog tide floods as the fight starts.',
    foes: [{ archetype: 'boss', count: 1 }],
    tide: true,
  },
  'arena-bog-boss': {
    question: 'Mireclaw Alpha weak to lightning (electrified x2), in a lair the bog tide floods as the fight starts.',
    foes: [{ archetype: 'boss', count: 1, resist: MIRECLAW_WEAK_TO_LIGHTNING }],
    control: 'arena-bog-boss-stock',
    tide: true,
  },
}

/** The room an arena is fought in: the seed's room with the most open floor,
 * first in building/room order on a tie. */
export const arenaRoom = (w: World): Rect | undefined => {
  let best: Rect | undefined
  let bestOpen = 0
  for (const b of w.level.buildings) {
    for (const r of b.rooms) {
      let open = 0
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!isSolidTile(w.level, x, y)) open++
      if (open > bestOpen) {
        best = r
        bestOpen = open
      }
    }
  }
  return best
}

/** Open cells on line `d` of `room` (counted from the near end), centre-out. */
const lineCells = (w: World, room: Rect, alongX: boolean, d: number): { x: number; y: number }[] => {
  const breadth = alongX ? room.h : room.w
  const mid = Math.floor(breadth / 2)
  return [...Array(breadth).keys()]
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
    .map((s) => (alongX ? { x: room.x + d, y: room.y + s } : { x: room.x + s, y: room.y + d }))
    .filter((c) => !isSolidTile(w.level, c.x, c.y))
}

/** Stage `spec` in `room`. Clears the cast, loot, fire and projectiles
 * floor-wide and the furniture in the room, stands the player on the first
 * line in from the near end at full health with no spawn grace, and fills a
 * band of lines at the far end with the foes. The band starts no further than
 * one tile inside the shortest sight range in the cast, so every foe can see
 * the player from where it stands. */
export const stageArena = (w: World, spec: ArenaSpec, room: Rect | undefined = arenaRoom(w)): void => {
  const player = w.entities.find((e) => e.playerCtl)
  if (!room || !player) return
  const alongX = room.w >= room.h
  const start = lineCells(w, room, alongX, 1)[0]
  if (!start) return
  w.entities = w.entities.filter(
    (e) =>
      e.playerCtl ||
      !(e.ai || e.projectile || e.kind === 'pickup' || e.kind === 'fire' || (e.kind === 'interactable' && rectContains(room, Math.floor(e.pos.x), Math.floor(e.pos.y)))),
  )
  w.byId.clear()
  for (const e of w.entities) w.byId.set(e.id, e)
  w.groups = undefined
  w.hostile = true
  // A completed mission keeps missionSystem from unsealing the floor under the
  // fight; a locked exit keeps the bot's retreat from carrying it to floor 2.
  w.mission = { template: 'reach', complete: true, exitUnlocked: false, description: 'Win the fight' }

  player.pos = { x: start.x + 0.5, y: start.y + 0.5 }
  player.prevPos = { x: player.pos.x, y: player.pos.y }
  player.facing = alongX ? 0 : Math.PI / 2
  if (player.health) player.health = { hp: player.health.max, max: player.health.max, iframes: 0 }

  const depth = alongX ? room.w : room.h
  const sight = Math.min(...spec.foes.map((f) => NPCS[f.archetype].sightRange))
  const far = Math.min(depth - 1, sight)
  const cells: { x: number; y: number }[] = []
  for (let d = far; d >= Math.ceil((far + 1) / 2); d--) cells.push(...lineCells(w, room, alongX, d))
  if (spec.tide) {
    startFloorModifier(w, 'bogTide', TIDE_ARENA_AGE)
    w.modifier!.floodRooms = [room]
  }
  let next = 0
  for (const foe of spec.foes) {
    for (let i = 0; i < foe.count && next < cells.length; i++) {
      const at = cells[next++]
      const e = spawnNpc(w, foe.archetype, at.x + 0.5, at.y + 0.5)
      if (foe.resist) e.resist = { ...e.resist, ...foe.resist }
      if (foe.wet) (e.fx ??= {}).wet = { until: Number.MAX_SAFE_INTEGER }
    }
  }
}
