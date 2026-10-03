import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unknownWorldMessage } from '../app/deepLink'
import { hasFixture, loadFixture, loadFixtureJson } from '../game/fixtures'
import { isSolidTile } from '../game/levelgen/level'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { expectWorldEqual } from '../game/testkit'
import type { SimEvent } from '../game/types'
import { tickWorld, type World } from '../game/world'
import { makeBot, runBot, type BotPlan } from './bot'
import { sceneHref, SCENES } from './registry'

// Every crafted scene on /scenes.html: the registry, its fixture and its
// generator agree; each loads the way `/?world=<name>` loads it; each saves
// back to itself and replays identically; and each one plays. The "plays"
// cases drive the real systems with a scripted player (./bot.ts) and assert the
// beat the gallery card promises.

const NAMES = SCENES.map((s) => s.name)
const GENERATORS = readdirSync(fileURLToPath(new URL('../../scripts/saves/', import.meta.url)))
  .filter((f) => f.endsWith('.mts') && f !== 'lib.mts')
  .map((f) => f.replace(/\.mts$/, ''))

/** What main.ts does for `?world=<name>`: check, read, rehydrate. */
const bootWorld = (name: string): World => {
  if (!hasFixture(name)) throw new Error(`no such fixture: ${name}`)
  return deserializeWorld(loadFixtureJson(name))
}

const thePlayer = (w: World) => w.entities.find((e) => e.playerCtl)
const live = (w: World, archetype: string) => w.entities.filter((e) => e.archetype === archetype && !e.dead)

/** Run a bot and collect every event it caused, tick-stamped. */
const play = (w: World, ticks: number, plan: BotPlan, until?: (w: World) => boolean): SimEvent[] => {
  const bot = makeBot(plan)
  const seen: SimEvent[] = []
  for (let i = 0; i < ticks; i++) {
    tickWorld(w, new Map([[0, bot(w)]]))
    seen.push(...w.events)
    if (until?.(w)) break
  }
  return seen
}
const count = (events: SimEvent[], type: SimEvent['type']) => events.filter((e) => e.type === type).length
const ids = (w: World, archetype: string) => live(w, archetype).map((e) => e.id)

