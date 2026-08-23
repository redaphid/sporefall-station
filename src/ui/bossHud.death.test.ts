// @vitest-environment happy-dom
//
// THE REPORTED BUG: "There's a bug where I still see the boss health bar when I
// die in sporefall."
//
// bossModel.test.ts pins the pure rule. This file pins the thing the player
// actually complained about: the real <div> built by createScreens, driven by
// real RenderViews, must be display:none the moment the local player goes down.
//
// It is a DOM test on purpose. The model could be perfectly correct and the bar
// still be on screen — the HUD element is only ever hidden by the `!bar` branch
// of updateBoss, so nothing but an assertion on the element itself proves the
// fix reaches the glass. The element carries z-index:66 while the restart
// overlay carries none, so a bar left up does not sit politely behind the YOU
// DIED scrim; it sits on top of it.

import { beforeEach, describe, expect, it } from 'vitest'
import type { RenderView } from '../app/session'
import { makeEntity, type Entity } from '../game/entity'
import type { SimEvent } from '../game/types'
import { playerOutOfFight } from './bossModel'
import { createScreens, restartAffordance } from './screens'

const BOSS_ID = 42

const boss = (hp = 320): Entity => {
  const e = makeEntity('npc', 'boss', 5, 5)
  e.id = BOSS_ID
  e.health = { hp, max: 320, iframes: 0 }
  return e
}

const player = (over: { dead?: boolean; downed?: boolean } = {}): Entity => {
  const e = makeEntity('player', 'player', 1, 1)
  e.id = 1
  e.health = { hp: over.dead ? 0 : 100, max: 100, iframes: 0 }
  e.dead = over.dead
  e.playerCtl = {
    playerId: 0,
    ...(over.downed ? { downed: { bleedTicks: 900, reviveProgress: 0 } } : {}),
  } as Entity['playerCtl']
  return e
}

/** A minimal but structurally honest RenderView. */
const view = (over: Partial<RenderView> = {}): RenderView =>
  ({
    entities: [],
    events: [] as SimEvent[],
    tick: 1,
    level: { w: 40, h: 40 },
    floor: 3,
    missionText: '',
    missionComplete: false,
    gameOver: false,
    self: player(),
    ...over,
  }) as RenderView

const reveal = (): SimEvent => ({ type: 'bossReveal', entityId: BOSS_ID, x: 5, y: 5, maxHp: 320 })

/** The live boss health bar element, found the way a player finds it: on screen. */
const hud = (mount: HTMLElement): HTMLElement => {
  const el = mount.querySelector('#bossName')?.parentElement
  if (!el) throw new Error('boss HUD not found — createScreens changed shape')
  return el
}
const visible = (mount: HTMLElement): boolean => hud(mount).style.display !== 'none'

