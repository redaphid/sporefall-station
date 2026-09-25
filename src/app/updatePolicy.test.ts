import { describe, expect, it } from 'vitest'
import {
  COOP_SAFE_MOMENTS,
  FLOOR_TRANSITION_FRAMES,
  SAFE_MOMENTS,
  UPDATE_MOMENTS,
  decideApply,
  isCoopSafeMoment,
  isSafeMoment,
  momentOf,
  type MomentInputs,
  type UpdateGateState,
  type UpdateMoment,
} from './updatePolicy'

// These tests exist for a NEGATIVE property, not a positive one. The question
// is never "does an update apply at a break" — it is "can an update EVER apply
// anywhere else". A reload during a boss fight loses the run; during co-op it
// takes the other players' session down too. So the suite enumerates the whole
// moment space and asserts the complement of the safe list can never say yes.

const staged = (over: Partial<UpdateGateState> = {}): UpdateGateState => ({
  staged: true,
  applied: false,
  moment: 'inRun',
  peers: 0,
  ...over,
})

/** Every moment that is NOT on the solo safe list. Derived, never hand-listed,
 * so adding a moment to UPDATE_MOMENTS automatically puts it under test. */
const UNSAFE_MOMENTS: readonly UpdateMoment[] = UPDATE_MOMENTS.filter((m) => !isSafeMoment(m))

describe('the safe-moment list itself', () => {
  // Pinned literally: widening the list is a deliberate act that must fail this
  // test and be re-reviewed, not something that slips in with a refactor.
  it('is exactly the four moments where a reload costs the player nothing', () => {
    expect([...SAFE_MOMENTS]).toEqual(['modePicker', 'lobby', 'floorTransition', 'runOver'])
  })

  it('shrinks to the mode picker alone once other players are on the link', () => {
    expect([...COOP_SAFE_MOMENTS]).toEqual(['modePicker'])
  })

  it('partitions the moment space — every moment is explicitly safe or unsafe', () => {
    expect([...UNSAFE_MOMENTS].sort()).toEqual(['inRun', 'paused'])
    expect(SAFE_MOMENTS.length + UNSAFE_MOMENTS.length).toBe(UPDATE_MOMENTS.length)
  })

  it('never treats a pause overlay as a menu — the run behind it is live', () => {
    expect(isSafeMoment('paused')).toBe(false)
  })

  it('keeps the co-op list a strict subset of the solo list', () => {
    for (const moment of COOP_SAFE_MOMENTS) expect(isSafeMoment(moment)).toBe(true)
    expect(COOP_SAFE_MOMENTS.length).toBeLessThan(SAFE_MOMENTS.length)
  })
})

describe('decideApply — the negative property', () => {
  it('NEVER applies at a moment outside the safe list, however ready the update is', () => {
    for (const moment of UNSAFE_MOMENTS) {
      const decision = decideApply(staged({ moment }))
      expect(decision, `moment "${moment}" must never be applied at`).toEqual({
        apply: false,
        why: 'unsafe-moment',
      })
    }
  })

  it('NEVER applies mid networked session outside the mode picker', () => {
    for (const moment of UPDATE_MOMENTS) {
      if (isCoopSafeMoment(moment)) continue
      const decision = decideApply(staged({ moment, peers: 1 }))
      expect(decision, `moment "${moment}" must never reload a player off a live link`).toEqual({
        apply: false,
        why: 'coop-session-live',
      })
    }
  })

  it('refuses the floor break and the run-over screen while friends are connected', () => {
    // These are safe SOLO and would be tempting to allow. They are not safe in
    // co-op: leaving mid-session drops the link, and a client has no local save
    // to resume from the way a solo player does.
    expect(decideApply(staged({ moment: 'floorTransition', peers: 3 }))).toEqual({
      apply: false,
      why: 'coop-session-live',
    })
    expect(decideApply(staged({ moment: 'runOver', peers: 1 }))).toEqual({
      apply: false,
      why: 'coop-session-live',
    })
  })

  it('NEVER applies an update that is not fully staged, at ANY moment', () => {
    for (const moment of UPDATE_MOMENTS) {
      for (const peers of [0, 1, 4]) {
        expect(decideApply({ staged: false, applied: false, moment, peers })).toEqual({
          apply: false,
          why: 'not-staged',
        })
      }
    }
  })

  it('NEVER applies twice — a second report cannot start a reload loop', () => {
    for (const moment of UPDATE_MOMENTS) {
      expect(decideApply(staged({ moment, applied: true }))).toEqual({ apply: false, why: 'already-applied' })
    }
  })

  it('checks staging before the moment, so an unstaged menu is still refused', () => {
    // Ordering matters for the diagnostic: "not-staged" is the honest reason,
    // and it must not be masked by a moment check that happens to also pass.
    expect(decideApply({ staged: false, applied: false, moment: 'modePicker', peers: 0 })).toEqual({
      apply: false,
      why: 'not-staged',
    })
  })
})

