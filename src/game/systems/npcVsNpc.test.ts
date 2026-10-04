// #63 — wake the faction matrix: the `threat` consideration scores ANY Hostile
// entity, not only players, so factions fight each OTHER autonomously. Sworn
// enemies (warden↔rootcult) engage from disposition alone; same-faction never turns on
// its own; forcing `aiFlags.npcVsNpc = false` restores the old players-only scan.
//
// Sets exact state, runs the REAL decide()/tickWorld, asserts the behaviour.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { decide } from './behaviors'

const arena = (seed: number, hostile = true): { w: World; cx: number; cy: number } => {
  const w = createWorld(seed, 1, 'normal', hostile)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 12; y <= cy + 12; y++) {
    for (let x = cx - 12; x <= cx + 12; x++) {
      if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) {
        w.level.tiles[y * w.level.w + x] = Tile.Floor
        w.level.solid[y * w.level.w + x] = 0
      }
    }
  }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}

describe('#63 NPC-vs-NPC — decide() scores hostile NPCs, not only players', () => {
  it('a warden and an acolyte in sight both choose to engage EACH OTHER', () => {
    const { w, cx, cy } = arena(1)
    const warden = spawnNpc(w, 'warden', cx, cy)
    warden.ai!.sightRange = 14
    const rootcult = spawnNpc(w, 'acolyte', cx + 4, cy)
    rootcult.ai!.sightRange = 14
    const wardenGoal = decide(w, warden).goal
    const rootcultGoal = decide(w, rootcult).goal
    expect(['battle', 'pursue']).toContain(wardenGoal.code)
    expect(wardenGoal.target).toBe(rootcult.id)
    expect(['battle', 'pursue']).toContain(rootcultGoal.code)
    expect(rootcultGoal.target).toBe(warden.id)
  })

  it('same-faction pair never turns on its own (no friendly fire)', () => {
    const { w, cx, cy } = arena(2)
    const a = spawnNpc(w, 'acolyte', cx, cy)
    a.ai!.sightRange = 14
    const b = spawnNpc(w, 'acolyte', cx + 4, cy)
    b.ai!.sightRange = 14
    expect(decide(w, a).goal.target).not.toBe(b.id)
    expect(decide(w, b).goal.target).not.toBe(a.id)
    // Unrelated factions (warden vs a neutral civilian) likewise ignore each other.
    const civ = spawnNpc(w, 'civilian', cx + 8, cy)
    civ.ai!.sightRange = 14
    const warden = spawnNpc(w, 'warden', cx + 6, cy)
    warden.ai!.sightRange = 14
    expect(decide(w, warden).goal.target).not.toBe(civ.id)
  })

  it('forcing npcVsNpc off restores the old players-only scan', () => {
    const { w, cx, cy } = arena(3)
    w.aiFlags = { npcVsNpc: false }
    const warden = spawnNpc(w, 'warden', cx, cy)
    warden.ai!.sightRange = 14
    const rootcult = spawnNpc(w, 'acolyte', cx + 4, cy)
    rootcult.ai!.sightRange = 14
    expect(decide(w, warden).goal.code).toBe('wander')
    expect(decide(w, rootcult).goal.code).toBe('wander')
  })
})

describe('#63 NPC-vs-NPC — a real firefight erupts from disposition alone', () => {
  it('warden + acolyte 4 tiles apart both reach aggro and trade fire', () => {
    const { w, cx, cy } = arena(4)
    const warden = spawnNpc(w, 'warden', cx, cy)
    warden.ai!.sightRange = 14
    warden.combat!.weapon = 'pistol'
    const rootcult = spawnNpc(w, 'acolyte', cx + 4, cy)
    rootcult.ai!.sightRange = 14
    rootcult.combat!.weapon = 'pistol'
    const input = new Map([[0, emptyInput()]])
    let hits = 0
    let wardenAggroedRootcult = false
    let rootcultAggroedWarden = false
    for (let t = 0; t < 60; t++) {
      tickWorld(w, input)
      for (const ev of w.events) if (ev.type === 'hit') hits++
      if (warden.ai!.mode === 'aggro' && warden.ai!.targetId === rootcult.id) wardenAggroedRootcult = true
      if (rootcult.ai!.mode === 'aggro' && rootcult.ai!.targetId === warden.id) rootcultAggroedWarden = true
    }
    // Both reach aggro on each other from disposition alone (a wounded one may
    // then flee — the #62 fight-or-flight drive, still targeting its enemy).
    expect(wardenAggroedRootcult).toBe(true)
    expect(rootcultAggroedWarden).toBe(true)
    expect(warden.ai!.targetId).toBe(rootcult.id)
    expect(rootcult.ai!.targetId).toBe(warden.id)
    expect(hits).toBeGreaterThanOrEqual(1)
  })

  it('with npcVsNpc off the same pair never engages (0 hits, no aggro)', () => {
    const { w, cx, cy } = arena(4)
    w.aiFlags = { npcVsNpc: false }
    const warden = spawnNpc(w, 'warden', cx, cy)
    warden.ai!.sightRange = 14
    warden.combat!.weapon = 'pistol'
    const rootcult = spawnNpc(w, 'acolyte', cx + 4, cy)
    rootcult.ai!.sightRange = 14
    rootcult.combat!.weapon = 'pistol'
    const input = new Map([[0, emptyInput()]])
    let hits = 0
    for (let t = 0; t < 60; t++) {
      tickWorld(w, input)
      for (const ev of w.events) if (ev.type === 'hit') hits++
    }
    expect(hits).toBe(0)
    expect(warden.ai!.mode).not.toBe('aggro')
    expect(rootcult.ai!.mode).not.toBe('aggro')
  })
})
