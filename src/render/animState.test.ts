import { describe, expect, it } from 'vitest'
import {
  ANIM_STATES,
  animFrame,
  DEFAULT_TPF,
  effectiveClips,
  entityPhase,
  HURT_FLASH_TICKS,
  LOOP_STATES,
  MAX_ANIM_FRAMES,
  resolveAnimState,
  resolveClip,
  STATE_FALLBACK,
  STATE_TICKS,
  type AnimClips,
  type AnimInputs,
} from './animState'

const at = (over: Partial<AnimInputs>): AnimInputs => ({ tick: 100, moving: false, ...over })

describe('resolveAnimState — priority (death > roll > hurt > attack > walk > idle)', () => {
  it('idles with no signals', () => {
    expect(resolveAnimState(at({}))).toEqual({ state: 'idle', start: 0 })
  })

  it('walks when moving', () => {
    expect(resolveAnimState(at({ moving: true }))).toEqual({ state: 'walk', start: 0 })
  })

  it('attack beats walk (firing on the run)', () => {
    const r = resolveAnimState(at({ moving: true, attackStart: 98 }))
    expect(r).toEqual({ state: 'attack', start: 98 })
  })

  it('hurt beats attack AND walk simultaneously (hurt while attacking while moving)', () => {
    // hitFlashUntil = hitTick + 3; hit landed at tick 99.
    const r = resolveAnimState(at({ moving: true, attackStart: 99, hitFlashUntil: 102 }))
    expect(r).toEqual({ state: 'hurt', start: 99 })
  })

  it('roll beats hurt, attack and walk', () => {
    const r = resolveAnimState(
      at({ moving: true, attackStart: 99, hitFlashUntil: 102, rollUntil: 108, rollStart: 96 }),
    )
    expect(r).toEqual({ state: 'roll', start: 96 })
  })

  it('death beats everything', () => {
    const r = resolveAnimState(
      at({ moving: true, attackStart: 99, hitFlashUntil: 102, rollUntil: 108, rollStart: 96, deathStart: 100 }),
    )
    expect(r).toEqual({ state: 'death', start: 100 })
  })

  it('every state window closes exactly at start + STATE_TICKS (boundary exclusive)', () => {
    const aStart = 100
    expect(resolveAnimState(at({ tick: aStart + STATE_TICKS.attack - 1, attackStart: aStart })).state).toBe('attack')
    expect(resolveAnimState(at({ tick: aStart + STATE_TICKS.attack, attackStart: aStart })).state).toBe('idle')

    const hitFlashUntil = 103 // hurt starts at 100
    expect(resolveAnimState(at({ tick: 100 + STATE_TICKS.hurt - 1, hitFlashUntil })).state).toBe('hurt')
    expect(resolveAnimState(at({ tick: 100 + STATE_TICKS.hurt, hitFlashUntil })).state).toBe('idle')

    expect(resolveAnimState(at({ tick: 117, deathStart: 100 })).state).toBe('death')
    expect(resolveAnimState(at({ tick: 100 + STATE_TICKS.death, deathStart: 100 })).state).toBe('idle')
  })

  it('roll ends exactly at rollUntil (the sim window, not a render guess)', () => {
    expect(resolveAnimState(at({ tick: 107, rollUntil: 108, rollStart: 96 })).state).toBe('roll')
    expect(resolveAnimState(at({ tick: 108, rollUntil: 108, rollStart: 96 })).state).toBe('idle')
  })

  it('hurt derives its start from hitFlashUntil - HURT_FLASH_TICKS', () => {
    const r = resolveAnimState(at({ tick: 50, hitFlashUntil: 53 }))
    expect(r).toEqual({ state: 'hurt', start: 53 - HURT_FLASH_TICKS })
  })

  it('ADVERSARIAL: hitFlashUntil = 0 (the never-hit sentinel) must not read hurt at boot', () => {
    for (let tick = 0; tick < 10; tick++) {
      expect(resolveAnimState({ tick, moving: false, hitFlashUntil: 0 }).state).toBe('idle')
    }
  })

  it('ADVERSARIAL: stale signals far in the past resolve to locomotion', () => {
    const r = resolveAnimState(at({ tick: 10_000, moving: true, attackStart: 3, hitFlashUntil: 9, deathStart: 50 }))
    expect(r).toEqual({ state: 'walk', start: 0 })
  })

  it('ADVERSARIAL: attackStart in the future (rewind/predict) does not fire early', () => {
    expect(resolveAnimState(at({ tick: 100, attackStart: 105 })).state).toBe('idle')
  })

  it('is a pure function — identical inputs give identical results', () => {
    const input = at({ moving: true, attackStart: 99, hitFlashUntil: 102 })
    expect(resolveAnimState(input)).toEqual(resolveAnimState(input))
  })
})

