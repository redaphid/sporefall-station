// The held-weapon overlay at play zoom: the player and two drowned divers hold
// pistols, a gloam hound and a carapace brute stand with them. Each NPC is armed
// from its archetype row in src/game/data/npcs.ts as checked out, so the same
// script records the old look on main (hound with a knife, brute with a wrench,
// pistols half a body long) and the fixed one (hand-sized pistols, beasts bare).
// Brains are off and everyone is civ, so nothing fires; the player turns to aim
// east, south and west so the overlay shows in three poses.
//
//   E2E_THEME=swampspace ./e2e/run-features.sh weapon-overlay   # the base pack
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const npcsSrc = readFileSync(join(__dirname, '../src/game/data/npcs.ts'), 'utf8')
const THEME = process.env.E2E_THEME ?? 'swampspace-hires'

/** The archetype's table weapon, read from the checked-out npcs.ts. */
const tableWeapon = (arch) => {
  const m = npcsSrc.match(new RegExp(`archetype: '${arch}',[\\s\\S]*?weapon: '([^']+)'`))
  if (!m) throw new Error(`no weapon row for ${arch}`)
  return m[1]
}

const CX = 10
const CY = 11

const npc = (id, archetype, dx, dy, facing) => {
  const x = CX + dx
  const y = CY + dy
  return {
    id,
    kind: 'npc',
    archetype,
    pos: { x, y },
    prevPos: { x, y },
    vel: { x: 0, y: 0 },
    intent: { x: 0, y: 0 },
    speed: 0,
    radius: 0.35,
    facing,
    health: { hp: 30, max: 30, iframes: 0 },
    combat: { weapon: tableWeapon(archetype), cooldown: 0 },
    status: { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 },
    ai: { mode: 'idle', faction: 'civ', home: { x, y }, thinkAt: 1e9, sightRange: 1 },
  }
}

const CAST = [
  ['drowner', -1.6, -0.2, 0],
  ['drowner', 1.6, -0.2, Math.PI],
  ['gloamhound', -1.4, 1.6, 0],
  ['brute', 1.6, 1.7, Math.PI],
]

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: CX, y: CY }
  p.prevPos = { x: CX, y: CY }
  p.facing = 0
  p.health.hp = p.health.max
  const cast = CAST.map(([arch, dx, dy, f], i) => npc(w.nextId + i, arch, dx, dy, f))
  w.nextId += cast.length
  w.entities = [p, ...cast]
  return w
}

const aim = (angle) => (page) =>
  page.evaluate((a) => {
    // One loop, re-aimed by each still: input would overwrite a one-off facing.
    const first = window.__aim === undefined
    window.__aim = a
    if (!first) return
    const hold = () => {
      const p = window.__world.entities.find((e) => e.playerCtl)
      if (p) p.facing = window.__aim
      requestAnimationFrame(hold)
    }
    hold()
  }, angle)

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  const npcs = w.entities.filter((e) => e.kind === 'npc' && !e.dead)
  return {
    tick: w.tick,
    cast: npcs.length,
    weapons: Object.fromEntries(npcs.map((e) => [`${e.archetype}#${e.id}`, e.combat.weapon])),
    playerHurt: pl ? pl.health.hp < pl.health.max : null,
  }
}

const ok = await recordFeature({
  name: `weapon-overlay-${THEME}`,
  world: stage(),
  params: { zoom: 3, theme: THEME },
  stills: [
    { tick: 20, label: '01-aim-east', act: aim(0) },
    { tick: 60, label: '02-aim-south', act: aim(Math.PI / 2) },
    { tick: 100, label: '03-aim-west', act: aim(Math.PI) },
  ],
  readState,
  expect: (s) => [
    s.cast !== CAST.length && `expected ${CAST.length} cast alive, got ${s.cast}`,
    s.playerHurt !== false && `player hurt or missing (${s.playerHurt}); nobody should fire`,
  ],
})

process.exit(ok ? 0 : 1)
