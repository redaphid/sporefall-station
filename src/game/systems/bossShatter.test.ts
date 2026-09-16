// THE ONE-BUTTON BOSS EXECUTE (design/boss-variety.md §3.1) — adversarial TDD.
//
// The exploit, confirmed in source before it was fixed:
//
//   `combat.applyDamage` executes any frozen NPC outright — `shatter()` sets
//   hp to 0 and kills, IGNORING the blow's damage and the victim's hp pool.
//   `freezeRay` deals 0 damage and applies `frozen` for 120 ticks.
//   => freeze the 320hp Mireclaw Alpha, tap it once with anything, it dies.
//
// Every boss in the game was one-shottable, which makes a health bar a lie.
//
// THE FIX IS SYSTEMIC, NOT A BOSS SPECIAL CASE. `resist[kind] === 0` now means
// genuine IMMUNITY for immobilize statuses (statusFx.applyImmobilize), which is
// the meaning `data/npcs.ts` has documented for the table since #78 and which
// only the DOT path honoured. The boss then declares `resist.frozen = 0` as a
// data row. Nothing in combat.ts changed: the freeze never lands, so the execute
// has no frozen body to fire on.
//
// These tests pin the four properties that fix has to hold simultaneously — it
// is easy to close the exploit by breaking one of the other three.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { serializeWorld, deserializeWorld } from '../serialize'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'
import { applyStatus, addStatus, hasStatus, isFrozen, statusFxSystem } from './statusFx'
import { IMMOBILIZE_IMMUNE_TICKS } from './statusFx'

const world = (): World => createWorld(1, 1, 'normal', true)

/** The freeze ray's real payload (data/items.ts freezeRay.onHit): 0 damage, 120
 * ticks of `frozen`, delivered through `applyStatus` — the single site every
 * item/element effect lands on, which is what the projectile calls on hit. */
const FREEZE_TICKS = 120
const freezeRay = (w: World, target: ReturnType<typeof spawnNpc>): void =>
  applyStatus(w, target, 'frozen', FREEZE_TICKS)

describe('§3.1 the freeze-ray execute no longer deletes a boss', () => {
  it('freeze ray + one tap leaves a full-hp Mireclaw Alpha ALIVE and barely scratched', () => {
    const w = world()
    const boss = spawnNpc(w, 'boss', 10.5, 10.5)
    const full = boss.health!.max
    expect(full).toBe(320) // the fight the bar advertises

    freezeRay(w, boss)
    // The freeze never lands: immunity is refusal, not a shorter duration.
    expect(isFrozen(boss)).toBe(false)

    applyDamage(w, boss, 1, 9, 10, 0, 999)

    expect(boss.dead).toBeFalsy()
    expect(boss.shattered).toBeFalsy()
    // A 1-damage tap against 0.75 physical resist rounds to 1. It took a scratch,
    // not 320. Before the fix this assertion read `hp === 0`.
    expect(boss.health!.hp).toBe(full - 1)
  })

  it('the execute stays dead even under a sustained freeze + beating, through the REAL tick loop', () => {
    // Adversarial: don't just poke the two functions — run tickWorld and keep
    // re-freezing, the way a player holding the trigger actually would.
    const w = world()
    const boss = spawnNpc(w, 'boss', 10.5, 10.5)
    boss.ai!.thinkAt = 1e9 // park its brain; this is about the damage rules
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 60; t++) {
      freezeRay(w, boss)
      boss.health!.iframes = 0 // ignore i-frame spacing — we want maximum pressure
      applyDamage(w, boss, 2, 9, 10, 0, 999)
      tickWorld(w, input)
    }
    expect(boss.dead).toBeFalsy()
    expect(isFrozen(boss)).toBe(false)
    // It lost real hp to the 60 honest blows, and nothing like its whole bar.
    expect(boss.health!.hp).toBeGreaterThan(boss.health!.max * 0.5)
  })

  it('an immune body creates NO fx and NO lockout bookkeeping — snapshots stay byte-stable', () => {
    // The refusal returns BEFORE `e.fx ??= {}` / `e.lockout ??= {}`. If it did
    // not, every boss would start carrying two empty objects it never had, and
    // every committed fixture containing one would stop round-tripping.
    const w = world()
    const boss = spawnNpc(w, 'boss', 10.5, 10.5)
    freezeRay(w, boss)
    expect(boss.fx).toBeUndefined()
    expect(boss.lockout).toBeUndefined()

    const restored = deserializeWorld(serializeWorld(w))
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })
})