describe('effectiveClips — legacy idle/step synthesis (backward compat)', () => {
  it('idle+step synthesize the classic 2-frame walk (exactly today’s behavior)', () => {
    const c = effectiveClips({ idle: 'I', step: 'S' })
    expect(c.idle).toEqual(['I'])
    expect(c.walk).toEqual(['I', 'S'])
  })

  it('idle only → a single-frame walk (the stiff-but-valid legacy case)', () => {
    const c = effectiveClips({ idle: 'I' })
    expect(c.walk).toEqual(['I'])
  })

  it('explicit new-grammar clips beat the legacy synthesis', () => {
    const c = effectiveClips({ idle: 'I', step: 'S' }, { walk: ['w0', 'w1', 'w2'], idle: ['i0', 'i1'] })
    expect(c.walk).toEqual(['w0', 'w1', 'w2'])
    expect(c.idle).toEqual(['i0', 'i1'])
  })

  it('empty explicit clips fall back to legacy synthesis (never a dead clip)', () => {
    const c = effectiveClips({ idle: 'I', step: 'S' }, { walk: [], idle: [] })
    expect(c.walk).toEqual(['I', 'S'])
    expect(c.idle).toEqual(['I'])
  })

  it('a pose with nothing yields no idle/walk at all', () => {
    const c = effectiveClips<string>({})
    expect(c.idle).toBeUndefined()
    expect(c.walk).toBeUndefined()
  })
})

describe('resolveClip — per-state fallback chains', () => {
  const full: AnimClips<string> = {
    idle: ['i0'],
    walk: ['w0', 'w1'],
    attack: ['a0', 'a1', 'a2'],
    hurt: ['h0'],
    roll: ['r0'],
    death: ['d0', 'd1'],
  }

  it('a state with its own frames plays them all', () => {
    for (const s of ANIM_STATES) {
      const rc = resolveClip(full, s)
      expect(rc?.source).toBe(s)
      expect(rc?.frames).toEqual(full[s])
    }
  })

  it('attack falls back to WALK FRAME 0 (a held pose, not the walk cycle)', () => {
    const rc = resolveClip({ idle: ['i0'], walk: ['w0', 'w1'] }, 'attack')
    expect(rc).toEqual({ source: 'walk', frames: ['w0'] })
  })

  it('attack falls through walk to idle when only idle exists', () => {
    expect(resolveClip({ idle: ['i0'] }, 'attack')).toEqual({ source: 'idle', frames: ['i0'] })
  })

  it('hurt falls straight to idle (skips walk)', () => {
    expect(resolveClip({ idle: ['i0'], walk: ['w0', 'w1'] }, 'hurt')).toEqual({ source: 'idle', frames: ['i0'] })
  })

  it('death falls to hurt frame 0, then idle', () => {
    expect(resolveClip({ idle: ['i0'], hurt: ['h0', 'h1'] }, 'death')).toEqual({ source: 'hurt', frames: ['h0'] })
    expect(resolveClip({ idle: ['i0'] }, 'death')).toEqual({ source: 'idle', frames: ['i0'] })
  })

  it('roll falls to walk frame 0, then idle', () => {
    expect(resolveClip({ idle: ['i0'], walk: ['w0', 'w1'] }, 'roll')).toEqual({ source: 'walk', frames: ['w0'] })
    expect(resolveClip({ idle: ['i0'] }, 'roll')).toEqual({ source: 'idle', frames: ['i0'] })
  })

  it('walk falls to idle held (matches today’s missing-step behavior)', () => {
    expect(resolveClip({ idle: ['i0', 'i1'] }, 'walk')).toEqual({ source: 'idle', frames: ['i0'] })
  })

  it('ADVERSARIAL: a completely empty theme resolves nothing for every state', () => {
    for (const s of ANIM_STATES) expect(resolveClip({}, s)).toBeUndefined()
  })

  it('every fallback chain starts with the state itself and ends in idle', () => {
    for (const s of ANIM_STATES) {
      expect(STATE_FALLBACK[s][0]).toBe(s)
      expect(STATE_FALLBACK[s][STATE_FALLBACK[s].length - 1]).toBe('idle')
    }
  })
})