describe('the scene registry', () => {
  it('names each scene once, with a title, hook, try line and tags', () => {
    expect(new Set(NAMES).size).toBe(NAMES.length)
    expect(NAMES.length).toBeGreaterThanOrEqual(6)
    for (const s of SCENES) {
      expect(s.name, s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      for (const text of [s.title, s.hook, s.tryThis]) expect(text.trim().length, s.name).toBeGreaterThan(0)
      expect(s.tags.length, s.name).toBeGreaterThan(0)
    }
  })

  it('has a fixture for every scene, and a scene for every generator', () => {
    for (const name of NAMES) expect(hasFixture(name), `${name} has no fixture`).toBe(true)
    expect([...GENERATORS].sort(), 'scripts/saves/*.mts and the registry disagree').toEqual([...NAMES].sort())
  })

  it('links each card to its own ?world= save, relative to the page', () => {
    for (const name of NAMES) expect(sceneHref(name)).toBe(`./?world=${name}`)
    expect(new URL(sceneHref('castle-siege'), 'https://x.test/betas/pr-9/scenes.html').href).toBe(
      'https://x.test/betas/pr-9/?world=castle-siege',
    )
  })
})

describe('an unknown ?world= name', () => {
  it('is not a fixture, cannot be read, and gets a message naming it and the real scenes', () => {
    for (const bad of ['no-such-scene', '', 'castle-siege.json', '../package', '__proto__', 'constructor', 'CASTLE-SIEGE']) {
      expect(hasFixture(bad), JSON.stringify(bad)).toBe(false)
      expect(() => bootWorld(bad), JSON.stringify(bad)).toThrow(/no such fixture/)
    }
    const msg = unknownWorldMessage('no-such-scene', NAMES, '999')
    expect(msg).toContain('"no-such-scene"')
    expect(msg).toContain('999')
    for (const name of NAMES) expect(msg).toContain(name)
  })
})

describe.each(NAMES)('scene %s', (name) => {
  it('boots through the ?world= path into one player on open ground, an authored level and a live cast', () => {
    const json = loadFixtureJson(name)
    expect(json.levelChecksum, 'authored, not seed+floor').toBeUndefined()
    expect(json.level?.rows.length).toBeGreaterThan(0)
    const w = bootWorld(name)
    const players = w.entities.filter((e) => e.playerCtl)
    expect(players).toHaveLength(1)
    expect(w.entities.some((e) => e.kind === 'npc' && !e.dead), 'something to play against').toBe(true)
    for (const e of w.entities) {
      if (e.kind !== 'npc' && e.kind !== 'player') continue
      const tx = Math.floor(e.pos.x)
      const ty = Math.floor(e.pos.y)
      expect(isSolidTile(w.level, tx, ty), `${e.archetype}#${e.id} inside a wall at ${tx},${ty}`).toBe(false)
    }
    const [p] = players
    expect(p.combat?.weapon).toBe(p.loadout?.inventory[0].itemId)
  })

  it('saves back to its fixture byte for byte, at load and mid-play', () => {
    expect(JSON.stringify(serializeWorld(loadFixture(name)))).toBe(JSON.stringify(loadFixtureJson(name)))
    const w = runBot(loadFixture(name), 120, {})
    const mid = JSON.stringify(serializeWorld(w))
    expect(JSON.stringify(serializeWorld(deserializeWorld(JSON.parse(mid))))).toBe(mid)
  })

  it('replays identically from the same inputs, and a save-and-reload mid-run changes nothing', () => {
    const a = runBot(loadFixture(name), 300, {})
    const b = runBot(loadFixture(name), 300, {})
    expectWorldEqual(a, b)
    const split = runBot(loadFixture(name), 150, {})
    const resumed = runBot(deserializeWorld(serializeWorld(split)), 150, {})
    expect(serializeWorld(resumed)).toEqual(serializeWorld(a))
  })

  it('gives the player at least three seconds standing still before anything can down them', () => {
    const w = loadFixture(name)
    for (let i = 0; i < 90; i++) tickWorld(w, new Map())
    expect(thePlayer(w)?.playerCtl?.downed ?? false).toBe(false)
    expect(w.gameOver).toBe(false)
  })
})

describe('each scene plays the beat its card promises', () => {
  it('pillared-hall: fighting through the colonnade reaches the exit', () => {
    const w = loadFixture('pillared-hall')
    play(w, 1200, { route: [{ x: 12, y: 11.5 }, { x: 36, y: 9 }, { x: 42, y: 8.5 }, { x: 43.5, y: 11.5 }, { x: 47.5, y: 11.5 }] }, (w) => w.floor === 2)
    expect(w.floor).toBe(2)
  })

  it('cut-the-head: dropping the Bellwether routs the raid', () => {
    const w = loadFixture('cut-the-head')
    const events = play(w, 900, { focus: ids(w, 'bellwether') }, () => live(w, 'bellwether').length === 0 && w.groups?.list.length === 0)
    const routed = events.filter((e) => e.type === 'raidRouted')
    expect(routed.length).toBe(1)
    expect(routed[0]).toMatchObject({ reason: 'leader' })
    expect(thePlayer(w)?.playerCtl?.downed).toBeFalsy()
  })

  it('blackout-run: the door holds until the generator is cut, then opens onto the exit', () => {
    const blocked = loadFixture('blackout-run')
    const door = blocked.entities.find((e) => e.door)!
    play(blocked, 400, { route: [{ x: 52, y: 14 }, { x: 57.5, y: 14.5 }], use: [door.id], spare: ['thug', 'gangster', 'brute', 'robot'] })
    expect(door.door).toMatchObject({ locked: true, open: false })
    expect(blocked.floor).toBe(1)

    const w = loadFixture('blackout-run')
    const use = [...ids(w, 'generator'), w.entities.find((e) => e.door)!.id]
    const route = [
      { x: 8, y: 14 },
      { x: 39.5, y: 14 },
      { x: 39.5, y: 5 },
      { x: 38.5, y: 4.3 },
      { x: 39.5, y: 9 },
      { x: 39.5, y: 14 },
      { x: 52, y: 14 },
      { x: 57.5, y: 14.5 },
    ]
    const events = play(w, 900, { route, use, spare: ['thug', 'gangster', 'brute', 'robot'] }, (w) => w.floor === 2)
    expect(count(events, 'powerCut')).toBe(1)
    expect(count(events, 'sealOpen')).toBe(1)
    expect(w.floor).toBe(2)
  })

  it('mireclaw-den: the Alpha reveals itself, broods, and can be killed, which opens the exit', () => {
    const w = loadFixture('mireclaw-den')
    const boss = ids(w, 'boss')
    const events = play(w, 3000, { route: [{ x: 21, y: 30 }], focus: boss }, (w) => w.mission.complete)
    expect(count(events, 'bossReveal')).toBe(1)
    expect(events.some((e) => e.type === 'death')).toBe(true)
    expect(w.mission).toMatchObject({ complete: true, exitUnlocked: true })
    expect(w.gameOver).toBe(false)
  })

  it('tide-and-thunder: the tide comes in, shock arcs, and the packs fall', () => {
    const w = loadFixture('tide-and-thunder')
    const hounds = live(w, 'gloamhound').length
    const events = play(w, 900, {})
    expect(count(events, 'tide')).toBeGreaterThan(0)
    expect(count(events, 'shock')).toBeGreaterThan(5)
    // A straggler can hang back out of sight of a player who never moves.
    expect(live(w, 'gloamhound').length).toBeLessThanOrEqual(hounds - 13)
    expect(w.gameOver).toBe(false)
  })

  it('crossfire: cops and gang kill each other while the player only watches', () => {
    const w = loadFixture('crossfire')
    const before = { cop: live(w, 'cop').length, gang: live(w, 'gangster').length + live(w, 'thug').length }
    for (let i = 0; i < 1200; i++) tickWorld(w, new Map())
    expect(live(w, 'cop').length).toBeLessThan(before.cop)
    expect(live(w, 'gangster').length + live(w, 'thug').length).toBeLessThan(before.gang)
    expect(thePlayer(w)?.health?.hp).toBe(thePlayer(w)?.health?.max)
  })

  it('barracks-blaze: one row alight burns down most of the sleeping gang', () => {
    const w = loadFixture('barracks-blaze')
    const sleepers = w.entities.filter((e) => e.kind === 'npc' && (e.status?.sleep ?? 0) > 0).map((e) => e.id)
    let peakFires = 0
    const bot = makeBot({ route: [{ x: 9.5, y: 12.5 }] })
    for (let i = 0; i < 900; i++) {
      tickWorld(w, new Map([[0, bot(w)]]))
      peakFires = Math.max(peakFires, w.entities.filter((e) => e.kind === 'fire' && !e.spore && !e.dead).length)
    }
    expect(peakFires).toBeGreaterThan(20)
    expect(sleepers.filter((id) => w.byId.get(id)?.dead !== false).length).toBeGreaterThanOrEqual(5)
    expect(thePlayer(w)?.playerCtl?.downed).toBeFalsy()
  })

  it('hive-cavern: the spires bud at the player, who can still run the swarm to the north shaft', () => {
    const w = loadFixture('hive-cavern')
    const route = [{ x: 22.5, y: 32 }, { x: 19.5, y: 27 }, { x: 19.5, y: 8 }, { x: 22.5, y: 6.5 }]
    const events = play(w, 900, { route }, (w) => w.floor === 2)
    expect(count(events, 'hiveSpawn')).toBeGreaterThan(0)
    expect(w.floor).toBe(2)
  })
})
