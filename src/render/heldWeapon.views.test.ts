// The held-weapon overlay, read off the entity layer the game draws with
// (EntityViews over a real createArt registry). Two defects pinned here:
//
// 1. SIZE. The weapon canvas is 44px of drawing room and was hung 1:1 on a 48px
//    character, so every pistol drew nearly as long as the diver holding it
//    (the e2e stills of 2026-11-06: grey barrels half a body long, ~6x the pistol
//    the hand-painted draw clip holds). The overlay must read at hand scale.
// 2. BEASTS. Hounds, stalkers, lurkers, the carapace brute and the Mireclaw
//    Alpha have no hands; they must draw NO held weapon, while every humanoid
//    still draws its own. The rule lives in the weapon table (`natural`), so
//    these tests spawn through the real `spawnNpc` and read what it armed.

import { describe, expect, it } from 'vitest'
import { Graphics, Sprite, Texture, TextureSource, type Renderer } from 'pixi.js'
import { CHAR_PX, createArt, type ArtRegistry } from './art'
import { EntityViews } from './sprites'
import { CANVAS_REACH, HELD_LENGTH, WEAPON_ANCHOR, weaponShape } from './weaponArt'
import { WEAPONS } from '../game/data/items'
import { NPCS } from '../game/data/npcs'
import { spawnNpc } from '../game/populate'
import { worldFromRows, walledRoom } from '../game/testkit'
import { makeEntity, type Entity } from '../game/entity'

/** generateTexture stand-in: a blank texture the size of what was drawn, so a
 * sprite's on-screen extent (texture size x scale) is real geometry. */
const sizedRenderer = {
  generateTexture: (g: Graphics) => {
    const b = g.getLocalBounds()
    const source = new TextureSource({ width: Math.max(1, Math.ceil(b.maxX)), height: Math.max(1, Math.ceil(b.maxY)) })
    return new Texture({ source })
  },
} as unknown as Renderer

interface Rig {
  views: EntityViews
  /** Every texture the registry handed out as a held weapon. */
  weaponTextures: Set<Texture>
}

const rig = (): Rig => {
  const art = createArt(sizedRenderer, {}, {}, {}, true)
  const weaponTextures = new Set<Texture>()
  const wrapped: ArtRegistry = {
    ...art,
    weaponTexture: (id) => {
      const t = art.weaponTexture(id)
      weaponTextures.add(t)
      return t
    },
  }
  return { views: new EntityViews(wrapped), weaponTextures }
}

/** The held-weapon sprites currently on the layer. */
const heldSprites = (r: Rig): Sprite[] =>
  r.views.root.children.filter((c): c is Sprite => c instanceof Sprite && r.weaponTextures.has(c.texture))

/** Draw one frame of `e` and return its held-weapon sprites. */
const drawn = (e: Entity, tick = 100): { r: Rig; held: Sprite[] } => {
  const r = rig()
  r.views.update([e], 0, tick, 0)
  return { r, held: heldSprites(r) }
}

/** Grip-to-tip length of a held sprite in character-canvas px. */
const gripToTip = (s: Sprite): number => s.texture.width * (1 - WEAPON_ANCHOR.x) * Math.abs(s.scale.x)

const npc = (archetype: string): Entity => {
  const w = worldFromRows(walledRoom(8, 8))
  const e = spawnNpc(w, archetype, 4.5, 4.5)
  e.facing = 0
  return e
}

const holding = (weaponId: string, archetype = 'drowner'): Entity => {
  const e = archetype === 'player' ? { ...makeEntity('player', 'player', 4.5, 4.5), id: 1, facing: 0 } : npc(archetype)
  e.combat = { weapon: weaponId, cooldown: 0 }
  return e
}

/** Archetypes whose drawn body has no hands to hold anything (swampspace and
 * swampspace-hires both): the gloam hound, the spider-legged Mireclaw stalker,
 * the gloom-lurker beetle, the four-legged carapace brute, and the crab-bodied
 * Mireclaw Alpha. */
const BEASTS = ['gloamhound', 'stalker', 'lurker', 'brute', 'boss'] as const

/** Archetypes with hands whose table weapon is a carried one. */
const ARMED_HUMANOIDS = Object.values(NPCS)
  .filter((d) => !(BEASTS as readonly string[]).includes(d.archetype) && WEAPONS[d.weapon]?.natural !== true)
  .map((d) => d.archetype)

