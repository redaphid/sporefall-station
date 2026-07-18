import { describe, expect, it } from 'vitest'
import { missionChipText, missionObjectives, resolveLink, type MissionViewLike } from './missionModel'

const ent = (id: number, x = 10, y = 10, dead = false): { id: number; dead?: boolean; pos: { x: number; y: number } } => ({
  id,
  dead,
  pos: { x, y },
})

const base = (over: Partial<MissionViewLike> = {}): MissionViewLike => ({
  floor: 1,
  missionText: 'Steal the briefcase from the bar',
  missionComplete: false,
  gameOver: false,
  missionTargetId: 7,
  entities: [ent(7)],
  exit: { x: 40, y: 40 },
  ...over,
})

describe('missionObjectives — happy paths', () => {
  it('an incomplete steal/assassinate mission is an active row LINKED to the live target, plus a locked exit', () => {
    const rows = missionObjectives(base())
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: 'mission', state: 'active', link: { targetId: 7 } })
    expect(rows[1]).toMatchObject({ key: 'exit', state: 'locked' })
    expect(rows[1].link).toBeUndefined() // locked exit is not tappable
  })

  it('completing the mission marks the row done (link dropped) and unlocks + links the exit at its tile centre', () => {
    const rows = missionObjectives(base({ missionComplete: true }))
    expect(rows[0]).toMatchObject({ key: 'mission', state: 'done' })
    expect(rows[0].link).toBeUndefined()
    expect(rows[1]).toMatchObject({ key: 'exit', state: 'active', link: { x: 40.5, y: 40.5 } })
  })

  it('a `reach` mission collapses to the single exit row (no duplicate rows)', () => {
    const rows = missionObjectives(base({ missionText: 'Reach the exit', missionComplete: true, missionTargetId: undefined }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'exit', state: 'active' })
    // Case/whitespace-insensitive dedupe.
    expect(missionObjectives(base({ missionText: '  reach THE exit ', missionComplete: true }))).toHaveLength(1)
  })
})

describe('missionObjectives — degenerate/adversarial', () => {
  it('game over → no rows at all (the restart overlay owns the screen)', () => {
    expect(missionObjectives(base({ gameOver: true }))).toEqual([])
    expect(missionObjectives(base({ gameOver: true, missionComplete: true }))).toEqual([])
  })

  it('a DEAD target drops the link but keeps the objective row', () => {
    const rows = missionObjectives(base({ entities: [ent(7, 10, 10, true)] }))
    expect(rows[0].state).toBe('active')
    expect(rows[0].link).toBeUndefined()
  })

  it('a DESPAWNED target (id no longer present) drops the link', () => {
    const rows = missionObjectives(base({ entities: [] }))
    expect(rows[0].link).toBeUndefined()
  })

  it('no missionTargetId (client on an older host) → no link, row still renders', () => {
    const rows = missionObjectives(base({ missionTargetId: undefined }))
    expect(rows[0].link).toBeUndefined()
    expect(rows[0].text).toBe('Steal the briefcase from the bar')
  })

  it('no exit info (client before the level arrives) → only the mission row', () => {
    const rows = missionObjectives(base({ exit: undefined }))
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('mission')
  })

  it('a client placeholder text ("Connecting…") renders as a plain unlinked row', () => {
    const rows = missionObjectives(base({ missionText: 'Connecting…', missionTargetId: undefined, entities: [], exit: undefined }))
    expect(rows).toEqual([{ key: 'mission', text: 'Connecting…', state: 'active', link: undefined }])
  })
})

describe('missionChipText', () => {
  it('mirrors the old one-line readout in both states', () => {
    expect(missionChipText({ floor: 3, missionText: 'Take out the boss', missionComplete: false })).toBe(
      'Floor 3 — Take out the boss',
    )
    expect(missionChipText({ floor: 3, missionText: 'Take out the boss', missionComplete: true })).toBe(
      'Floor 3 — EXIT is open!',
    )
  })
})

describe('resolveLink', () => {
  it('resolves an entity link to the entity’s LIVE position', () => {
    expect(resolveLink({ targetId: 7 }, [ent(7, 3.25, 4.5)])).toEqual({ x: 3.25, y: 4.5 })
  })
  it('returns undefined for a dead or despawned entity (link dies mid-flight)', () => {
    expect(resolveLink({ targetId: 7 }, [ent(7, 3, 4, true)])).toBeUndefined()
    expect(resolveLink({ targetId: 7 }, [])).toBeUndefined()
  })
  it('resolves a point link as-is and rejects non-finite points', () => {
    expect(resolveLink({ x: 15.5, y: 11.5 }, [])).toEqual({ x: 15.5, y: 11.5 })
    expect(resolveLink({ x: Number.NaN, y: 11.5 }, [])).toBeUndefined()
    expect(resolveLink({ x: Infinity, y: 11.5 }, [])).toBeUndefined()
  })
  it('rejects an entity with a non-finite position (never hand the camera NaN)', () => {
    expect(resolveLink({ targetId: 7 }, [ent(7, Number.NaN, 4)])).toBeUndefined()
  })
  it('an empty link resolves to nothing', () => {
    expect(resolveLink({}, [ent(7)])).toBeUndefined()
  })
})
