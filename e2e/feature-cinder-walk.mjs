// The cinder husk (archetype `cinder`, drawn as `cinder-husk` on
// swampspace-hires) walking every compass sector, in the engine, on the theme
// the game actually loads. Each walker has its real weapon from npcs.ts, fists,
// which the renderer draws no held sprite for. Brains are off and the faction is
// civ, so nobody swings; the real player idles at the centre facing the camera.
//
// The theme draws 5 directions x (idle, step, walk-0..7); the engine mirrors
// the east half for the west (src/render/anim.ts `facingDir`), so eight
// walkers on a ring, each sent straight out from the centre, put all eight
// sectors on screen at once. Same stage as feature-frog-walk.mjs, framed
// tighter (zoom 2.5, a 3-tile ring) so the sprite reads at 1280x720.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const CX = 10
const CY = 11
const RING = 0.9
// At zoom 2.5 the view is 4.5 tiles tall each side of the player and the
// sprite's head sits a tile above its position, so 3.0 keeps the north walker
// whole.
const REACH = 3.0

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

const walker = (id, dx, dy) => {
  const x = CX + dx * RING
  const y = CY + dy * RING
  return {
    id,
    kind: 'npc',
    archetype: 'cinder',
    pos: { x, y },
    prevPos: { x, y },
    vel: { x: 0, y: 0 },
    intent: { x: 0, y: 0 },
    // Slow enough that each 2-tile leg lasts a couple of seconds.
    speed: 1.5,
    radius: 0.35,
    facing: Math.atan2(dy, dx),
    health: { hp: 30, max: 30, iframes: 0 },
    combat: { weapon: 'fists', cooldown: 0 },
    status: { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 },
    ai: {
      mode: 'wander',
      faction: 'civ',
      home: { x, y },
      waypoint: { x: CX + dx * REACH, y: CY + dy * REACH },
      // Never re-decide: the utility layer would swap the scripted errand for
      // its own wander. This clip is about locomotion, so steering only.
      thinkAt: 1e9,
      sightRange: 6,
    },
  }
}

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: CX, y: CY }
  p.prevPos = { x: CX, y: CY }
  p.facing = Math.PI / 2
  p.health.hp = p.health.max
  const walkers = SECTORS.map(([, dx, dy], i) => walker(w.nextId + i, dx, dy))
  w.nextId += walkers.length
  w.entities = [p, ...walkers]
  return w
}

/**
 * Keep every walker pacing its sector: the frame after one arrives (steering
 * drops its waypoint and idles it), send it to the other end. Each walker shows
 * its sector outbound and the opposite one on the way home.
 */
const pace = (page) =>
  page.evaluate(
    ({ CX, CY, k }) => {
      const flip = () => {
        for (const e of window.__world.entities) {
          if (e.kind !== 'npc' || e.archetype !== 'cinder' || e.ai.waypoint) continue
          const { x, y } = e.ai.home
          const atHome = Math.hypot(e.pos.x - x, e.pos.y - y) < 0.5
          e.ai.waypoint = atHome ? { x: CX + (x - CX) * k, y: CY + (y - CY) * k } : { x, y }
          e.ai.mode = 'wander'
          e.ai.scanUntil = undefined
        }
        requestAnimationFrame(flip)
      }
      flip()
    },
    { CX, CY, k: REACH / RING },
  )

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  const sci = w.entities.filter((e) => e.kind === 'npc' && e.archetype === 'cinder' && !e.dead)
  return {
    tick: w.tick,
    walkers: sci.length,
    moved: sci.filter((e) => Math.hypot(e.pos.x - e.ai.home.x, e.pos.y - e.ai.home.y) > 0.5).length,
    facings: [...new Set(sci.map((e) => Math.round((e.facing / Math.PI) * 4)))].length,
    playerHurt: pl ? pl.health.hp < pl.health.max : null,
  }
}

const ok = await recordFeature({
  name: 'cinder-walk',
  world: stage(),
  params: { zoom: 2.5, theme: 'swampspace-hires' },
  stills: [
    { tick: 8, label: '00-ring', act: pace },
    { tick: 40, label: '01-walking-out' },
    { tick: 100, label: '02' },
    { tick: 160, label: '03' },
    { tick: 220, label: '04' },
    { tick: 280, label: '05' },
    { tick: 340, label: '06' },
    { tick: 420, label: '07-end' },
  ],
  readState,
  expect: (s) => [
    s.walkers !== 8 && `expected 8 walkers alive, got ${s.walkers}`,
    s.moved < 6 && `only ${s.moved}/8 walkers moved off the ring`,
    s.facings < 4 && `only ${s.facings} distinct facings; the ring collapsed`,
    s.playerHurt !== false && `player hurt or missing (${s.playerHurt}); this clip is about locomotion`,
  ],
})

process.exit(ok ? 0 : 1)
