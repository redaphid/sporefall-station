// feat/frog-villager-sprites — the frog settler's new 5-direction walk cycle,
// in the engine, on the theme the game actually loads.
//
// The `civilian` archetype ("Settler", drawn as `frog-settler`) used to ship a
// SINGLE frame: every direction and the step frame were aliased to
// `frog-settler-s-idle.png`, so a walking frog was a sliding statue. It now has
// 5 drawn directions x (idle, step, walk-0..7); the engine mirrors the east
// half for the west (src/render/anim.ts `facingDir`), so these eight cells
// cover all eight compass sectors.
//
// The stage puts EIGHT frogs on a ring around the parked player and gives each
// a waypoint straight out from the centre, so every sector — the five drawn
// ones and the three mirrored ones — is on screen walking at the same time.
// `ai.mode = 'wander'` + `faction: 'civ'` is the showcase pattern from
// scenarios.ts `setupShowcase`: peaceful, so nobody mobs the player and the
// clip stays about locomotion.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** Centre of the open park in combat-stage, where walk8 also stages. */
const CX = 10
const CY = 11
const RING = 1.6 // start radius; the waypoint is straight out from here
const REACH = 5.0 // waypoint radius

/** The eight compass sectors, as unit vectors in screen space (y grows south). */
const SECTORS = [
  ['e', 1, 0],
  ['se', 0.7071, 0.7071],
  ['s', 0, 1],
  ['sw', -0.7071, 0.7071],
  ['w', -1, 0],
  ['nw', -0.7071, -0.7071],
  ['n', 0, -1],
  ['ne', 0.7071, -0.7071],
]

const frog = (id, dx, dy) => {
  const x = CX + dx * RING
  const y = CY + dy * RING
  return {
    id,
    kind: 'npc',
    archetype: 'civilian',
    pos: { x, y },
    prevPos: { x, y },
    vel: { x: 0, y: 0 },
    intent: { x: 0, y: 0 },
    speed: 1.9,
    radius: 0.35,
    facing: Math.atan2(dy, dx),
    health: { hp: 25, max: 25, iframes: 0 },
    combat: { weapon: 'shotgun', cooldown: 0 },
    status: { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 },
    ai: {
      mode: 'wander',
      faction: 'civ',
      home: { x, y },
      waypoint: { x: CX + dx * REACH, y: CY + dy * REACH },
      thinkAt: 0,
      sightRange: 6,
    },
  }
}

/** combat-stage reduced to: the player parked in the middle, eight frogs. */
const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: CX, y: CY }
  p.prevPos = { x: CX, y: CY }
  p.facing = Math.PI / 2
  p.health.hp = p.health.max
  const frogs = SECTORS.map(([, dx, dy], i) => frog(w.nextId + i, dx, dy))
  w.nextId += frogs.length
  w.entities = [p, ...frogs]
  return w
}

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  const civs = w.entities.filter((e) => e.archetype === 'civilian' && !e.dead)
  return {
    tick: w.tick,
    civilians: civs.length,
    // How many of them actually MOVED off their start ring — a walk cycle on a
    // statue proves nothing.
    moved: civs.filter((e) => Math.hypot(e.pos.x - e.ai.home.x, e.pos.y - e.ai.home.y) > 0.5).length,
    // Distinct drawn directions in play (the renderer mirrors e/se/ne for the
    // west half, so 5 drawn keys cover 8 sectors).
    facings: [...new Set(civs.map((e) => Math.round((e.facing / Math.PI) * 4)))].length,
    playerHp: pl?.health?.hp ?? null,
  }
}

const ok = await recordFeature({
  name: 'frog-villager-walk',
  world: stage(),
  params: { zoom: 2, theme: 'swampspace-hires' },
  stills: [
    { tick: 8, label: '00-ring-idle' },
    { tick: 60, label: '01-walking-out' },
    { tick: 120, label: '02-mid-stride' },
    { tick: 200, label: '03-spread' },
    { tick: 300, label: '04-far' },
  ],
  readState,
  expect: (s) => [
    s.civilians !== 8 && `expected 8 frogs alive, got ${s.civilians}`,
    s.moved < 6 && `only ${s.moved}/8 frogs moved — they are not walking`,
    s.facings < 4 && `only ${s.facings} distinct facings — the ring collapsed`,
    s.playerHp !== 100 && `player took damage (${s.playerHp}) — this clip is about locomotion`,
  ],
})

process.exit(ok ? 0 : 1)
