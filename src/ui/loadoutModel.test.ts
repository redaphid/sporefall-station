import { describe, it, expect } from 'vitest'
import { buildLoadout, toCssHex } from './loadoutModel'
import type { Entity } from '../game/entity'
import { modPickupColor } from '../render/modColors'
import { resolveWeapon } from '../game/systems/resolveWeapon'
import { WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'

/** A minimal player entity holding `weaponId` in slot 0 with the given mods. */
const player = (weaponId: string, mods?: { id: string; stacks: number }[]): Entity =>
  ({
    id: 1,
    kind: 'player',
    archetype: 'player',
    pos: { x: 0, y: 0 },
    prevPos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    intent: { x: 0, y: 0 },
    speed: 4,
    radius: 0.4,
    facing: 0,
    combat: { weapon: weaponId, cooldown: 0 },
    playerCtl: {
      playerId: 0,
      abilityCooldown: 0,
      inventory: weaponId === 'fists' ? [] : [{ itemId: weaponId, qty: 8, ...(mods ? { mods } : {}) }],
      activeSlot: weaponId === 'fists' ? -1 : 0,
      cash: 0,
      crimeUntilTick: 0,
    },
  }) as Entity

describe('buildLoadout', () => {
  it('returns null for an entity with no weapon component', () => {
    const e = { ...player('fists') }
    delete (e as Partial<Entity>).combat
    expect(buildLoadout(e)).toBeNull()
    expect(buildLoadout(undefined)).toBeNull()
  })

  it('an unmodded gun shows base stats and no mods', () => {
    const m = buildLoadout(player('pistol'))!
    expect(m.name).toBe('Pistol')
    expect(m.kind).toBe('ranged')
    expect(m.unarmed).toBe(false)
    expect(m.mods).toEqual([])
    expect(m.behaviors).toEqual([])
    const dmg = m.stats.find((s) => s.key === 'damage')!
    expect(dmg.baseText).toBe(String(WEAPONS.pistol.damage))
    expect(dmg.resolvedText).toBe(String(WEAPONS.pistol.damage))
    expect(dmg.changed).toBe(false)
    // Ranged-only rows are present.
    expect(m.stats.map((s) => s.key)).toContain('speed')
    expect(m.stats.map((s) => s.key)).toContain('mag')
  })

  it('bare fists / unarmed is handled gracefully', () => {
    const m = buildLoadout(player('fists'))!
    expect(m.unarmed).toBe(true)
    expect(m.name).toBe('Unarmed')
    expect(m.kind).toBe('melee')
    expect(m.mods).toEqual([])
    // Melee shows Reach, not ranged rows.
    expect(m.stats.map((s) => s.key)).toContain('range')
    expect(m.stats.map((s) => s.key)).not.toContain('speed')
  })

  it('an unknown weapon id resolves as unarmed fists, never crashes', () => {
    const m = buildLoadout(player('phaser-9000'))!
    expect(m.unarmed).toBe(true)
    expect(m.weaponId).toBe('fists')
  })

  it('a modded gun yields the right chips, colors, stacks and resolved stats', () => {
    const mods = [
      { id: 'overload', stacks: 2 },
      { id: 'incendiary', stacks: 1 },
      { id: 'pierce', stacks: 3 },
    ]
    const m = buildLoadout(player('pistol', mods))!
    // Chips are sorted by id and carry name/icon/desc/stacks.
    expect(m.mods.map((c) => c.id)).toEqual(['incendiary', 'overload', 'pierce'])
    const overload = m.mods.find((c) => c.id === 'overload')!
    expect(overload.name).toBe(MODS.overload.name)
    expect(overload.desc).toBe(MODS.overload.blurb)
    expect(overload.icon).toBe(MODS.overload.icon)
    expect(overload.stacks).toBe(2)
    expect(overload.rarity).toBe('rare')

    // Colours match modPickupColor exactly (single source of truth).
    for (const c of m.mods) expect(c.color).toBe(toCssHex(modPickupColor(c.id)))

    // Resolved damage matches resolveWeapon and beats base (overload ×2 damage).
    const res = resolveWeapon(WEAPONS.pistol, mods)
    const dmg = m.stats.find((s) => s.key === 'damage')!
    expect(dmg.resolvedText).toBe(String(res.damage))
    expect(dmg.changed).toBe(true)
    expect(dmg.direction).toBe(1)

    // Behaviors surface pierce and the incendiary element.
    expect(m.behaviors.map((b) => b.key)).toContain('pierce')
    expect(m.behaviors.map((b) => b.key)).toContain('onhit')
    expect(m.behaviors.find((b) => b.key === 'pierce')!.label).toContain('×3')
  })

  it('drops unknown / zero-stack mods from the chips', () => {
    const m = buildLoadout(player('pistol', [
      { id: 'bogus', stacks: 3 },
      { id: 'rapid', stacks: 0 },
      { id: 'frost', stacks: 1 },
    ]))!
    expect(m.mods.map((c) => c.id)).toEqual(['frost'])
  })

  it('toCssHex zero-pads to six hex digits', () => {
    expect(toCssHex(0x42d4f4)).toBe('#42d4f4')
    expect(toCssHex(0x000075)).toBe('#000075')
  })
})
