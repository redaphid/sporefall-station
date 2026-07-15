import { describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { applyScenario } from '../game/scenarios'
import { createScriptedInput, SCRIPTS, scriptTicks } from './scripted'

// The e2e videos render these same scripted runs; asserting the sim outcome here
// (no browser) is the fast, deterministic regression guard for every beat.
const play = (scenario: string, script: string) => {
  const steps = SCRIPTS[script]
  const s = new HostSession(7, 'soldier', createScriptedInput(steps))
  applyScenario(s.world, scenario)
  let missionComplete = false
  for (let t = 0; t <= scriptTicks(steps) + 5; t++) {
    s.tick()
    if (s.world.events.some((e) => e.type === 'missionComplete')) missionComplete = true
  }
  const w = s.world
  const player = w.entities.find((e) => e.playerCtl)!
  const door = (x: number) => w.entities.find((e) => e.door && Math.abs(e.pos.x - x) < 0.8 && Math.abs(e.pos.y - 11) < 0.8)
  return { w, player, door, missionComplete, liveThugs: w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length }
}

describe('scripted demo runs are deterministic wins', () => {
  it('demo: opens the door, keeps the pickup, kills both thugs, survives', () => {
    const r = play('demo', 'demo')
    expect(r.w.gameOver).toBe(false)
    expect(r.liveThugs).toBe(0)
    expect(r.player.health!.hp).toBeGreaterThan(0)
    expect(r.door(12)?.door!.open).toBe(true)
  })

  it('doors: unlocked door swings open and the locked one is picked open', () => {
    const r = play('doors', 'doors')
    expect(r.door(6)?.door!.open).toBe(true)
    expect(r.door(11)?.door!.locked).toBe(false)
    expect(r.door(11)?.door!.open).toBe(true)
    expect(r.player.pos.x).toBeGreaterThan(13)
  })

  it('shooting: all three targets are gunned down', () => {
    const r = play('shooting', 'shooting')
    expect(r.liveThugs).toBe(0)
    expect(r.w.gameOver).toBe(false)
  })

  it('mission: completes the objective and clears to floor 2', () => {
    const r = play('mission', 'mission')
    expect(r.missionComplete).toBe(true)
    expect(r.w.floor).toBe(2)
    expect(r.w.gameOver).toBe(false)
  })
})