describe('the boss health bar and the death screen', () => {
  let mount: HTMLElement

  beforeEach(() => {
    document.body.innerHTML = ''
    mount = document.createElement('div')
    document.body.appendChild(mount)
  })

  /** Fight a revealed, healthy boss for a few frames. Returns the screens. */
  const engageBoss = (): ReturnType<typeof createScreens> => {
    const screens = createScreens(mount, () => {})
    screens.update(view({ tick: 10, entities: [boss()], events: [reveal()] }))
    screens.update(view({ tick: 11, entities: [boss(200)] }))
    return screens
  }

  it('shows the bar during the fight (the control — without this the rest proves nothing)', () => {
    engageBoss()
    expect(visible(mount)).toBe(true)
  })

  it('REGRESSION: hides the bar the frame the player DIES, with the boss still at full health', () => {
    const screens = engageBoss()
    expect(visible(mount)).toBe(true)

    screens.update(view({ tick: 12, entities: [boss(200), player({ dead: true })], self: player({ dead: true }) }))

    expect(visible(mount)).toBe(false)
  })

  it('hides the bar while the player is DOWNED and bleeding out', () => {
    const screens = engageBoss()
    screens.update(view({ tick: 12, entities: [boss(200)], self: player({ downed: true }) }))
    expect(visible(mount)).toBe(false)
  })

  it('hides the bar at GAME OVER', () => {
    const screens = engageBoss()
    screens.update(view({ tick: 12, entities: [boss(200)], gameOver: true }))
    expect(visible(mount)).toBe(false)
  })

  it('brings the bar back on a revive — the fight is still on', () => {
    const screens = engageBoss()
    screens.update(view({ tick: 12, entities: [boss(200)], self: player({ downed: true }) }))
    expect(visible(mount)).toBe(false)

    screens.update(view({ tick: 40, entities: [boss(200)], self: player() }))
    expect(visible(mount)).toBe(true)
  })

  it('stays hidden across MANY dead frames, not just the first one', () => {
    const screens = engageBoss()
    for (let t = 12; t < 30; t++) {
      screens.update(view({ tick: t, entities: [boss(200)], self: player({ dead: true }) }))
      expect(visible(mount)).toBe(false)
    }
  })

  it('the death overlay is up on exactly the frames the bar is down', () => {
    const screens = createScreens(mount, () => {})
    const overlay = mount.querySelector<HTMLElement>('#headline')!.parentElement!
    screens.update(view({ tick: 10, entities: [boss()], events: [reveal()] }))
    expect([visible(mount), overlay.style.display]).toEqual([true, 'none'])

    screens.update(view({ tick: 11, entities: [boss()], self: player({ dead: true }) }))
    expect([visible(mount), overlay.style.display]).toEqual([false, 'flex'])
  })

  // -------------------------------------------------------------------------
  // "Run it back" — the adjacent case. screens is built ONCE (main.ts) and
  // never rebuilt, but restart rebuilds the world in place and recycles entity
  // ids from 1. A latch carried across that boundary re-binds the Alpha's name
  // plate to whatever floor-1 enemy inherits its id.
  // -------------------------------------------------------------------------

  it('REGRESSION: a restart does not resurrect the bar on an id-recycled enemy', () => {
    const screens = createScreens(mount, () => {})
    screens.update(view({ tick: 900, entities: [boss()], events: [reveal()] }))
    expect(visible(mount)).toBe(true)

    // Death, then "Run it back": a brand-new world, tick back to 0, and an
    // ordinary thug that happens to be handed the dead boss's id.
    screens.update(view({ tick: 901, entities: [boss()], self: player({ dead: true }) }))
    const thug = makeEntity('npc', 'thug', 9, 9)
    thug.id = BOSS_ID
    thug.health = { hp: 30, max: 30, iframes: 0 }

    screens.update(view({ tick: 0, floor: 1, entities: [thug] }))

    expect(visible(mount)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // The entrance card (z-index:70), caught by the before/after screenshot and
  // not by the first cut of this fix. Gating the REVEAL is not enough: the card
  // dwells for 2.6s, so dying just after the entrance leaves it hanging over
  // YOU DIED, where the two headlines overprint into unreadable mush.
  // -------------------------------------------------------------------------

  /** The entrance card: the mount's own child sitting at z-index 70. */
  const card = (): HTMLElement => {
    const el = [...mount.children].find((c) => (c as HTMLElement).style.zIndex === '70')
    if (!el) throw new Error('boss entrance card not found — createScreens changed shape')
    return el as HTMLElement
  }

  it('REGRESSION: takes down an entrance card that was ALREADY up when the player died', () => {
    const screens = createScreens(mount, () => {})
    screens.update(view({ tick: 10, entities: [boss()], events: [reveal()] }))
    expect(card().style.opacity).toBe('1') // the entrance is playing

    screens.update(view({ tick: 11, entities: [boss()], self: player({ dead: true }) }))

    expect(card().style.opacity).toBe('0')
  })

  it('never raises a card at all for a reveal that fires while the player is down', () => {
    const screens = createScreens(mount, () => {})
    screens.update(view({ tick: 10, self: player({ dead: true }), entities: [boss()], events: [reveal()] }))
    expect(card().style.opacity).toBe('0')
  })

  it('control: the card DOES play for a reveal while the player is up', () => {
    const screens = createScreens(mount, () => {})
    screens.update(view({ tick: 10, entities: [boss()], events: [reveal()] }))
    expect(card().style.opacity).toBe('1')
  })

  it('does not drop the bar merely because the tick repeats or stalls', () => {
    const screens = engageBoss()
    screens.update(view({ tick: 11, entities: [boss(200)] }))
    screens.update(view({ tick: 11, entities: [boss(200)] }))
    expect(visible(mount)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The anti-drift device.
//
// `playerOutOfFight` (bossModel) and `restartAffordance` (screens) encode the
// same condition in two places, because screens.ts imports bossModel and so
// bossModel cannot import back. Two copies of one rule is exactly how a fix
// rots: someone teaches the overlay about a new state and the boss bar never
// hears about it. This test is what stops that being silent.
// ---------------------------------------------------------------------------

describe('playerOutOfFight tracks restartAffordance exactly', () => {
  const cases: Array<[string, Partial<RenderView>]> = [
    ['alive and standing', {}],
    ['dead', { self: player({ dead: true }) }],
    ['downed', { self: player({ downed: true }) }],
    ['game over', { gameOver: true }],
    ['game over AND dead', { gameOver: true, self: player({ dead: true }) }],
    ['dead AND downed', { self: player({ dead: true, downed: true }) }],
    ['no self at all', { self: undefined }],
    ['no self, game over', { self: undefined, gameOver: true }],
  ]

  for (const [name, over] of cases) {
    it(`agrees for: ${name}`, () => {
      const v = view(over)
      expect(playerOutOfFight(v)).toBe(restartAffordance(v).visible)
    })
  }
})
