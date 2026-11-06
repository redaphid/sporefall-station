// Beasts stopped carrying knives and wrenches (a hound with a drawn blade in its
// "hand" was the tell). The fix is a RELABEL: each beast's weapon row is the old
// knife/wrench row under the body's own name, flagged `natural` so the renderer
// draws no held sprite. These tests prove the relabel changed nothing a player
// can feel: the numbers match field for field, and a real fight, run through the
// real systems from the same seed, produces the same world byte for byte once
// the label is swapped back.

import { describe, expect, it } from 'vitest'
import { WEAPONS, type WeaponDef } from './items'
import { NPCS } from './npcs'
import { npcLoadout, spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { serializeWorld } from '../serialize'
import { runTicks, walledRoom, worldFromRows } from '../testkit'
import type { World } from '../world'

/** Each re-labelled beast, the weapon it carried before, and the one it grows now. */
const RELABELLED = [
  { arch: 'gloamhound', was: 'knife', now: 'fangs' },
  { arch: 'stalker', was: 'knife', now: 'fangs' },
  { arch: 'lurker', was: 'knife', now: 'mandibles' },
  { arch: 'brute', was: 'wrench', now: 'horns' },
] as const

/** Every field that reaches combat, with the label fields stripped. */
const combatFields = (d: WeaponDef): Partial<WeaponDef> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'id' && k !== 'name' && k !== 'natural'))

describe('beast armament — the table', () => {
  it.each(RELABELLED)('$arch now grows $now, natural', ({ arch, now }) => {
    expect(NPCS[arch].weapon).toBe(now)
    expect(WEAPONS[now].natural).toBe(true)
  })

  it.each(RELABELLED)('$now carries every combat number $was did, durability included', ({ was, now }) => {
    expect(combatFields(WEAPONS[now])).toEqual(combatFields(WEAPONS[was]))
  })

  it.each(RELABELLED)('$arch spawns slotted exactly as it did with the $was', ({ was, now }) => {
    expect(npcLoadout(now)).toEqual(
      (() => {
        const ld = npcLoadout(was)!
        ld.inventory[0].itemId = now
        return ld
      })(),
    )
  })

  it('the carried rows are untouched for everyone else', () => {
    expect(combatFields(WEAPONS.knife)).toEqual({ kind: 'melee', damage: 12, range: 1.1, cooldownTicks: 9, knockback: 2, durability: 20 })
    expect(combatFields(WEAPONS.wrench)).toEqual({ kind: 'melee', damage: 16, range: 1.3, cooldownTicks: 15, knockback: 7, durability: 16 })
    expect(WEAPONS.knife.natural).toBeUndefined()
    expect(WEAPONS.wrench.natural).toBeUndefined()
  })
})

/** A beast next to a tough, idle player in a walled room, fighting for `ticks`.
 * `label` 'was' re-arms the beast with its old carried weapon exactly as
 * spawnNpc used to (combat.weapon + npcLoadout), so the two runs differ only in
 * the weapon's id. */
const fight = (arch: string, label: string, ticks: number): World => {
  const w = worldFromRows(walledRoom(16, 12), { seed: 4242, hostile: true })
  const p = spawnPlayer(w, 0, 6.5, 6.5)
  p.health = { hp: 5000, max: 5000, iframes: 0 }
  const beast = spawnNpc(w, arch, 8.0, 6.5)
  beast.combat!.weapon = label
  beast.loadout = npcLoadout(label)
  runTicks(w, new Map([[0, {}]]), ticks)
  return w
}

describe('beast armament — the fight is the same fight', () => {
  // Long enough for the old knife (20 swings) and wrench (16) to wear through,
  // so the durability path is exercised, not just the first bite.
  const TICKS = 900

  it.each(RELABELLED)('$arch: same seed, same world bytes as with the $was (label aside)', ({ arch, was, now }) => {
    const before = JSON.stringify(serializeWorld(fight(arch, was, TICKS)))
    const after = JSON.stringify(serializeWorld(fight(arch, now, TICKS)))
    expect(after.split(`"${now}"`).join(`"${was}"`)).toBe(before)
  })

  it.each(RELABELLED)('$arch: the fight really happened, and wore the armament through', ({ arch, now }) => {
    const w = fight(arch, now, TICKS)
    const p = w.entities.find((e) => e.playerCtl)!
    const beast = w.entities.find((e) => e.archetype === arch)!
    const lost = 5000 - p.health!.hp
    expect(lost, `${arch} never landed a hit`).toBeGreaterThan(0)
    // Worn through: the slot broke and the beast fell back to fists, as the
    // carried weapon used to.
    expect(beast.combat!.weapon).toBe('fists')
    expect(beast.loadout?.inventory.some((s) => s.itemId === now) ?? false).toBe(false)
  })

  it.each(RELABELLED)('$arch: damage per tick matches the $was at every tick', ({ arch, was, now }) => {
    const hpTrace = (label: string): number[] => {
      const w = worldFromRows(walledRoom(16, 12), { seed: 77, hostile: true })
      const p = spawnPlayer(w, 0, 6.5, 6.5)
      p.health = { hp: 5000, max: 5000, iframes: 0 }
      const beast = spawnNpc(w, arch, 8.0, 6.5)
      beast.combat!.weapon = label
      beast.loadout = npcLoadout(label)
      const trace: number[] = []
      for (let t = 0; t < 600; t++) {
        runTicks(w, new Map([[0, {}]]), 1)
        trace.push(p.health!.hp)
      }
      return trace
    }
    const a = hpTrace(was)
    const b = hpTrace(now)
    expect(b).toEqual(a)
    expect(a[a.length - 1]).toBeLessThan(5000)
  })
})
