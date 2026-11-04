// The boss bar, driven by the REAL combat pipeline through a freeze + shatter.
//
// This test exists because of #79. Before it, a shatter was a separate
// lethality rule — an instant kill on any impact landing on a frozen body — so
// the 320hp Mireclaw Alpha died on shot 2 and the bar it is supposed to own
// went from full to gone without ever drawing an intermediate width. The bar
// was, in practice, decorative.
//
// #79 made a shatter a hard HIT (`x SHATTER_DAMAGE_MULT`) routed through
// `applyDamage` like everything else, so the Alpha now survives being frozen
// and shattered and the bar has a job: it drains, it crosses the phase
// thresholds, and the player watches it. These assertions pin that the UI
// reads the post-#79 pipeline correctly rather than assuming the old one.
//
// The fight is run with the same `shoot` idiom as
// `game/systems/freezeShatterBalance.test.ts` — damage then the onHit status,
// then the weapon's real cooldown through `statusSystem` — so the hp the bar
// reports is hp the shipping sim produced.
import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { NPCS } from '../game/data/npcs'
import type { Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { spawnNpc } from '../game/populate'
import { applyDamage, SHATTER_DAMAGE_MULT } from '../game/systems/combat'
import { statusSystem } from '../game/systems/status'
import { applyStatus, isFrozen } from '../game/systems/statusFx'
import { createWorld, type World } from '../game/world'
import { bossBar, type BossViewLike } from './bossModel'

const PISTOL = WEAPONS.pistol
const FROST = MODS.frost.onHit!

const shoot = (w: World, target: Entity, damage = PISTOL.damage): number | null => {
  const dealt = applyDamage(w, target, damage, 0, 0, 0, 999)
  if (dealt !== null) applyStatus(w, target, FROST.status, FROST.ticks)
  for (let i = 0; i < PISTOL.cooldownTicks; i++) {
    statusSystem(w)
    w.tick++
  }
  return dealt
}

/** A frame as the HUD sees it: the live world plus who this device is. */
const frame = (w: World, self: Entity): BossViewLike => ({ entities: w.entities, events: w.events, self })

const stage = (): { w: World; boss: Entity; player: Entity } => {
  const w = createWorld(7, 1)
  const player = spawnPlayer(w, 1, 2, 2)
  const boss = spawnNpc(w, 'boss', 5, 5)
  return { w, boss, player }
}

describe('the boss bar across a post-#79 freeze + shatter', () => {
  it('survives the shatter and reports the drained hp, instead of vanishing', () => {
    const { w, boss, player } = stage()
    expect(boss.health!.max).toBe(NPCS.boss.hp)

    const full = bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')!
    expect(full.hpFrac).toBe(1)

    shoot(w, boss) // freezes
    expect(isFrozen(boss)).toBe(true)
    shoot(w, boss) // shatters — an execute before #79

    const after = bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')
    // The pre-#79 behaviour would have made this null on shot 2.
    expect(after).not.toBeNull()
    expect(boss.dead).toBeFalsy() // `dead` is optional — absent while alive
    expect(after!.hp).toBe(boss.health!.hp)
    expect(after!.hpFrac).toBeGreaterThan(0)
    expect(after!.hpFrac).toBeLessThan(1)
  })

  it('draws the shatter as one big bite, sized by SHATTER_DAMAGE_MULT', () => {
    const { w, boss, player } = stage()
    shoot(w, boss)
    const beforeShatter = bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')!
    shoot(w, boss)
    const afterShatter = bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')!

    const bite = beforeShatter.hp - afterShatter.hp
    // A shatter is worth several ordinary hits, which is the whole feel of the
    // mechanic, and the bar must show that as one visible step rather than a
    // normal tick.
    expect(bite).toBeGreaterThan(PISTOL.damage)
    expect(bite).toBeLessThanOrEqual(PISTOL.damage * SHATTER_DAMAGE_MULT)
  })

  it('crosses the phase thresholds on the way down, and ends at null on the kill', () => {
    const { w, boss, player } = stage()
    const phases = new Set<number>()
    let last = bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')
    for (let shots = 0; shots < 200 && !boss.dead; shots++) {
      shoot(w, boss)
      const bar = bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')
      if (bar) {
        phases.add(bar.phase)
        // Monotonic: the Alpha regenerates only inside an unburnt spore cloud,
        // which this staged fight never provides, so the bar must never grow.
        if (last) expect(bar.hpFrac).toBeLessThanOrEqual(last.hpFrac)
        last = bar
      }
    }
    expect(boss.dead).toBe(true)
    expect(phases.has(1)).toBe(true)
    expect(phases.has(3)).toBe(true)
    expect(bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')).toBeNull()
  })

  it('still drops the bar when the player goes down mid-shatter-fight', () => {
    const { w, boss, player } = stage()
    shoot(w, boss)
    shoot(w, boss)
    expect(bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')).not.toBeNull()

    // The boss is very much alive now that a shatter no longer executes it —
    // which is exactly the case this PR is about: a living boss whose bar would
    // otherwise paint over YOU DIED.
    player.playerCtl!.downed = { bleedTicks: 300, reviveProgress: 0 }
    expect(bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')).toBeNull()

    delete player.playerCtl!.downed
    player.dead = true
    expect(bossBar(frame(w, player), boss.id, 'Mireclaw Alpha')).toBeNull()
  })
})