describe('§3.1 freeze is STILL a real player tool on ordinary enemies', () => {
  // The cheap fix — deleting the shatter rule — would also "fix" the boss. It
  // would also take a shipped, deliberate execute away from the player. These
  // are the tests that forbid that shortcut.
  it.each(['thug', 'gangster'])('a frozen %s is still executed by a single point of damage', (archetype) => {
    const w = world()
    const npc = spawnNpc(w, archetype, 8.5, 8.5)
    npc.health = { hp: 100, max: 100, iframes: 0 }

    freezeRay(w, npc)
    expect(isFrozen(npc)).toBe(true) // it has no frozen immunity, so the ice lands

    applyDamage(w, npc, 1, 0, 0, 0, -1)

    expect(npc.health!.hp).toBe(0)
    expect(npc.dead).toBe(true)
    expect(npc.shattered).toBe(true)
    expect(w.events.some((ev) => ev.type === 'shatter' && ev.entityId === npc.id)).toBe(true)
  })

  it('immunity is DATA, not an archetype branch: granting it to a thug protects it too', () => {
    // Proof the rule lives in the resist table rather than in a `=== 'boss'`
    // test — which is what makes the next four bosses free.
    const w = world()
    const npc = spawnNpc(w, 'thug', 8.5, 8.5)
    npc.health = { hp: 100, max: 100, iframes: 0 }
    npc.resist = { ...npc.resist, frozen: 0 }

    freezeRay(w, npc)
    expect(isFrozen(npc)).toBe(false)
    applyDamage(w, npc, 1, 0, 0, 0, -1)
    expect(npc.dead).toBeFalsy()
    expect(npc.health!.hp).toBe(99)
  })
})

describe('§3.1 the frozen PLAYER rule is not regressed', () => {
  it('a frozen player has the ice CRACKED by an impact, never shattered', () => {
    const w = world()
    const p = spawnPlayer(w, 0, 5.5, 5.5)
    p.health = { hp: 100, max: 100, iframes: 0 }

    addStatus(w, p, 'frozen', FREEZE_TICKS)
    expect(isFrozen(p)).toBe(true) // players carry no resist table — freeze lands

    applyDamage(w, p, 12, 0, 0, 0, -1)

    expect(p.health!.hp).toBeGreaterThan(0)
    expect(p.playerCtl!.downed).toBeFalsy()
    expect(p.dead).toBeFalsy()
    expect(p.shattered).toBeFalsy()
    expect(isFrozen(p)).toBe(false) // the blow broke the ice
  })
})

describe('§3.1 the anti-chain-lock is untouched', () => {
  it('a non-immune victim still gets no-refresh, the immunity window, and halving', () => {
    // The fix inserts a branch at the TOP of applyImmobilize. A mistake there
    // (falling through, or skipping the bookkeeping) would silently restore the
    // perma-stun this guard exists to prevent.
    const w = world()
    const npc = spawnNpc(w, 'thug', 8.5, 8.5)
    npc.health = { hp: 1e6, max: 1e6, iframes: 0 }

    const grants: number[] = []
    for (let t = 0; t < 400; t++) {
      if (w.tick % 24 === 0) {
        const before = npc.fx?.electrified?.until ?? -1
        addStatus(w, npc, 'electrified', 45)
        const after = npc.fx?.electrified?.until ?? -1
        if (after !== before && after > w.tick) grants.push(after - w.tick)
      }
      statusFxSystem(w)
      w.tick++
    }
    expect(grants).toEqual([45, 22, 11, 5, 2, 1]) // unchanged diminishing ladder
  })

  it('an IMMUNE kind never starts a chain, so it cannot be diminished into landing', () => {
    // Degenerate case worth pinning: immunity must not be "tier 1 of a chain".
    // If the refusal kept the chain hot, a later application could still slip
    // through with a diminished-but-nonzero grant — immunity that expires.
    const w = world()
    const boss = spawnNpc(w, 'boss', 10.5, 10.5)
    for (let t = 0; t < 300; t++) {
      addStatus(w, boss, 'frozen', FREEZE_TICKS)
      statusFxSystem(w)
      w.tick++
    }
    expect(hasStatus(boss, 'frozen')).toBe(false)
    expect(boss.lockout).toBeUndefined()
  })

  it('immunity is per-KIND: the boss still takes electrified, burning and poison', () => {
    // Blanket immobilize-immunity would delete the stun gun from the boss fight.
    // `frozen: 0` must be surgical.
    const w = world()
    const boss = spawnNpc(w, 'boss', 10.5, 10.5)

    addStatus(w, boss, 'electrified', 45)
    expect(hasStatus(boss, 'electrified')).toBe(true) // stun gun still works

    addStatus(w, boss, 'burning', 60)
    expect(hasStatus(boss, 'burning')).toBe(true) // fire is the Alpha's counterplay

    addStatus(w, boss, 'poisoned', 60)
    expect(hasStatus(boss, 'poisoned')).toBe(true)

    // …and the post-lock immunity window still applies to the kind it DOES take.
    expect(boss.lockout!.electrified.guardUntil).toBe(45 + IMMOBILIZE_IMMUNE_TICKS)
  })

  it('a 0-resist DOT still ATTACHES and merely does no damage (the elementSystem contract)', () => {
    // The fix is scoped to immobilize kinds on purpose. `spore: 0` bodies must
    // keep gaining the status — `hasStatus(e,'spore')` is read outside the
    // damage path (infection), so refusing to attach it would change more than
    // damage. This is the blast radius the scoping exists to contain.
    const w = world()
    const sporeling = spawnNpc(w, 'sporeling', 6.5, 6.5)
    addStatus(w, sporeling, 'spore', 60)
    expect(hasStatus(sporeling, 'spore')).toBe(true)
  })
})
