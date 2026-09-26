// @vitest-environment happy-dom
// PR #98 review: at the couch, a player who has picked is back in a live fight,
// so the draft must stop covering the shared screen. These tests run the real
// sim (a populated floor, the real exit trigger and draftSystem), feed the
// result through the same `localDraft` main.ts uses, and check the overlay.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { playerSpawnPoint } from '../game/spawnPlacement'
import { runTicks } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { createWorld, tickWorld, type World } from '../game/world'
import { setupFloor } from '../game/systems/missions'
import { createDraftScreen, localDraft, type DraftLayout } from './draftScreen'

const run = (players: number): World => {
  const w = createWorld(7, 1)
  populateWorld(w)
  setupFloor(w)
  for (let i = 0; i < players; i++) {
    const at = playerSpawnPoint(w.level, i)
    spawnPlayer(w, i, at.x, at.y)
  }
  return deserializeWorld(serializeWorld(w))
}

const player = (w: World, id: number): Entity => w.entities.find((e) => e.playerCtl?.playerId === id)!

const takeExit = (w: World): void => {
  w.mission.exitUnlocked = true
  const p = player(w, 0)
  p.pos.x = p.prevPos.x = w.level.exit.x + 0.5
  p.pos.y = p.prevPos.y = w.level.exit.y + 0.5
  tickWorld(w, new Map())
}

const step = (w: World, cmds: Record<number, Partial<InputCmd>>): void =>
  tickWorld(w, new Map(Object.entries(cmds).map(([k, c]) => [Number(k), { ...emptyInput(), ...c }])))

/** Draw one frame the way main.ts does and return the overlay root. */
const frame = (w: World, localIds: number[], self = player(w, 0), answeredUntil = -1) => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const screen = createDraftScreen(el, () => {})
  const d = localDraft(w.entities, new Set(localIds), self, answeredUntil)
  const layout: DraftLayout = d.inPlay ? 'strip' : 'full'
  screen.update(d.offer, d.seats, 10, layout)
  const root = el.querySelector<HTMLDivElement>('.draft-screen')!
  const cards = [...el.querySelectorAll<HTMLButtonElement>('.draft-card')]
  return { d, screen, root, cards }
}

/** Does the overlay keep the world visible and clickable outside the cards? */
const leavesWorldVisible = (root: HTMLDivElement): boolean =>
  root.style.pointerEvents === 'none' &&
  !/rgba\(6, ?8, ?14/.test(root.style.background) &&
  !/blur/.test(root.style.backdropFilter) &&
  root.style.top !== '0px' &&
  !/inset/.test(root.style.cssText)

describe('floor draft at the couch', () => {
  it('while every local player is choosing, the hand takes the whole screen', () => {
    const w = run(2)
    takeExit(w)
    const { d, screen, root, cards } = frame(w, [0, 1])
    expect(d.seats.map((s) => s.playerId)).toEqual([0, 1])
    expect(d.inPlay).toBe(false)
    expect(screen.layout).toBe('full')
    expect(root.style.display).toBe('flex')
    expect(leavesWorldVisible(root)).toBe(false)
    expect(cards).toHaveLength(3)
  })

  it('once P1 picks, P1 sees the fight: the hand becomes an undimmed click-through strip for P2', () => {
    const w = run(2)
    takeExit(w)
    step(w, { 0: { draftPick: 0 } })
    expect(player(w, 0).playerCtl!.draft).toBeUndefined()
    expect(player(w, 1).playerCtl!.draft).toBeDefined()
    // The sim keeps running while P2 dithers; the strip stays for the whole wait.
    runTicks(w, new Map([[0, { ...emptyInput(), moveX: 1 }]]), 60)
    const { d, screen, root, cards } = frame(w, [0, 1])
    expect(d.seats).toEqual([{ playerId: 1, cursor: 0 }])
    expect(d.inPlay).toBe(true)
    expect(screen.visible).toBe(true)
    expect(screen.layout).toBe('strip')
    expect(leavesWorldVisible(root)).toBe(true)
    // P2 can still tap a card, and the cards shrink off the playfield.
    expect(cards).toHaveLength(3)
    for (const c of cards) {
      expect(c.style.pointerEvents).toBe('auto')
      expect(parseInt(c.style.width)).toBeLessThanOrEqual(120)
    }
  })

  it('switches back and forth on the same hand without rebuilding the cards', () => {
    const w = run(2)
    takeExit(w)
    const el = document.createElement('div')
    const screen = createDraftScreen(el, () => {})
    const offer = player(w, 0).playerCtl!.draft!.offer
    screen.update(offer, [{ playerId: 0, cursor: 0 }, { playerId: 1, cursor: 0 }], 10, 'full')
    const first = el.querySelector('.draft-card')
    screen.update(offer, [{ playerId: 1, cursor: 2 }], 9, 'strip')
    expect(el.querySelector('.draft-card')).toBe(first)
    expect(screen.layout).toBe('strip')
    expect(el.querySelectorAll('.draft-card')[2].textContent).toContain('P2')
    screen.update(offer, [{ playerId: 1, cursor: 2 }], 9, 'full')
    expect(screen.layout).toBe('full')
    expect((el.querySelector('.draft-screen') as HTMLElement).style.pointerEvents).toBe('auto')
  })

  it('a remote peer who picked does not shrink this screen: only local players count', () => {
    const w = run(2)
    takeExit(w)
    step(w, { 1: { draftPick: 0 } })
    const { d, screen } = frame(w, [0])
    expect(d.inPlay).toBe(false)
    expect(screen.layout).toBe('full')
  })

  it('a dead local teammate is not "in play", so it does not shrink the hand', () => {
    const w = run(2)
    takeExit(w)
    step(w, { 1: { draftPick: 0 } })
    player(w, 1).dead = true
    const { d, screen } = frame(w, [0, 1])
    expect(d.inPlay).toBe(false)
    expect(screen.layout).toBe('full')
  })

  it('a net client that tapped (seat hidden until the host answers) with a couch partner still choosing gets the strip', () => {
    const w = run(2)
    takeExit(w)
    const self = player(w, 0)
    const { d, screen } = frame(w, [0, 1], self, self.playerCtl!.draft!.until)
    expect(d.seats.map((s) => s.playerId)).toEqual([1])
    expect(d.inPlay).toBe(true)
    expect(screen.layout).toBe('strip')
  })

  it('hides entirely when nobody local holds a hand', () => {
    const w = run(2)
    takeExit(w)
    step(w, { 0: { draftPick: 0 }, 1: { draftPick: 1 } })
    const { d, screen, root } = frame(w, [0, 1])
    expect(d.offer).toBeNull()
    expect(screen.visible).toBe(false)
    expect(root.style.display).toBe('none')
  })
})
