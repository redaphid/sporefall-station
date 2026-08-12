import { describe, expect, it } from 'vitest'
import { MODS } from '../game/data/mods'
import { spawnPlayer } from '../game/player'
import { applyModPickup } from '../game/systems/inventory'
import { createWorld } from '../game/world'
import { equippedModBadge, hasThrowable, hotbarSlots, modBadge } from './hotbarModel'

describe('hotbarSlots', () => {
  it('keeps each item pointing at its real inventory index across the filters', () => {
    // The briefcase AND the permanent weapon are both filtered out of display,
    // so a tapped strip position must map back through `index`.
    const inv = [
      { itemId: 'briefcase', qty: 1 },
      { itemId: 'pistol', qty: 1 },
      { itemId: 'grenade', qty: 2 },
      { itemId: 'medkit', qty: 1 },
    ]
    const slots = hotbarSlots(inv, 3)
    expect(slots.map((s) => s.itemId)).toEqual(['grenade', 'medkit'])
    expect(slots.map((s) => s.index)).toEqual([2, 3])
    expect(slots.find((s) => s.itemId === 'medkit')!.active).toBe(true)
    expect(slots.find((s) => s.itemId === 'grenade')!.active).toBe(false)
  })

  it('NEVER shows a weapon — there is no weapon-selected indicator any more', () => {
    const inv = [{ itemId: 'pistol', qty: 1 }, { itemId: 'bat', qty: 12 }, { itemId: 'grenade', qty: 2 }]
    expect(hotbarSlots(inv, 0).map((s) => s.itemId)).toEqual(['grenade'])
  })

  it('marks no slot active when activeSlot is -1', () => {
    const slots = hotbarSlots([{ itemId: 'grenade', qty: 2 }], -1)
    expect(slots.every((s) => !s.active)).toBe(true)
  })
})

describe('modBadge / hotbar mod display', () => {
  it('is empty for a vanilla weapon', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6 })).toBe('')
    expect(hotbarSlots([{ itemId: 'grenade', qty: 2 }], 0)[0].mods).toBe('')
  })
  it('shows an icon per mod, with ×N for a stack', () => {
    const badge = modBadge({ itemId: 'shotgun', qty: 6, mods: [{ id: 'frost', stacks: 1 }, { id: 'bounce', stacks: 2 }] })
    expect(badge).toContain('❄️')
    expect(badge).toContain('🪃×2')
  })
  it('surfaces the badge through hotbarSlots', () => {
    const slots = hotbarSlots([{ itemId: 'grenade', qty: 2, mods: [{ id: 'overload', stacks: 3 }] }], 0)
    expect(slots[0].mods).toContain('💥×3')
  })
  it('ignores unknown / zero-stack mods', () => {
    expect(modBadge({ itemId: 'pistol', qty: 6, mods: [{ id: 'nope', stacks: 2 }, { id: 'frost', stacks: 0 }] })).toBe('')
  })
})

describe('equippedModBadge — the always-on HUD mod readout', () => {
  // REGRESSION GUARD. The hotbar stopped drawing the weapon slot (nothing to
  // select any more), and mods live only on the weapon's stack — so the badge
  // that used to ride that slot silently became unreachable. Mods are the whole
  // progression of a one-weapon run; they must stay visible while FIGHTING, not
  // only when the player pauses. These tests drive the REAL data flow (spawn a
  // real player, apply a real mod pickup) rather than a synthetic ItemStack,
  // because a synthetic stack is exactly what hid the breakage.
  const moddedPlayer = (...mods: string[]) => {
    const w = createWorld(4242, 1)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    for (const m of mods) applyModPickup(p, m)
    return p
  }

  it('is empty for a freshly spawned, unmodded player', () => {
    expect(equippedModBadge(moddedPlayer())).toBe('')
  })

  it('shows a mod the player actually picked up', () => {
    expect(equippedModBadge(moddedPlayer('frost'))).toContain('❄️')
  })

  it('stacks and shows several mods at once', () => {
    const badge = equippedModBadge(moddedPlayer('overload', 'overload', 'frost'))
    expect(badge).toContain('💥×2')
    expect(badge).toContain('❄️')
  })

  it('stays visible even though the weapon is NOT in the hotbar — the whole point', () => {
    const p = moddedPlayer('incendiary')
    const inv = p.loadout!.inventory
    // The weapon is genuinely hidden from the hotbar...
    expect(hotbarSlots(inv, p.loadout!.activeSlot).some((s) => s.itemId === 'pistol')).toBe(false)
    // ...so no hotbar slot can carry the badge...
    expect(hotbarSlots(inv, p.loadout!.activeSlot).every((s) => s.mods === '')).toBe(true)
    // ...and the HUD readout is the only thing keeping the build on screen.
    expect(equippedModBadge(p)).toContain(MODS.incendiary.icon)
  })
})

describe('hasThrowable', () => {
  it('is true when a throwable is carried', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 1 }, { itemId: 'grenade', qty: 2 }])).toBe(true)
  })
  it('is false with no throwables', () => {
    expect(hasThrowable([{ itemId: 'pistol', qty: 1 }])).toBe(false)
  })
})
