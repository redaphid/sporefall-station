import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readDeepLink, overridesSave, wantsFreshBuild } from '../app/deepLink'
import { WEAPONS } from '../game/data/items'
import { hasFixture } from '../game/fixtures'
import { isSolidTile } from '../game/levelgen/level'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { expectWorldEqual } from '../game/testkit'
import type { SimEvent } from '../game/types'
import { tickWorld, type World } from '../game/world'
import { makeBot } from '../scenes/bot'
import { ENTRY_FILES, findPlayable, PLAYABLES } from './registry'
import { buildPlayWorld } from './start'
import { playHref, SECTIONS, shotPath, type Playable } from './types'

// Every scenario on the start menu's Test scenarios list: the registry is
// sound, every world boots the way `?play=<id>` boots it, replays identically
// from the same inputs, and plays the beat its card promises. The demo bot is
// the same one the screenshot capture drives (scripts/playable/capture.mjs),
// so the picture on the card is a tick of the run asserted here.

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url))
const GENERATORS = readdirSync(fileURLToPath(new URL('../../scripts/playable/', import.meta.url)))
  .filter((f) => f.endsWith('.mts') && f !== 'lib.mts')
  .map((f) => f.replace(/\.mts$/, ''))

const player = (w: World) => w.entities.find((e) => e.playerCtl)!

/** Drive a scenario with its demo bot for `n` ticks, collecting every event. */
const run = (p: Playable, n: number, w: World = buildPlayWorld(p.start)): { w: World; events: SimEvent[]; ticks: { t: number; w: World }[] } => {
  const bot = makeBot(p.demo ?? { range: 0 })
  const events: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, bot(w)]]))
    events.push(...w.events)
  }
  return { w, events, ticks: [] }
}

/** Run, calling `each` after every tick (for per-tick observations). */
const watch = (p: Playable, n: number, each: (w: World) => void): World => {
  const w = buildPlayWorld(p.start)
  const bot = makeBot(p.demo ?? { range: 0 })
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, bot(w)]]))
    each(w)
  }
  return w
}

const entry = (id: string): Playable => {
  const p = findPlayable(id)
  if (!p) throw new Error(`no playable ${id}`)
  return p
}

