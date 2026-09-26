// The playtest surface for reactive wands (Design B): `step` takes the wand's
// player actions as `swap` / `eject` sugar over the real `modSwap` InputCmd
// field, counts reactions by name, `look` shows the wand, and `addMod` adds one
// chip per entry. Everything goes through runVerb and the real tickWorld.

import { describe, expect, it } from 'vitest'
import { makeEntity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { applyScenario } from '../game/scenarios'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { packModSwap } from '../game/systems/modSequence'
import { equipSlot, weaponStack } from '../game/systems/inventory'
import { wet } from '../game/systems/interactions'
import { emptyInput } from '../game/types'
import { addEntity, createWorld, tickWorld, type World } from '../game/world'
import { HostSession } from '../app/hostSession'
import { heldCmd, parseHeldInput, runVerb } from './verbs'

const arena = (reactive = true): { w: World; pid: number } => {
  const w = createWorld(1, 1)
  if (reactive) w.modCasting = 'reactive'
  const p = spawnPlayer(w, 0, 20, 20)
  equipSlot(p, 0)
  return { w, pid: p.id }
}
const order = (w: World, pid: number): string[] => weaponStack(w.byId.get(pid)!)!.mods!.map((m) => m.id)

describe('step: swap / eject sugar compiles to the real modSwap field, first tick only', () => {
  it('"eject":i is packModSwap(i, i) on tick 0 and absent after', () => {
    const { w } = arena()
    const h = parseHeldInput(w, '{"eject":2,"attack":true}')
    expect(heldCmd(w, h, 0).modSwap).toBe(packModSwap(2, 2))
    expect(heldCmd(w, h, 1).modSwap).toBeUndefined()
    expect(heldCmd(w, h, 1).attack).toBe(true)
  })

  it('"swap":[a,b] is packModSwap(a, b)', () => {
    const { w } = arena()
    expect(heldCmd(w, parseHeldInput(w, '{"swap":[0,3]}'), 0).modSwap).toBe(packModSwap(0, 3))
  })

  it('is byte-identical to tickWorld fed the packed field directly', () => {
    const a = arena()
    const b = arena()
    for (const x of [a, b]) for (const m of ['soak', 'shock', 'heavy']) runVerb(x.w, `addMod ${x.pid} ${m}`)
    runVerb(a.w, 'step 3 {"eject":1}')
    for (let i = 0; i < 3; i++) tickWorld(b.w, new Map([[0, { ...emptyInput(), seq: i, ...(i === 0 ? { modSwap: packModSwap(1, 1) } : {}) }]]))
    expect(serializeWorld(a.w)).toEqual(serializeWorld(b.w))
    expect(order(a.w, a.pid)).toEqual(['soak', 'heavy'])
  })

  it.each([
    ['{"swap":[1,1]}', /two different entries/],
    ['{"swap":[1]}', /must be \[a, b\]/],
    ['{"swap":"0,1"}', /must be \[a, b\]/],
    ['{"eject":256}', /0\.\.255/],
    ['{"eject":-1}', /0\.\.255/],
    ['{"eject":1.5}', /0\.\.255/],
    ['{"eject":1,"swap":[0,1]}', /only one of/],
    ['{"eject":1,"modSwap":3}', /only one of/],
  ])('rejects %s', (json, err) => {
    const { w } = arena()
    expect(() => parseHeldInput(w, json)).toThrow(err)
  })
})

describe('step reply names reactions; look shows the wand', () => {
  it('counts reaction:chain when a Shock round lands on a wet body', () => {
    const { w, pid } = arena()
    for (const m of ['shock']) runVerb(w, `addMod ${pid} ${m}`)
    const t = addEntity(w, makeEntity('npc', 'civilian', 20, 23))
    t.health = { hp: 100, max: 100, iframes: 0 }
    wet(w, t)
    const r = JSON.parse(runVerb(w, `step 20 {"aimAt":${t.id},"attack":true}`)) as { events: Record<string, number> }
    expect(r.events['reaction:chain']).toBe(1)
    expect(r.events.reaction).toBeUndefined()
  })

  it('look lists every entry by the index swap/eject take, the pocket, and the next pull', () => {
    const { w, pid } = arena()
    for (const m of ['frost', 'incendiary', 'shock', 'heavy', 'soak']) runVerb(w, `addMod ${pid} ${m}`)
    const seen = JSON.parse(runVerb(w, 'look')) as { player: { wand: { entries: string[]; capacity: number; nextPull: string[] } } }
    expect(seen.player.wand.entries).toEqual(['0:frost', '1:incendiary', '2:shock', '3:heavy', '4:soak (pocket)'])
    expect(seen.player.wand.capacity).toBe(6)
    expect(seen.player.wand.nextPull).toEqual(['frost'])
  })

  it('look marks an ejected chip arming, then armed', () => {
    const { w, pid } = arena()
    runVerb(w, `addMod ${pid} soak`)
    runVerb(w, 'step 1 {"eject":0}')
    const chipRow = () => (JSON.parse(runVerb(w, 'look')) as { near: { archetype: string; chip?: string }[] }).near.find((n) => n.archetype === 'mod.soak')
    expect(chipRow()?.chip).toBe('arming')
    runVerb(w, 'step 30')
    expect(chipRow()?.chip).toBe('armed')
  })

  it('look has no wand block in a default-fold run', () => {
    const { w, pid } = arena(false)
    runVerb(w, `addMod ${pid} frost`)
    expect((JSON.parse(runVerb(w, 'look')) as { player: { wand?: unknown } }).player.wand).toBeUndefined()
  })
})

describe('addMod on a reactive wand', () => {
  it('adds one entry per chip, capped at the mod copy limit', () => {
    const { w, pid } = arena()
    runVerb(w, `addMod ${pid} soak 5`) // soak: max 3 copies
    runVerb(w, `addMod ${pid} shock`)
    runVerb(w, `addMod ${pid} shock`) // shock: max 1
    expect(order(w, pid)).toEqual(['soak', 'soak', 'soak', 'shock'])
  })

  it('still stacks in a sequence run', () => {
    const { w, pid } = arena(false)
    w.modCasting = 'sequence'
    runVerb(w, `addMod ${pid} pierce 2`)
    expect(weaponStack(w.byId.get(pid)!)!.mods).toEqual([{ id: 'pierce', stacks: 2 }])
  })
})

describe('turning it on headless', () => {
  it('a HostSession built with the reactive rule latches it, and it survives the save', () => {
    const host = new HostSession(18, { sample: emptyInput }, undefined, 'normal', 'reactive')
    expect(host.world.modCasting).toBe('reactive')
    expect(deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(host.world)))).modCasting).toBe('reactive')
  })

  it('wand-lab and wand-boss force the reactive rule and hand out the lab wand', () => {
    for (const name of ['wand-lab', 'wand-boss']) {
      const host = new HostSession(18, { sample: emptyInput }, undefined, 'normal')
      expect(applyScenario(host.world, name)).toBe(true)
      const w = host.world
      expect(w.modCasting).toBe('reactive')
      const p = w.entities.find((e) => e.playerCtl)!
      expect(order(w, p.id)).toEqual(['frost', 'incendiary', 'shock', 'heavy', 'soak'])
      expect(p.health!.hp).toBe(240)
      const foes = w.entities.filter((e) => e.ai && !e.dead)
      expect(foes.length).toBeGreaterThan(0)
      if (name === 'wand-boss') expect(foes.map((e) => e.archetype)).toEqual(['boss'])
      else expect(new Set(foes.map((e) => e.archetype))).toEqual(new Set(['drowner']))
      // Shareable: the stage never carves a tile, so it restores through WorldJson.
      expect(() => deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))).not.toThrow()
    }
  })
})