describe('animFrame — deterministic frame indexing from tick + entity id', () => {
  it('single-frame clips always show frame 0', () => {
    for (const s of ANIM_STATES) {
      expect(animFrame(s, 1, 12345, 0, DEFAULT_TPF[s], 7)).toBe(0)
      expect(animFrame(s, 0, 5, 0, 6, 7)).toBe(0)
    }
  })

  it('loop states cycle at tpf and wrap', () => {
    // id 0 → phase 0, so the cycle is bare: frames [0,0,0,1,1,1,2,2,2,0,...] at tpf 3.
    const seq = Array.from({ length: 10 }, (_, tick) => animFrame('walk', 3, tick, 0, 3, 0))
    expect(seq).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 0])
  })

  it('the same tick+id always yields the same frame (replay-identical)', () => {
    expect(animFrame('walk', 4, 777, 0, 6, 42)).toBe(animFrame('walk', 4, 777, 0, 6, 42))
    expect(animFrame('attack', 3, 106, 100, 2, 42)).toBe(animFrame('attack', 3, 106, 100, 2, 42))
  })

  it('different entities are phase-shifted (no lockstep crowds) but stay in range', () => {
    const frames = new Set<number>()
    for (let id = 0; id < 12; id++) {
      const f = animFrame('walk', 4, 100, 0, 6, id)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(4)
      frames.add(f)
    }
    expect(frames.size).toBeGreaterThan(1) // at least two distinct phases in a dozen ids
  })

  it('one-shots index from start and HOLD the last frame (never wrap)', () => {
    // 3 frames at tpf 2 from tick 100: 100-101→0, 102-103→1, 104+→2 forever.
    expect(animFrame('attack', 3, 100, 100, 2, 5)).toBe(0)
    expect(animFrame('attack', 3, 103, 100, 2, 5)).toBe(1)
    expect(animFrame('attack', 3, 104, 100, 2, 5)).toBe(2)
    expect(animFrame('attack', 3, 10_000, 100, 2, 5)).toBe(2)
  })

  it('ADVERSARIAL: tick before start clamps to frame 0 (no negative index)', () => {
    expect(animFrame('hurt', 4, 95, 100, 3, 5)).toBe(0)
  })

  it('ADVERSARIAL: tpf 0 / negative / fractional never divides by zero or drifts', () => {
    expect(animFrame('walk', 2, 5, 0, 0, 0)).toBeGreaterThanOrEqual(0)
    expect(animFrame('walk', 2, 5, 0, -3, 0)).toBeGreaterThanOrEqual(0)
    expect(animFrame('attack', 2, 105, 100, 2.7, 0)).toBeLessThan(2)
  })

  it('ADVERSARIAL: negative entity ids still land in range', () => {
    for (let tick = 0; tick < 30; tick++) {
      const f = animFrame('walk', 3, tick, 0, 6, -17)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(3)
    }
  })

  it('legacy walk parity: 2 frames at the default walk tpf alternates every 6 ticks', () => {
    // id 0 keeps the exact pre-feature cadence: cycleFrame(tick, 2, 6).
    for (let tick = 0; tick < 24; tick++) {
      expect(animFrame('walk', 2, tick, 0, DEFAULT_TPF.walk, 0)).toBe(Math.floor(tick / 6) % 2)
    }
  })
})

describe('entityPhase', () => {
  it('is deterministic, non-negative and bounded by the period', () => {
    for (const id of [-5, 0, 1, 7, 999_999]) {
      const p = entityPhase(id, 12)
      expect(p).toBe(entityPhase(id, 12))
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(12)
    }
    expect(entityPhase(3, 0)).toBe(0)
  })
})

describe('constants sanity', () => {
  it('one-shot windows are positive and loops are exactly idle+walk', () => {
    expect(STATE_TICKS.attack).toBeGreaterThan(0)
    expect(STATE_TICKS.hurt).toBeGreaterThan(STATE_TICKS.attack) // hurt lingers past the 3-tick flash
    expect(STATE_TICKS.death).toBeGreaterThan(STATE_TICKS.hurt)
    expect([...LOOP_STATES].sort()).toEqual(['idle', 'walk'])
  })

  it('hurt outlives the sim hit-flash so the state is visible after the white flash', () => {
    expect(STATE_TICKS.hurt).toBeGreaterThan(HURT_FLASH_TICKS)
  })

  it('every state has a default tpf in the manifest-valid range', () => {
    for (const s of ANIM_STATES) {
      expect(Number.isInteger(DEFAULT_TPF[s])).toBe(true)
      expect(DEFAULT_TPF[s]).toBeGreaterThanOrEqual(1)
      expect(DEFAULT_TPF[s]).toBeLessThanOrEqual(30)
    }
  })

  it('MAX_ANIM_FRAMES bounds the manifest key grammar', () => {
    expect(MAX_ANIM_FRAMES).toBe(8)
  })
})

// Cross-check with the sim: the roll window the renderer passes through
// (rollUntil/rollStart) matches systems/roll.ts constants.
import { ROLL_TICKS } from '../game/systems/roll'

describe('roll window coupling', () => {
  it('a full roll resolves roll for exactly ROLL_TICKS ticks', () => {
    const start = 200
    const until = start + ROLL_TICKS
    let rollTicks = 0
    for (let tick = start; tick < until + 10; tick++) {
      const active = tick < until
      const r = resolveAnimState({
        tick,
        moving: true,
        rollUntil: active ? until : undefined,
        rollStart: active ? start : undefined,
      })
      if (r.state === 'roll') rollTicks++
    }
    expect(rollTicks).toBe(ROLL_TICKS)
  })
})
