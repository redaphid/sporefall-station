// Essence bubbles through the playtest surfaces: the held-input `step` verb (the
// headless playtester's only hands) and the BLE input codec (a co-op client's).

import { describe, expect, it } from 'vitest'
import { applyScenario } from '../game/scenarios'
import { spawnPlayer } from '../game/player'
import { packStill, STILL_NEXT, STILL_PLANT } from '../game/systems/essence'
import { weaponStack } from '../game/systems/inventory'
import { emptyInput } from '../game/types'
import { createWorld, type World } from '../game/world'
import { decodeInput, encodeInput } from '../net/protocol/messages'
import { heldCmd, parseHeldInput, runVerb } from './verbs'

const lens = (): World => {
  const w = createWorld(7, 1)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  applyScenario(w, 'lens')
  return w
}

const noEdges = { attack: false, interact: false, special: false, roll: false, throwItem: false }

describe('step: vent / still', () => {
  it('"vent": i packs to still = plant i, on the first held tick only', () => {
    const w = lens()
    const h = parseHeldInput(w, '{"vent":2,"attack":true}')
    expect(h.cmd.still).toBe(packStill(STILL_PLANT, 2))
    expect(heldCmd(w, h, 0).still).toBe(packStill(STILL_PLANT, 2))
    expect('still' in heldCmd(w, h, 1)).toBe(false)
    expect(heldCmd(w, h, 1).attack).toBe(true)
  })

  it('raw "still" passes through; both at once, or a bad index, is refused', () => {
    const w = lens()
    expect(parseHeldInput(w, '{"still":258}').cmd.still).toBe(258)
    expect(parseHeldInput(w, '{"vent":"next"}').cmd.still).toBe(packStill(STILL_PLANT, STILL_NEXT))
    expect(() => parseHeldInput(w, '{"still":1,"vent":0}')).toThrow(/not both/)
    for (const bad of ['-1', '256', '1.5', '"x"']) expect(() => parseHeldInput(w, `{"vent":${bad}}`), bad).toThrow()
  })

  it('a held step with vent plants exactly one bubble even over many ticks', () => {
    const w = lens()
    const reply = JSON.parse(runVerb(w, 'step 30 {"vent":0}')) as { events: Record<string, number> }
    expect(reply.events.bubblePlant).toBe(1)
    const p = w.entities.find((e) => e.playerCtl)!
    expect(weaponStack(p)!.mods!.map((m) => m.id)).toEqual(['choke', 'shock', 'bulk'])
  })

  it('look shows the rack (live, stowed, next) and each bubble with charges and time left', () => {
    const w = lens()
    const look = JSON.parse(runVerb(w, 'look')) as {
      essences: string
      player: { rack: { entries: { mod: string; live: boolean; next?: boolean }[] } }
      near: { bubble?: { mod: string; charges: number; ttl: number } }[]
    }
    expect(look.essences).toBe('bubbles')
    expect(look.player.rack.entries[0]).toEqual({ i: 0, mod: 'frost', live: true, next: true })
    expect(look.near.find((n) => n.bubble)?.bubble).toMatchObject({ mod: 'shock', charges: 6, ttl: 600 })
  })

  it('look [radius] [playerId] looks through a teammate', () => {
    const w = lens()
    spawnPlayer(w, 1, w.level.spawn.x, w.level.spawn.y)
    const two = JSON.parse(runVerb(w, 'look 12 1')) as { player: { id: number } }
    expect(w.byId.get(two.player.id)!.playerCtl!.playerId).toBe(1)
  })
})

describe('wire: InputCmd.still', () => {
  it('no vent, no bytes: an ordinary packet is byte-identical to before', () => {
    const cmd = { ...emptyInput(), attack: true }
    const withUndef = { ...cmd, still: undefined }
    expect(encodeInput(withUndef, noEdges)).toEqual(encodeInput(cmd, noEdges))
    expect(encodeInput(cmd, noEdges).length).toBe(9)
  })

  it('round-trips alone and alongside a swap', () => {
    for (const [modSwap, still] of [
      [undefined, packStill(1, 0)],
      [undefined, packStill(1, 7)],
      [0x0102, packStill(1, 3)],
      [0x0102, undefined],
    ] as const) {
      const cmd = { ...emptyInput(), ...(modSwap !== undefined ? { modSwap } : {}), ...(still !== undefined ? { still } : {}) }
      const { cmd: d } = decodeInput(encodeInput(cmd, noEdges))
      expect(d.modSwap).toBe(modSwap)
      expect(d.still).toBe(still)
    }
  })

  it('an older packet with only a swap decodes with no vent', () => {
    const bytes = encodeInput({ ...emptyInput(), modSwap: 5 }, noEdges)
    expect(decodeInput(bytes).cmd.still).toBeUndefined()
  })
})
