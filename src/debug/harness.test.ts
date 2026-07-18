import { describe, expect, it } from 'vitest'
import { encodeArg } from './protocol'
import { GameHarness, runHarnessVerb } from './harness'
import type { Recording } from './record'

describe('GameHarness', () => {
  it('creates a lobby, admits bots, then starts the run', () => {
    const h = new GameHarness()
    h.create({ seed: 1, classId: 'soldier', name: 'Host' })
    expect(h.phase).toBe('lobby')
    const s1 = h.addBot({ name: 'Bob', classId: 'soldier' })
    const s2 = h.addBot({ name: 'Cara', classId: 'soldier' })
    expect([s1, s2]).toEqual([1, 2])
    expect(h.lobby().map((p) => p.name)).toEqual(['Host', 'Bob', 'Cara'])

    // No bot avatars until the run starts (host self exists from create()).
    expect(h.world.entities.filter((e) => e.playerCtl)).toHaveLength(1)
    h.start()
    expect(h.phase).toBe('playing')
    expect(h.world.entities.filter((e) => e.playerCtl)).toHaveLength(3)
  })

  it('refuses to tick before the run starts', () => {
    const h = new GameHarness()
    h.create({ seed: 1, classId: 'soldier' })
    expect(() => h.stepTick()).toThrow(/start the run/)
  })

  it('drives bots via programmatic input deposited into remoteInputs', () => {
    const h = new GameHarness()
    h.create({ seed: 7, classId: 'soldier' })
    const slot = h.addBot({ name: 'Runner', classId: 'soldier' })
    h.start()
    const bot = h.world.entities.find((e) => e.playerCtl?.playerId === slot)!
    const x0 = bot.pos.x
    h.setInput(slot, { moveX: 1 })
    h.stepTicks(30)
    expect(bot.pos.x).toBeGreaterThan(x0)
  })

  it('late-joins a bot straight into a running world', () => {
    const h = new GameHarness()
    h.create({ seed: 9, classId: 'soldier' })
    h.start()
    h.stepTicks(5)
    const before = h.world.entities.filter((e) => e.playerCtl).length
    const slot = h.addBot({ name: 'Late', classId: 'soldier' })
    expect(h.world.entities.filter((e) => e.playerCtl).length).toBe(before + 1)
    expect(h.world.entities.some((e) => e.playerCtl?.playerId === slot)).toBe(true)
  })

  it('removeBot kills the avatar and frees the slot', () => {
    const h = new GameHarness()
    h.create({ seed: 9, classId: 'soldier' })
    const slot = h.addBot({ name: 'Temp', classId: 'soldier' })
    h.start()
    const id = h.world.entities.find((e) => e.playerCtl?.playerId === slot)!.id
    h.removeBot(slot)
    h.stepTick() // sweepDead removes the killed avatar
    expect(h.world.byId.get(id)).toBeUndefined()
  })
})

describe('runHarnessVerb', () => {
  const drive = (h: GameHarness, line: string): unknown => JSON.parse(runHarnessVerb(h, line))

  it('runs a whole session through the verb grammar', () => {
    const h = new GameHarness()
    drive(h, 'create soldier 12345 Hosty')
    const joined = drive(h, 'join_bot Bob soldier') as { slot: number }
    expect(joined.slot).toBe(1)
    expect(drive(h, 'lobby')).toHaveLength(2)
    drive(h, 'start_run')
    expect((drive(h, 'phase') as { phase: string }).phase).toBe('playing')

    // Programmatic per-slot input (base64-safe payload) then advance.
    runHarnessVerb(h, `input 1 ${encodeArg('{"moveX":1}')}`)
    const after = drive(h, 'tick 20') as { tick: number }
    expect(after.tick).toBe(20)
  })

  it('records via verbs and replays deterministically', () => {
    const h = new GameHarness()
    drive(h, 'create soldier 999')
    drive(h, 'join_bot Bob soldier')
    drive(h, 'start_run')
    drive(h, 'record_start')
    runHarnessVerb(h, `input 1 ${encodeArg('{"moveX":1}')}`)
    drive(h, 'tick 60')
    const rec = runHarnessVerb(h, 'record_stop')
    const result = drive(h, `replay ${encodeArg(rec)}`) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect((JSON.parse(rec) as Recording).ticks).toHaveLength(60)
  })

  it('save/load round-trip through verbs restores world state', () => {
    const h = new GameHarness()
    drive(h, 'create soldier 321')
    drive(h, 'start_run')
    drive(h, 'tick 15')
    const fixture = runHarnessVerb(h, 'save')
    const dump = JSON.parse(runHarnessVerb(h, 'entities')) as unknown[]
    drive(h, 'tick 15')
    drive(h, `load ${encodeArg(fixture)}`)
    expect(JSON.parse(runHarnessVerb(h, 'entities'))).toEqual(dump)
  })

  it('falls through to world verbs for the ECS surface', () => {
    const h = new GameHarness()
    drive(h, 'create soldier 5')
    drive(h, 'start_run')
    const before = (drive(h, 'state') as { counts: Record<string, number> }).counts.npc ?? 0
    const spawned = drive(h, 'spawn npc cop 10 10') as { id: number; archetype: string }
    expect(spawned.archetype).toBe('cop')
    const after = drive(h, 'state') as { counts: Record<string, number> }
    expect(after.counts.npc).toBe(before + 1)
    expect((drive(h, `get ${spawned.id}`) as { archetype: string }).archetype).toBe('cop')
  })
})