describe('the playable registry', () => {
  it('has unique kebab-case ids, each matching its entry file', () => {
    const ids = PLAYABLES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(10)
    for (const { file, entry: p } of ENTRY_FILES) {
      expect(p.id, file).toBe(file)
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('gives every card a title, subtitle, what it tests, what to look for, tags and a known section', () => {
    for (const p of PLAYABLES) {
      for (const text of [p.title, p.subtitle, p.tests, p.lookFor]) expect(text.trim().length, p.id).toBeGreaterThan(0)
      expect(p.subtitle.length, `${p.id}: a subtitle is one short line`).toBeLessThanOrEqual(60)
      expect(p.tags.length, p.id).toBeGreaterThan(0)
      expect(Object.keys(SECTIONS), p.id).toContain(p.section)
      expect(Number.isInteger(p.shot.tick) && p.shot.tick >= 0, p.id).toBe(true)
    }
  })

  it('lists sections in order, New today first', () => {
    const order = Object.keys(SECTIONS)
    const seen = PLAYABLES.map((p) => order.indexOf(p.section))
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })

  it('ships a screenshot for every card, and nothing else in public/playable', () => {
    for (const p of PLAYABLES) expect(existsSync(PUBLIC + shotPath(p.id)), `${p.id}: run scripts/playable/capture.mjs ${p.id}`).toBe(true)
    const files = readdirSync(PUBLIC + 'playable').sort()
    expect(files).toEqual(PLAYABLES.map((p) => `${p.id}.webp`).sort())
  })

  it('names a shipped fixture for every fixture start, and a registry entry for every authored-world generator', () => {
    for (const p of PLAYABLES) if (p.start.kind === 'fixture') expect(hasFixture(p.start.fixture), p.id).toBe(true)
    const fixtures = PLAYABLES.flatMap((p) => (p.start.kind === 'fixture' ? [p.start.fixture] : []))
    for (const g of GENERATORS) expect(fixtures, `scripts/playable/${g}.mts writes a world no entry plays`).toContain(g)
  })

  it('links each card to ?play=<id>, relative to the page, and that link overrides the save', () => {
    expect(playHref('quickdraw')).toBe('./?play=quickdraw')
    expect(new URL(playHref('wall-kill'), 'https://x.test/betas/test-scenarios/').href).toBe(
      'https://x.test/betas/test-scenarios/?play=wall-kill',
    )
    const link = readDeepLink(new URLSearchParams('play=quickdraw'))
    expect(link.play).toBe('quickdraw')
    expect(overridesSave(link)).toBe(true)
    expect(wantsFreshBuild(link)).toBe(true)
    expect(findPlayable('no-such-scenario')).toBeUndefined()
    expect(findPlayable('__proto__')).toBeUndefined()
  })
})

describe.each(PLAYABLES.map((p) => [p.id, p] as const))('playable %s', (_id, p) => {
  it('boots into one player on open ground', () => {
    const w = buildPlayWorld(p.start)
    const players = w.entities.filter((e) => e.playerCtl)
    expect(players).toHaveLength(1)
    for (const e of w.entities) {
      if (e.kind !== 'npc' && e.kind !== 'player') continue
      const tx = Math.floor(e.pos.x)
      const ty = Math.floor(e.pos.y)
      expect(isSolidTile(w.level, tx, ty), `${e.archetype}#${e.id} inside a wall at ${tx},${ty}`).toBe(false)
    }
    expect(players[0].combat?.weapon).toBeTruthy()
  })

  it('builds the same world every time, and survives the save round trip ?play= takes', () => {
    const a = buildPlayWorld(p.start)
    expectWorldEqual(a, buildPlayWorld(p.start))
    const json = serializeWorld(a)
    expect(serializeWorld(deserializeWorld(JSON.parse(JSON.stringify(json))))).toEqual(json)
  })

  it('replays its demo identically, through the screenshot tick and past it, and a mid-run save-and-reload changes nothing', () => {
    const n = p.shot.tick + 90
    const a = run(p, n).w
    expectWorldEqual(a, run(p, n).w)
    const half = Math.floor(n / 2)
    const split = run(p, half).w
    // The bot keeps a little state (its route leg), so the resumed half is
    // compared against a straight run with a fresh bot from the same tick.
    const resumed = run(p, n - half, deserializeWorld(serializeWorld(split))).w
    const straight = run(p, n - half, run(p, half).w).w
    expect(serializeWorld(resumed)).toEqual(serializeWorld(straight))
  })
})

describe('each New today scenario plays the beat its card promises', () => {
  it('quickdraw: every diver that engages holds fire for its 16-tick draw', () => {
    const p = entry('quickdraw')
    const engagedAt = new Map<number, number>()
    const firstShot = new Map<number, number>()
    const prevMode = new Map<number, string | undefined>()
    const prevCd = new Map<number, number>()
    watch(p, 220, (w) => {
      for (const e of w.entities) {
        if (e.archetype !== 'drowner' || e.dead) continue
        const t = w.tick - 1
        if (e.ai?.mode === 'aggro' && prevMode.get(e.id) !== 'aggro' && !engagedAt.has(e.id)) engagedAt.set(e.id, t)
        const cd = e.combat?.cooldown ?? 0
        if (cd > (prevCd.get(e.id) ?? 0) && !firstShot.has(e.id)) firstShot.set(e.id, t)
        prevMode.set(e.id, e.ai?.mode)
        prevCd.set(e.id, cd)
      }
    })
    expect(engagedAt.size, 'at least two divers spot the player').toBeGreaterThanOrEqual(2)
    for (const [id, t] of engagedAt) {
      const shot = firstShot.get(id)
      if (shot !== undefined) expect(shot - t, `drowner#${id}`).toBeGreaterThanOrEqual(16)
    }
    expect(firstShot.size, 'somebody gets a shot off').toBeGreaterThan(0)
    // The card's picture lands inside a draw: some diver engaged at most 16 ticks before it.
    expect([...engagedAt.values()].some((t) => p.shot.tick >= t && p.shot.tick < t + 16)).toBe(true)
  })

  it('hard-hits: shotgun volleys kill the sleepers one by one, the first just before the picture', () => {
    const p = entry('hard-hits')
    const { events, w } = run(p, 120)
    const deaths = events.filter((e) => e.type === 'death')
    expect(deaths.length).toBeGreaterThanOrEqual(4)
    expect(player(w).health!.hp).toBe(player(w).health!.max)
    expect(player(w).combat!.weapon).toBe('scatterFunnel')
  })

  it('hard-hits: a kill lands within 10 ticks before the screenshot tick', () => {
    const p = entry('hard-hits')
    const deathTicks: number[] = []
    watch(p, p.shot.tick, (w) => {
      if (w.events.some((e) => e.type === 'death')) deathTicks.push(w.tick - 1)
    })
    expect(deathTicks.some((t) => p.shot.tick - t > 0 && p.shot.tick - t <= 10)).toBe(true)
  })

  it('wall-kill: all three die standing against the east bulkhead', () => {
    const p = entry('wall-kill')
    const { events, w } = run(p, 200)
    const deaths = events.filter((e): e is Extract<SimEvent, { type: 'death' }> => e.type === 'death')
    expect(deaths).toHaveLength(3)
    for (const d of deaths) expect(isSolidTile(w.level, Math.floor(d.x) + 1, Math.floor(d.y)), `death at ${d.x},${d.y}`).toBe(true)
  })

  it('grenade-cluster: one throw, one explosion, four deaths on the same tick', () => {
    const p = entry('grenade-cluster')
    const perTick: { explosions: number; deaths: number }[] = []
    watch(p, 100, (w) =>
      perTick.push({
        explosions: w.events.filter((e) => e.type === 'explosion').length,
        deaths: w.events.filter((e) => e.type === 'death').length,
      }),
    )
    const blast = perTick.findIndex((t) => t.explosions > 0)
    expect(perTick.filter((t) => t.explosions > 0)).toHaveLength(1)
    expect(perTick[blast].deaths).toBe(4)
    expect(p.shot.tick - blast).toBeGreaterThan(0)
    expect(p.shot.tick - blast, "the bodies are still in the air").toBeLessThanOrEqual(16)
  })

  it('skid-lane: the demo sprints and stops dead in four directions, and the picture is a stop', () => {
    const p = entry('skid-lane')
    const stops: number[] = []
    let moving = false
    let prev = { x: 0, y: 0 }
    const w = watch(p, 520, (w) => {
      const me = player(w)
      const v = Math.hypot(me.pos.x - prev.x, me.pos.y - prev.y)
      if (moving && v < 0.01) stops.push(w.tick - 1)
      moving = v > 0.1
      prev = { ...me.pos }
    })
    expect(stops.length, `stops ${stops}`).toBeGreaterThanOrEqual(4)
    expect(stops.some((t) => p.shot.tick >= t && p.shot.tick - t <= 6), `stops ${stops}`).toBe(true)
    expect(w.entities.filter((e) => e.kind === 'npc')).toHaveLength(0)
  })

  it('cast-parade: twelve walkers pace their lanes for a minute and nobody turns on the player', () => {
    const p = entry('cast-parade')
    const minX = new Map<number, number>()
    const maxX = new Map<number, number>()
    let aggro = false
    const w = watch(p, 1800, (w) => {
      for (const e of w.entities) {
        if (e.kind !== 'npc') continue
        if (e.ai?.mode === 'aggro') aggro = true
        minX.set(e.id, Math.min(minX.get(e.id) ?? Infinity, e.pos.x))
        maxX.set(e.id, Math.max(maxX.get(e.id) ?? -Infinity, e.pos.x))
      }
    })
    const cast = w.entities.filter((e) => e.kind === 'npc')
    expect(cast).toHaveLength(12)
    expect(aggro).toBe(false)
    expect(cast.every((e) => !e.dead)).toBe(true)
    for (const e of cast) expect(maxX.get(e.id)! - minX.get(e.id)!, `${e.archetype} walked its lane`).toBeGreaterThan(6)
    expect(player(w).health!.hp).toBe(player(w).health!.max)
  })

  it('hive-spire: the spire buds a mite at the player standing near it, before the picture', () => {
    const p = entry('hive-spire')
    const buds: number[] = []
    watch(p, 200, (w) => {
      if (w.events.some((e) => e.type === 'hiveSpawn')) buds.push(w.tick - 1)
    })
    expect(buds.length).toBeGreaterThan(0)
    expect(buds[0]).toBeLessThan(p.shot.tick)
    expect(p.shot.tick - buds[0]).toBeLessThanOrEqual(8)
  })

  it('drowner-reel: the divers soak hits at range without dying, and one is hit just before the picture', () => {
    const p = entry('drowner-reel')
    const hitTicks: number[] = []
    const w = watch(p, 150, (w) => {
      for (const e of w.events) if (e.type === 'hit' && w.byId.get(e.targetId)?.archetype === 'drowner') hitTicks.push(w.tick - 1)
    })
    expect(hitTicks.length).toBeGreaterThanOrEqual(4)
    expect(w.entities.filter((e) => e.archetype === 'drowner' && !e.dead)).toHaveLength(3)
    expect(hitTicks.some((t) => p.shot.tick > t && p.shot.tick - t <= 6)).toBe(true)
  })

  it('beasts-bite: the beasts close and bite the player, every one armed by nature', () => {
    const p = entry('beasts-bite')
    const w0 = buildPlayWorld(p.start)
    for (const e of w0.entities.filter((e) => e.kind === 'npc'))
      expect(WEAPONS[e.combat!.weapon]?.natural, `${e.archetype} wields ${e.combat!.weapon}`).toBe(true)
    const bitten: number[] = []
    const w = watch(p, 200, (w) => {
      if (w.events.some((e) => e.type === 'hit' && w.byId.get(e.targetId)?.playerCtl)) bitten.push(w.tick - 1)
    })
    expect(bitten.length).toBeGreaterThan(3)
    expect(bitten[0]).toBeLessThanOrEqual(p.shot.tick)
    expect(player(w).dead ?? false).toBe(false)
  })

  it('props-room: the eight regenerated props stand in one quiet room', () => {
    const p = entry('props-room')
    const { w } = run(p, 300)
    const props = new Set(w.entities.filter((e) => e.kind === 'interactable').map((e) => e.archetype))
    for (const a of ['vending', 'cryoTerminal', 'tv', 'locker', 'cabinet', 'toilet', 'desk', 'bench']) expect(props, a).toContain(a)
    expect(w.entities.filter((e) => e.kind === 'npc')).toHaveLength(0)
    expect(player(w).health!.hp).toBe(player(w).health!.max)
  })

  it('rivet-driver-mods: the modded Rivet Driver freezes, burns or shocks what it hits, by the picture', () => {
    const p = entry('rivet-driver-mods')
    const { w } = run(p, p.shot.tick)
    const gun = player(w).loadout!.inventory[0]
    expect(gun.itemId).toBe('rivetDriver')
    expect(gun.mods!.map((m) => m.id)).toEqual(['frost', 'incendiary', 'shock', 'homing', 'heavy'])
    const struck = w.entities.filter((e) => e.archetype === 'mutant' && e.fx && ['frozen', 'burning', 'electrified'].some((k) => k in e.fx!))
    expect(struck.length).toBeGreaterThan(0)
  })
})
