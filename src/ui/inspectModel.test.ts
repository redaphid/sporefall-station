import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { spawnObject } from '../game/systems/objects'
import { makeEntity, type Entity } from '../game/entity'
import { createWorld } from '../game/world'
import { NPCS } from '../game/data/npcs'
import { OBJECTS } from '../game/data/objects'
import { THROWABLES, WEAPONS, CONSUMABLES } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { aiPhrase, buildInfoCard } from './inspectModel'

const rowMap = (rows: { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.label, r.value]))

const world = () => createWorld(1, 1)

describe('buildInfoCard — every NPC archetype in the game gets a full card', () => {
  for (const archetype of Object.keys(NPCS)) {
    it(`summarizes a ${archetype}: title, hp bar, faction, stance, activity`, () => {
      const w = world()
      const e = spawnNpc(w, archetype, 5, 5)
      const card = buildInfoCard(e)
      expect(card.title).not.toBe('')
      expect(card.kind).toBe('npc')
      expect(card.glyph).toBeTruthy()
      expect(card.hp).toEqual({ hp: e.health!.hp, max: e.health!.max })
      const rows = rowMap(card.rows)
      expect(rows.Faction).toBeDefined()
      expect(rows['Toward you']).toMatch(/^(Friendly|Neutral|Annoyed|Hostile)$/)
      expect(rows.Nature).toBeDefined() // innate temperament from the NPC table
      expect(rows.Weapon).toBeDefined()
      expect(card.tagline).toBeTruthy() // plain-words activity line
      expect(card.destroyed).toBeUndefined()
    })
  }

  it('gang NPCs open Hostile toward the player; cops/civilians Neutral', () => {
    const w = world()
    expect(rowMap(buildInfoCard(spawnNpc(w, 'thug', 1, 1)).rows)['Toward you']).toBe('Hostile')
    expect(rowMap(buildInfoCard(spawnNpc(w, 'cop', 2, 2)).rows)['Toward you']).toBe('Neutral')
    expect(rowMap(buildInfoCard(spawnNpc(w, 'civilian', 3, 3)).rows)['Toward you']).toBe('Neutral')
  })

  it('a stored rel entry toward the local player overrides the faction stance', () => {
    const w = world()
    const p = spawnPlayer(w, 0, 2, 2)
    const cop = spawnNpc(w, 'cop', 5, 5)
    cop.ai!.rel = { [p.id]: { hate: 9, code: 'Hostile' } }
    expect(rowMap(buildInfoCard(cop, { selfId: p.id }).rows)['Toward you']).toBe('Hostile')
    // Without ctx.selfId the faction-derived stance still shows (never blank).
    expect(rowMap(buildInfoCard(cop).rows)['Toward you']).toBe('Neutral')
  })

  it('non-default brains get a Brain row; the default basic brain is implied', () => {
    const w = world()
    const boss = spawnNpc(w, 'boss', 5, 5) // #69 Mireclaw Alpha phased boss brain
    expect(rowMap(buildInfoCard(boss).rows).Brain).toBe('Mireclaw')
    const thug = spawnNpc(w, 'thug', 6, 6) // basic
    expect(rowMap(buildInfoCard(thug).rows).Brain).toBeUndefined()
    // An unknown behavior id (stale snapshot) degrades to no Brain row, no throw.
    thug.ai!.behavior = 'not-a-real-brain'
    expect(rowMap(buildInfoCard(thug).rows).Brain).toBeUndefined()
  })
})

