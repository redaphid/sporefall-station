// #5: a restart affordance must be reachable the moment the local player is
// downed or dead — not only at full game-over — so a host/solo player can restart
// the level immediately instead of waiting out the 30s bleed-out.

import { describe, expect, it } from 'vitest'
import type { RenderView } from '../app/session'
import type { Entity } from '../game/entity'
import { restartAffordance } from './screens'

const self = (over: Partial<Entity['playerCtl']> & { dead?: boolean } = {}): Entity =>
  ({
    dead: over.dead,
    playerCtl: { downed: over.downed, playerId: 0, classId: 'soldier' },
  }) as unknown as Entity

const view = (over: Partial<RenderView>): RenderView =>
  ({ gameOver: false, self: self(), ...over }) as RenderView

describe('restartAffordance — when the restart overlay should be reachable', () => {
  it('hidden during normal play (alive, standing, not game-over)', () => {
    expect(restartAffordance(view({}))).toEqual({ visible: false, reason: null })
  })

  it('visible at full game-over', () => {
    expect(restartAffordance(view({ gameOver: true }))).toEqual({ visible: true, reason: 'gameOver' })
  })

  it('visible while the local player is DOWNED (bleeding out) — the key fix', () => {
    const v = view({ self: self({ downed: { bleedTicks: 900, reviveProgress: 0 } }) })
    expect(restartAffordance(v)).toEqual({ visible: true, reason: 'downed' })
  })

  it('visible once the local player is DEAD', () => {
    expect(restartAffordance(view({ self: self({ dead: true }) }))).toEqual({ visible: true, reason: 'dead' })
  })

  it('game-over takes precedence over a downed self', () => {
    const v = view({ gameOver: true, self: self({ downed: { bleedTicks: 1, reviveProgress: 0 } }) })
    expect(restartAffordance(v).reason).toBe('gameOver')
  })

  it('no self (spectator/loading) → hidden', () => {
    expect(restartAffordance(view({ self: undefined }))).toEqual({ visible: false, reason: null })
  })
})
