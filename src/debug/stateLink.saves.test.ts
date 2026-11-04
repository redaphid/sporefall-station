import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { loadFixture, loadFixtureJson, runTicks } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { populateWorld } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { setupFloor } from '../game/systems/missions'
import { createWorld, tickWorld } from '../game/world'
import { applyFixture } from './record'
import { captureState, isStateLinkPayload, replayRewindChecked, StateRing, verifyStateLink, type StateLinkPayload } from './stateLink'
import { compareWorlds } from './worldCompare'

// `?state=` links and crafted saves are one format: a StateLinkPayload around a
// WorldJson. These pin that an authored world (its own level, no seed-derived
// map) travels through it, and that a seed-generated world travels as a
// checksum.

const STORM: InputCmd = { ...emptyInput(), moveY: -1, aimX: 0, aimY: -1, attack: true }

const viaJson = (p: StateLinkPayload): StateLinkPayload => JSON.parse(JSON.stringify(p)) as StateLinkPayload

describe('state links over authored worlds', () => {
  it('a link captured mid-fight in the crafted castle verifies after a JSON round trip', () => {
    const w = loadFixture('castle-siege')
    const ring = new StateRing(w)
    for (let t = 0; t < 75; t++) {
      const inputs = new Map([[0, { ...STORM, seq: t }]])
      tickWorld(w, inputs)
      ring.observe(w, inputs)
    }
    const payload = viaJson(captureState(w, { note: 'castle gate' }, ring.rewind()))
    expect(isStateLinkPayload(payload)).toBe(true)
    expect(payload.world.level?.rows).toEqual(loadFixtureJson('castle-siege').level?.rows)
    expect(payload.rewind?.world.level?.rows).toEqual(payload.world.level?.rows)
    expect(verifyStateLink(payload)).toMatchObject({ ok: true })
    // The Worker accepts 512 KiB gzipped (worldStore.MAX_COMPRESSED_BYTES); the level text costs little.
    expect(gzipSync(JSON.stringify(payload)).byteLength).toBeLessThan(16 * 1024)
  })

  it('a tampered authored level is caught by the replay check, naming the level', () => {
    const w = loadFixture('castle-siege')
    const ring = new StateRing(w)
    for (let t = 0; t < 10; t++) {
      const inputs = new Map([[0, { ...STORM, seq: t }]])
      tickWorld(w, inputs)
      ring.observe(w, inputs)
    }
    const payload = viaJson(captureState(w, {}, ring.rewind()))
    payload.world.level!.rows[0] = '#' + payload.world.level!.rows[0].slice(1)
    const check = verifyStateLink(payload)
    expect(check.ok).toBe(false)
    expect(check.difference?.path).toBe('level.rows[0]')
    const played = serializeWorld(replayRewindChecked(payload.rewind!).world)
    expect(compareWorlds(payload.world, played)?.path).toBe('level.rows[0]')
  })

  it('a crafted save with no rewind lands on the world and stays playable on fresh input', () => {
    const payload = viaJson(captureState(loadFixture('castle-siege'), { note: 'crafted' }))
    expect(payload.rewind).toBeUndefined()
    expect(verifyStateLink(payload)).toEqual({ ok: true, rewindTicks: 0 })
    const w = deserializeWorld(payload.world)
    const p = w.entities.find((e) => e.playerCtl)!
    runTicks(w, new Map([[0, { moveY: -1 }]]), 30)
    expect(p.pos.y).toBeLessThan(30)
    expect(w.tick).toBe(30)
  })

  it('the debug `world load` path restores an authored save in place, including its mission', () => {
    const live = loadFixture('mid-run')
    applyFixture(live, loadFixtureJson('castle-siege'))
    expect(serializeWorld(live)).toEqual(loadFixtureJson('castle-siege'))
  })
})

describe('state links over seed-generated worlds', () => {
  // A world still on the map its seed+floor generates saves a checksum, not its
  // level, and the link regenerates the map on load.
  const seededLink = (): StateLinkPayload => {
    const w = createWorld(20260715, 1)
    populateWorld(w)
    setupFloor(w)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    const ring = new StateRing(w)
    for (let t = 0; t < 10; t++) {
      const inputs = new Map([[0, { ...emptyInput(), seq: t, moveX: -1, attack: true }]])
      tickWorld(w, inputs)
      ring.observe(w, inputs)
    }
    return viaJson(captureState(w, {}, ring.rewind()))
  }

  it('verifies, and neither world carries a level', () => {
    const p = seededLink()
    expect(p.world.level).toBeUndefined()
    expect(p.rewind?.world.level).toBeUndefined()
    expect(verifyStateLink(p)).toEqual({ ok: true, rewindTicks: 10 })
  })

  it('a corrupted checksum refuses to load', () => {
    const p = seededLink()
    const world = p.rewind!.world as WorldJson & { levelChecksum: number }
    world.levelChecksum = (world.levelChecksum ^ 1) >>> 0
    expect(verifyStateLink(p)).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum drift/) })
  })
})