describe('buildInfoCard — the weapon an NPC is carrying', () => {
  const weaponRow = (e: Entity): string | undefined => rowMap(buildInfoCard(e).rows).Weapon

  it('an armed NPC names its weapon — a thug swings a Bat, a gangster a Pistol', () => {
    expect(weaponRow(spawnNpc(world(), 'thug', 5, 5))).toBe('Bat')
    expect(weaponRow(spawnNpc(world(), 'gangster', 5, 5))).toBe('Pistol')
  })

  it('a fists-only NPC reads as "Unarmed", not the "Fists" item name', () => {
    expect(weaponRow(spawnNpc(world(), 'civilian', 5, 5))).toBe('Unarmed')
    expect(weaponRow(spawnNpc(world(), 'bouncer', 5, 5))).toBe('Unarmed')
  })

  it('a blank or missing weapon still reads "Unarmed" — never blank/undefined', () => {
    const empty = spawnNpc(world(), 'thug', 5, 5)
    empty.combat!.weapon = ''
    expect(weaponRow(empty)).toBe('Unarmed')
    const gone = spawnNpc(world(), 'thug', 5, 5)
    delete (gone.combat as unknown as Record<string, unknown>).weapon // combat present, weapon absent
    expect(weaponRow(gone)).toBe('Unarmed')
  })

  it('a modded weapon surfaces its mod rows for whoever carries it (not player-gated)', () => {
    // NPC weapons are vanilla today, but the mod readout keys off the equipped
    // stack, not `playerCtl` — so any carrier's build shows. Proven via a player.
    const p = spawnPlayer(world(), 0, 2, 2)
    p.combat!.weapon = 'sledgehammer'
    p.playerCtl!.inventory.push({ itemId: 'sledgehammer', qty: 1, mods: [{ id: 'frost', stacks: 1 }] })
    p.playerCtl!.activeSlot = p.playerCtl!.inventory.length - 1
    const rows = rowMap(buildInfoCard(p).rows)
    expect(rows.Weapon).toBe('Sledgehammer')
    expect(rows['❄️ Cryo Rounds']).toBe('×1')
  })

  it('a non-combatant (door, pickup) has no Weapon row at all', () => {
    const d = makeEntity('door', 'door.wood', 3, 3)
    d.door = { open: false, locked: false, lockLevel: 0 }
    expect(weaponRow(d)).toBeUndefined()
    const pk = makeEntity('pickup', 'medkit', 1, 1)
    pk.pickup = { itemId: 'medkit', qty: 1 }
    expect(weaponRow(pk)).toBeUndefined()
  })
})

describe('aiPhrase — AI state in plain words', () => {
  const ai = (over: object) =>
    ({ mode: 'idle', faction: 'civ', home: { x: 0, y: 0 }, thinkAt: 0, sightRange: 6, ...over }) as never

  it.each([
    ['battle', 'Fighting'],
    ['pursue', 'Hunting a target'],
    ['flee', 'Running away'],
    ['investigate', 'Investigating a disturbance'],
    ['wander', 'Wandering around'],
    ['search', 'Sweeping the area for a lost target'],
    ['alert', 'Running to warn a guard'],
    ['scavenge', 'Collecting loot'],
  ])('goal %s → "%s"', (goal, phrase) => {
    expect(aiPhrase(ai({ goal }))).toBe(phrase)
  })

  it('patrol reads the live waypoint number: "Patrolling · heading to waypoint 3"', () => {
    expect(aiPhrase(ai({ goal: 'patrol', patrolIndex: 2 }))).toBe('Patrolling · heading to waypoint 3')
    expect(aiPhrase(ai({ goal: 'patrol' }))).toBe('Patrolling · heading to waypoint 1') // index absent → leg 1
  })

  it('an unknown/modded goal code still reads as words, never blank', () => {
    expect(aiPhrase(ai({ goal: 'summon-demons' }))).toBe('Summon Demons')
  })

  it.each([
    ['idle', 'Standing around'],
    ['wander', 'Wandering around'],
    ['patrol', 'Walking a beat'],
    ['aggro', 'Attacking'],
    ['flee', 'Running away'],
    ['seek', 'Heading somewhere'],
    ['sleep', 'Asleep'],
  ])('no goal yet → mode %s → "%s"', (mode, phrase) => {
    expect(aiPhrase(ai({ mode }))).toBe(phrase)
  })

  it('an idle guard reads as standing guard', () => {
    expect(aiPhrase(ai({ guard: true }))).toBe('Standing guard')
  })
})

describe('buildInfoCard — players', () => {
  it('reads slot, cash, weapon and the modded build', () => {
    const w = world()
    const p = spawnPlayer(w, 0, 2, 2)
    p.combat!.weapon = 'shotgun'
    p.playerCtl!.inventory.push({ itemId: 'shotgun', qty: 6, mods: [{ id: 'frost', stacks: 1 }, { id: 'bounce', stacks: 2 }] })
    p.playerCtl!.activeSlot = p.playerCtl!.inventory.length - 1
    p.playerCtl!.cash = 120
    const card = buildInfoCard(p)
    const rows = rowMap(card.rows)
    expect(rows.Player).toBe('P1')
    expect(rows.Cash).toBe('$120')
    expect(rows.Weapon).toBe('Shotgun')
    expect(rows['❄️ Cryo Rounds']).toBe('×1')
    expect(rows['🪃 Bouncy']).toBe('×2')
  })

  it('a vanilla gun shows no mod rows', () => {
    const w = world()
    const p = spawnPlayer(w, 0, 2, 2)
    p.combat!.weapon = 'pistol'
    p.playerCtl!.inventory.push({ itemId: 'pistol', qty: 6 })
    p.playerCtl!.activeSlot = p.playerCtl!.inventory.length - 1
    expect(buildInfoCard(p).rows.some((r) => r.value.startsWith('×'))).toBe(false)
  })

  it('a downed player says so', () => {
    const w = world()
    const p = spawnPlayer(w, 1, 2, 2)
    p.playerCtl!.downed = { bleedTicks: 0, reviveProgress: 0 }
    const card = buildInfoCard(p)
    expect(rowMap(card.rows).Player).toBe('P2')
    expect(card.tagline).toMatch(/[Dd]owned/)
  })
})

