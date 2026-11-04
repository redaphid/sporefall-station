// Each body moves the way its ART is drawn (fix/locomotion-by-kind), on the
// default swampspace-hires pack. Top row, standing: spore-drone (warden) and
// gloom-lurker float, brood-sac (pod) pulses, sporeling-mite and the
// frog-settler only breathe. Below it a spore-drone paces east-west, floating
// harder and taking no steps; below the player a frog-settler paces on its
// drawn 8-frame walk with no procedural bob on top. Staging follows
// feature-scientist-walk.mjs: NPC brains off, speed halved, a rAF loop resends
// each pacer to the other end.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const CX = 10
const CY = 11
const ROW = ['warden', 'lurker', 'pod', 'sporeling', 'civilian']
const PACERS = [
  ['warden', 10],
  ['civilian', 12.6],
]
const ROW_Y = 8.8
const LEFT = 7
const RIGHT = 13

const body = (id, archetype, x, y, waypoint) => ({
  id,
  kind: 'npc',
  archetype,
  pos: { x, y },
  prevPos: { x, y },
  vel: { x: 0, y: 0 },
  intent: { x: 0, y: 0 },
  speed: 1.5,
  radius: 0.35,
  facing: Math.PI / 2,
  health: { hp: 30, max: 30, iframes: 0 },
  combat: { weapon: 'fists', cooldown: 0 },
  status: { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 },
  ai: {
    mode: waypoint ? 'wander' : 'idle',
    faction: 'civ',
    home: { x, y },
    ...(waypoint ? { waypoint } : {}),
    thinkAt: 1e9,
    sightRange: 6,
  },
})

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: CX, y: CY }
  p.prevPos = { x: CX, y: CY }
  p.facing = Math.PI / 2
  p.health.hp = p.health.max
  let id = w.nextId
  const row = ROW.map((a, i) => body(id++, a, 8 + i, ROW_Y))
  const pacers = PACERS.map(([a, y]) => body(id++, a, LEFT, y, { x: RIGHT, y }))
  w.nextId = id
  w.entities = [p, ...row, ...pacers]
  return w
}

/** The frame after a pacer arrives (steering drops its waypoint), send it back. */
const pace = (page) =>
  page.evaluate(
    ({ LEFT, RIGHT, ROW_Y }) => {
      const flip = () => {
        for (const e of window.__world.entities) {
          if (e.kind !== 'npc' || e.ai.home.y === ROW_Y || e.ai.waypoint) continue
          const x = Math.abs(e.pos.x - LEFT) < 0.5 ? RIGHT : LEFT
          e.ai.waypoint = { x, y: e.ai.home.y }
          e.ai.mode = 'wander'
          e.ai.scanUntil = undefined
          window.__paceFlips = (window.__paceFlips ?? 0) + 1
        }
        requestAnimationFrame(flip)
      }
      flip()
    },
    { LEFT, RIGHT, ROW_Y },
  )

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  const npcs = w.entities.filter((e) => e.kind === 'npc' && !e.dead)
  return {
    tick: w.tick,
    cast: npcs.map((e) => e.archetype).sort().join(),
    rowStill: npcs.filter((e) => e.ai.home.y === 8.8 && Math.hypot(e.pos.x - e.ai.home.x, e.pos.y - e.ai.home.y) < 0.1).length,
    paceFlips: window.__paceFlips ?? 0,
    playerHurt: pl ? pl.health.hp < pl.health.max : null,
  }
}

const ok = await recordFeature({
  name: 'locomotion-by-kind',
  world: stage(),
  params: { zoom: 2.5, theme: 'swampspace-hires' },
  stills: [
    { tick: 8, label: '00-start', act: pace },
    { tick: 60, label: '01' },
    { tick: 150, label: '02' },
    { tick: 300, label: '03' },
    { tick: 420, label: '04-end' },
  ],
  readState,
  expect: (s) => [
    s.cast !== 'civilian,civilian,warden,warden,lurker,pod,sporeling' && `cast changed: ${s.cast}`,
    s.rowStill !== 5 && `only ${s.rowStill}/5 of the standing row stayed put`,
    s.paceFlips < 4 && `pacers turned around only ${s.paceFlips} times; they did not cross`,
    s.playerHurt !== false && `player hurt or missing (${s.playerHurt})`,
  ],
})

process.exit(ok ? 0 : 1)
