// #78 — enemy variety & threat profiles: a damage-AFFINITY axis so different
// enemies DEMAND different tools and a character build matters. Sets exact
// state, runs the REAL damage path (combat.applyDamage) and element DOT tick
// (elementSystem via tickWorld), and asserts the headline property: no single
// weapon/element dominates every enemy, and every enemy has a counter.

import { describe, expect, it } from 'vitest'
import { resistMult } from '../entity'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'
import { addStatus } from './statusFx'

const HUGE = 1e7
const spawn = (arch: string): { w: World; e: ReturnType<typeof spawnNpc> } => {
  const w = createWorld(1, 1)
  const e = spawnNpc(w, arch, 5, 5)
  e.health = { hp: HUGE, max: HUGE, iframes: 0 } // pinned high so nothing dies mid-measure
  return { w, e }
}

/** Effective impact damage a single physical blow of `base` lands. */
const physDamage = (arch: string, base = 20): number => {
  const { w, e } = spawn(arch)
  const before = e.health!.hp
  applyDamage(w, e, base, 0, 0, 0, 999)
  return before - e.health!.hp
}

/** Effective element damage over a fixed 90-tick exposure window. */
const elemDamage = (arch: string, kind: string): number => {
  const { w, e } = spawn(arch)
  addStatus(w, e, kind, 1000)
  const before = e.health!.hp
  const input = new Map([[0, emptyInput()]])
  for (let t = 0; t < 90; t++) tickWorld(w, input)
  return before - e.health!.hp
}

const TOOLS = ['physical', 'burning', 'poisoned'] as const
const damageBy = (arch: string, tool: (typeof TOOLS)[number]): number =>
  tool === 'physical' ? physDamage(arch) : elemDamage(arch, tool)

describe('#78 affinity — the two damage sites honour resist multipliers', () => {
  it('impact damage scales by physical resist (armour) and is rounded', () => {
    expect(physDamage('thug')).toBe(20) // neutral baseline — unchanged
    expect(physDamage('brute')).toBe(7) // 0.35 armour → bullets ping off
    expect(physDamage('cinder')).toBe(22) // 1.1 → soft to impact
    expect(physDamage('robot')).toBe(8) // 0.4 plating
  })

  it('element DOT scales by that element’s resist; immunity (0) does nothing', () => {
    const thugBurn = elemDamage('thug', 'burning')
    expect(thugBurn).toBeGreaterThan(0)
    expect(elemDamage('brute', 'burning')).toBeGreaterThan(thugBurn) // 1.5 flammable
    expect(elemDamage('cinder', 'burning')).toBe(0) // 0.2 fireproof → shrugged off
    expect(elemDamage('sporeling', 'poisoned')).toBe(0) // 0.15 toxin-resist → nothing lands
    expect(elemDamage('sporeling', 'spore')).toBe(0) // spore-immune (matters for the bloom)
    expect(elemDamage('robot', 'spore')).toBe(0) // bio-inert
  })

  it('resistMult is neutral (×1) for anything without a table', () => {
    const { e } = spawn('thug')
    expect(resistMult(e, 'physical')).toBe(1)
    expect(resistMult(e, 'burning')).toBe(1)
    expect(resistMult(e, 'anything')).toBe(1)
  })
})

describe('#78 anti-dominance — no single tool clears the whole roster', () => {
  const ENEMIES = ['brute', 'cinder', 'sporeling', 'robot'] as const
  // Baselines = the neutral townsfolk (thug) per tool.
  const baseline: Record<string, number> = {}
  for (const t of TOOLS) baseline[t] = damageBy('thug', t)
  const strong = (arch: string, t: (typeof TOOLS)[number]): boolean => damageBy(arch, t) >= 0.9 * baseline[t]
  const weak = (arch: string, t: (typeof TOOLS)[number]): boolean => damageBy(arch, t) <= 0.4 * baseline[t]

  it('every tool has at least one enemy it is POOR against (a hard matchup)', () => {
    for (const t of TOOLS) {
      const poorAgainst = ENEMIES.filter((e) => weak(e, t))
      expect(poorAgainst.length, `tool ${t} should struggle against something`).toBeGreaterThanOrEqual(1)
    }
  })

  it('no tool is strong against EVERY enemy (the headline metric)', () => {
    for (const t of TOOLS) {
      const strongAgainstAll = ENEMIES.every((e) => strong(e, t))
      expect(strongAgainstAll, `tool ${t} must NOT dominate the whole roster`).toBe(false)
    }
  })

  it('every enemy has both a counter and a wrong tool — the build choice matters', () => {
    for (const e of ENEMIES) {
      const counters = TOOLS.filter((t) => strong(e, t))
      const wrongTools = TOOLS.filter((t) => weak(e, t))
      expect(counters.length, `${e} needs a clear counter`).toBeGreaterThanOrEqual(1)
      expect(wrongTools.length, `${e} needs a tool that whiffs`).toBeGreaterThanOrEqual(1)
    }
  })

  it('the classic reads hold: burn the brute, shoot the cinder, poison whiffs on the swarm', () => {
    expect(strong('brute', 'burning')).toBe(true)
    expect(weak('brute', 'physical')).toBe(true)
    expect(strong('cinder', 'physical')).toBe(true)
    expect(weak('cinder', 'burning')).toBe(true)
    expect(weak('sporeling', 'poisoned')).toBe(true)
  })
})