describe('buildInfoCard — doors', () => {
  const door = (over: object): Entity => {
    const d = makeEntity('door', 'door.wood', 3, 3)
    d.door = { open: false, locked: false, lockLevel: 0, ...over }
    d.interact = { verb: 'open', range: 1 }
    return d
  }

  it('locked: state, lock level, and the LEVEL-DEPENDENT pick time in seconds', () => {
    const l2 = rowMap(buildInfoCard(door({ locked: true, lockLevel: 2 })).rows)
    expect(l2.Door).toBe('Locked (L2)')
    expect(l2['Pick time']).toBe('3.5s') // pickTicks(2)=105 / SIM_RATE
    expect(l2.Interact).toBe('Open')
    const l1 = rowMap(buildInfoCard(door({ locked: true, lockLevel: 1 })).rows)
    expect(l1['Pick time']).toBe('2.0s') // pickTicks(1)=60 / SIM_RATE
    const l3 = rowMap(buildInfoCard(door({ locked: true, lockLevel: 3 })).rows)
    expect(l3['Pick time']).toBe('5.0s') // pickTicks(3)=150 / SIM_RATE
  })

  it('a locked door thumbnails as the padlocked art key', () => {
    expect(buildInfoCard(door({ locked: true, lockLevel: 1 })).artKey).toBe('door.locked')
  })

  it('closed-unlocked and open doors show no pick time', () => {
    const closed = rowMap(buildInfoCard(door({})).rows)
    expect(closed.Door).toBe('Closed')
    expect(closed['Pick time']).toBeUndefined()
    const open = buildInfoCard(door({ open: true }))
    expect(rowMap(open.rows).Door).toBe('Open')
    expect(open.artKey).toBe('door.open') // thumbnail matches the drawn state
  })

  it('a closed door thumbnails as the closed art key', () => {
    expect(buildInfoCard(door({})).artKey).toBe('door')
  })
})

describe('buildInfoCard — pickups (weapons, consumables, throwables, mods, loot)', () => {
  const pickup = (itemId: string, qty = 1): Entity => {
    const e = makeEntity('pickup', itemId, 1, 1)
    e.pickup = { itemId, qty }
    return e
  }

  for (const id of Object.keys(WEAPONS).filter((w) => w !== 'fists')) {
    it(`weapon ${id}: damage + range + what-it-is tagline`, () => {
      const card = buildInfoCard(pickup(id))
      const rows = rowMap(card.rows)
      expect(rows.Item).toContain(WEAPONS[id].name)
      expect(rows.Damage).toBe(String(WEAPONS[id].damage))
      expect(rows.Range).toBe(`${WEAPONS[id].range} tiles`)
      expect(card.tagline).toMatch(/weapon|Firearm/)
    })
  }

  for (const id of Object.keys(THROWABLES)) {
    it(`throwable ${id}: says what it does where it lands`, () => {
      const card = buildInfoCard(pickup(id))
      expect(rowMap(card.rows).Item).toContain(THROWABLES[id].name)
      expect(card.tagline).toMatch(/where it lands/)
    })
  }

  for (const id of Object.keys(CONSUMABLES).filter((c) => CONSUMABLES[c].heal)) {
    it(`consumable ${id}: heal amount`, () => {
      const rows = rowMap(buildInfoCard(pickup(id)).rows)
      expect(rows.Heal).toBe(String(CONSUMABLES[id].heal))
    })
  }

  for (const id of Object.keys(MODS)) {
    it(`weapon-mod pickup ${id}: named, blurbed, rarity-tagged (never a bogus Item row)`, () => {
      const card = buildInfoCard(pickup(id))
      const rows = rowMap(card.rows)
      expect(rows.Mod).toContain(MODS[id].name)
      expect(rows.Rarity).toBeDefined()
      expect(card.tagline).toBe(MODS[id].blurb)
      expect(rows.Item).toBeUndefined()
    })
  }

  it('cash and the mission briefcase read as flavor, quantity shows for stacks', () => {
    expect(buildInfoCard(pickup('cash', 1)).tagline).toMatch(/[Mm]oney/)
    expect(buildInfoCard(pickup('briefcase')).tagline).toMatch(/goods|came for/)
    expect(rowMap(buildInfoCard(pickup('medkit', 2)).rows).Item).toBe('Medkit ×2')
  })
})