describe('decideApply — the positive cases, kept deliberately small', () => {
  it('applies at each safe solo moment', () => {
    for (const moment of SAFE_MOMENTS) {
      expect(decideApply(staged({ moment })), `moment "${moment}"`).toEqual({ apply: true })
    }
  })

  it('applies at the mode picker even with a stale peer count', () => {
    // The picker is by definition outside any session; peers cannot be live here.
    expect(decideApply(staged({ moment: 'modePicker', peers: 2 }))).toEqual({ apply: true })
  })
})

describe('momentOf — naming the moment from what the frame knows', () => {
  const inputs = (o: Partial<MomentInputs> = {}): MomentInputs => ({
    runOver: false,
    floorChanging: false,
    paused: false,
    ...o,
  })

  it('defaults to the UNSAFE moment when nothing special is happening', () => {
    // Fail-closed: an unrecognised situation is ordinary play, never a break.
    expect(momentOf(inputs())).toBe('inRun')
    expect(isSafeMoment(momentOf(inputs()))).toBe(false)
  })

  it('names the run-over overlay', () => expect(momentOf(inputs({ runOver: true }))).toBe('runOver'))
  it('names the floor break', () => expect(momentOf(inputs({ floorChanging: true }))).toBe('floorTransition'))
  it('names a pause as a pause, not a menu', () => expect(momentOf(inputs({ paused: true }))).toBe('paused'))

  it('never reports a safe moment while merely paused mid-floor', () => {
    // The pause overlay is the most menu-LOOKING thing in the game; this is the
    // case most likely to be "fixed" into a bug later.
    expect(isSafeMoment(momentOf(inputs({ paused: true })))).toBe(false)
  })

  it('lets a real break win over a pause', () => {
    // Paused on the run-over screen, or paused across a floor change: both are
    // genuinely safe, and the pause flag must not mask them.
    expect(momentOf(inputs({ paused: true, runOver: true }))).toBe('runOver')
    expect(momentOf(inputs({ paused: true, floorChanging: true }))).toBe('floorTransition')
  })

  it('only ever produces moments that are in the enumerated list', () => {
    const bools = [false, true]
    for (const runOver of bools)
      for (const floorChanging of bools)
        for (const paused of bools)
          expect(UPDATE_MOMENTS).toContain(momentOf({ runOver, floorChanging, paused }))
  })
})

describe('FLOOR_TRANSITION_FRAMES', () => {
  it('holds the break open for a readable window, not one frame and not forever', () => {
    // One frame would make catching it a coin flip; too long would drift back
    // into "mid-run" and reload someone who has already walked off.
    expect(FLOOR_TRANSITION_FRAMES).toBeGreaterThan(1)
    expect(FLOOR_TRANSITION_FRAMES).toBeLessThanOrEqual(60 * 5)
  })
})