describe('held weapon SIZE — a pistol is hand-sized, not half a body', () => {
  it('the pistol reads between a sixth and a quarter of the character frame', () => {
    const { held } = drawn(holding('decanter'))
    expect(held).toHaveLength(1)
    const len = gripToTip(held[0])
    expect(len).toBeGreaterThanOrEqual(CHAR_PX / 6)
    expect(len).toBeLessThanOrEqual(CHAR_PX / 4)
  })

  it.each(Object.keys(WEAPONS).filter((id) => !WEAPONS[id].natural))(
    '%s draws at its HELD_LENGTH and under half the character',
    (id) => {
      const { held } = drawn(holding(id))
      expect(held, id).toHaveLength(1)
      const len = gripToTip(held[0])
      // The texture is the full authoring canvas; its grip-to-tip run lands on
      // the shape's held length (a stroke's half-pixel of overhang aside).
      expect(len, id).toBeCloseTo(HELD_LENGTH[weaponShape(id)] * (held[0].texture.width * (1 - WEAPON_ANCHOR.x)) / CANVAS_REACH, 5)
      expect(len, id).toBeGreaterThan(CHAR_PX / 8)
      expect(len, id).toBeLessThan(CHAR_PX / 2)
    },
  )

  it('the mirrored west-half pose keeps the same size (only the y axis flips)', () => {
    const east = drawn(holding('decanter')).held[0]
    const e = holding('decanter')
    e.facing = Math.PI
    const west = drawn(e).held[0]
    expect(Math.abs(west.scale.x)).toBeCloseTo(Math.abs(east.scale.x), 9)
    expect(Math.abs(west.scale.y)).toBeCloseTo(Math.abs(east.scale.y), 9)
    expect(Math.sign(west.scale.y)).toBe(-Math.sign(east.scale.y))
  })

  it('a maxed mod skin grows the pistol but never past a third of the body', () => {
    const e = holding('decanter')
    const mods = [
      { id: 'heavy', stacks: 9 },
      { id: 'rapid', stacks: 9 },
      { id: 'pierce', stacks: 9 },
    ]
    e.loadout = { inventory: [{ itemId: 'decanter', qty: 1, mods }], activeSlot: 0 }
    const plain = gripToTip(drawn(holding('decanter')).held[0])
    const modded = gripToTip(drawn(e).held[0])
    expect(modded).toBeGreaterThan(plain)
    expect(modded).toBeLessThanOrEqual(CHAR_PX / 3)
  })

  it('a melee swing keeps the size through the whole attack window', () => {
    const e = holding('pressureLance')
    const r = rig()
    r.views.update([e], 0, 100, 0)
    const rest = gripToTip(heldSprites(r)[0])
    e.combat!.cooldown = 15 // a swing fired: the renderer reads the cooldown rising
    for (let t = 101; t < 120; t++) {
      r.views.update([e], 0, t, 0)
      expect(gripToTip(heldSprites(r)[0])).toBeCloseTo(rest, 9)
    }
  })
})

describe('held weapon VISIBILITY — beasts bite, people hold', () => {
  it.each(BEASTS)('a %s spawned from its table draws no held weapon', (arch) => {
    const e = npc(arch)
    expect(WEAPONS[e.combat!.weapon].natural, `${arch} wields ${e.combat!.weapon}`).toBe(true)
    const { r, held } = drawn(e)
    expect(held).toHaveLength(0)
    expect(r.weaponTextures.size).toBe(0)
  })

  it.each(BEASTS)('a %s still draws nothing mid-attack or after its weapon wears to fists', (arch) => {
    const e = npc(arch)
    const r = rig()
    r.views.update([e], 0, 100, 0)
    e.combat!.cooldown = 20
    r.views.update([e], 0, 101, 0)
    expect(heldSprites(r)).toHaveLength(0)
    e.combat!.weapon = 'fists'
    r.views.update([e], 0, 102, 0)
    expect(heldSprites(r)).toHaveLength(0)
  })

  it('there are armed humanoids to check (the filter is not vacuous)', () => {
    expect(ARMED_HUMANOIDS).toEqual(expect.arrayContaining(['drowner', 'acolyte', 'mutant', 'bellwether', 'breacher']))
  })

  it.each(ARMED_HUMANOIDS)('a %s spawned from its table still draws its weapon', (arch) => {
    const { held } = drawn(npc(arch))
    expect(held).toHaveLength(1)
  })

  it('the player still draws the pistol', () => {
    const e = holding('decanter', 'player')
    expect(drawn(e).held).toHaveLength(1)
  })

  it('a beast handed a carried weapon (a scenario or debug verb) draws it: the rule is the weapon, not the body', () => {
    expect(drawn(holding('siphonSpike', 'gloamhound')).held).toHaveLength(1)
  })

  it('an unknown weapon id still draws the fallback rod, never nothing', () => {
    expect(drawn(holding('spork-of-doom')).held).toHaveLength(1)
  })

  it('switching a humanoid to a natural weapon removes the sprite it had', () => {
    const e = holding('decanter')
    const r = rig()
    r.views.update([e], 0, 100, 0)
    expect(heldSprites(r)).toHaveLength(1)
    e.combat!.weapon = 'fangs'
    r.views.update([e], 0, 101, 0)
    expect(heldSprites(r)).toHaveLength(0)
  })
})