describe('buildInfoCard — world objects (every OBJECTS entry)', () => {
  for (const id of Object.keys(OBJECTS)) {
    it(`prop ${id}: card is never blank (flavor, dispense, or hp)`, () => {
      const w = world()
      const e = spawnObject(w, id, 4, 4)
      const card = buildInfoCard(e)
      expect(card.title).not.toBe('')
      expect(card.rows.length + (card.tagline ? 1 : 0) + (card.hp ? 1 : 0)).toBeGreaterThan(0)
    })
  }

  it('an ATM says what it dispenses; a vending machine names the snack', () => {
    const w = world()
    expect(rowMap(buildInfoCard(spawnObject(w, 'atm', 1, 1)).rows).Dispenses).toBe('$50')
    expect(rowMap(buildInfoCard(spawnObject(w, 'vending', 2, 2)).rows).Dispenses).toBe('Burger')
  })

  it('explosive props warn; a used dispenser says so', () => {
    const w = world()
    expect(buildInfoCard(spawnObject(w, 'barrel', 1, 1)).tagline).toMatch(/[Ee]xplosive/)
    const atm = spawnObject(w, 'atm', 2, 2)
    atm.used = true
    expect(rowMap(buildInfoCard(atm).rows).State).toBe('Already used')
  })
})

describe('buildInfoCard — hazards, mission targets, death, theming, fallback', () => {
  it('fire reads fuel and warns', () => {
    const f = makeEntity('fire', 'fire', 2, 2)
    f.fire = { fuel: 90 }
    const card = buildInfoCard(f)
    expect(rowMap(card.rows).Fuel).toBe('90')
    expect(card.tagline).toMatch(/[Bb]urning/)
  })

  it('a projectile reads its damage', () => {
    const b = makeEntity('projectile', 'projectile', 2, 2)
    b.projectile = { ownerId: 1, damage: 12, ttl: 30 }
    expect(rowMap(buildInfoCard(b).rows).Damage).toBe('12')
  })

  it('the mission target carries the mission link; other entities never do', () => {
    const w = world()
    const boss = spawnNpc(w, 'boss', 5, 5)
    const bystander = spawnNpc(w, 'cop', 6, 6)
    expect(buildInfoCard(boss, { missionTargetId: boss.id }).mission).toEqual({ targetId: boss.id })
    expect(buildInfoCard(bystander, { missionTargetId: boss.id }).mission).toBeUndefined()
    expect(buildInfoCard(boss, {}).mission).toBeUndefined()
  })

  it('a dead entity reads as destroyed (card shows it briefly, then closes)', () => {
    const w = world()
    const thug = spawnNpc(w, 'thug', 5, 5)
    thug.dead = true
    thug.health!.hp = 0
    const card = buildInfoCard(thug, { missionTargetId: thug.id })
    expect(card.destroyed).toBe(true)
    expect(card.tagline).toBe('Destroyed')
    expect(card.mission).toBeUndefined() // no locate action on a corpse
    expect(card.hp).toEqual({ hp: 0, max: thug.health!.max })
  })

  it('the title uses the theme resolver — same sim entity, themed presentation', () => {
    const w = world()
    const cop = spawnNpc(w, 'cop', 5, 5)
    const card = buildInfoCard(cop, {}, (a) => (a === 'cop' ? 'Bog Warden' : a))
    expect(card.title).toBe('Bog Warden')
    expect(card.archetype).toBe('cop') // the sim identity is still exposed
  })

  it('an unknown/modded kind falls back to component reflection — never a blank card', () => {
    const alien = makeEntity('interactable', 'xeno.egg', 7, 9)
    ;(alien as unknown as Record<string, unknown>).pulse = { rate: 3, warm: true }
    alien.flammable = true
    const card = buildInfoCard(alien)
    expect(card.tagline).toBe('Unknown object')
    const rows = rowMap(card.rows)
    expect(rows.At).toBe('7, 9')
    expect(rows.Flammable).toBe('Yes')
    expect(rows.Pulse).toContain('rate 3')
    expect(card.rows.length).toBeGreaterThanOrEqual(3)
  })

  it('a completely bare unknown entity still shows its position', () => {
    const bare = makeEntity('interactable', 'mystery.thing', 0, 0)
    const card = buildInfoCard(bare)
    expect(card.title).toBe('Mystery Thing')
    expect(rowMap(card.rows).At).toBe('0, 0')
  })

  it('never throws across a whole spawned menagerie', () => {
    const w = world()
    for (const a of Object.keys(NPCS)) spawnNpc(w, a, 3, 3)
    for (const o of Object.keys(OBJECTS)) spawnObject(w, o, 4, 4)
    spawnPlayer(w, 0, 2, 2)
    for (const e of w.entities) expect(() => buildInfoCard(e, { selfId: 1, missionTargetId: 2 })).not.toThrow()
  })
})
