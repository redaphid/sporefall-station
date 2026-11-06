// The held-weapon overlay, read off the entity layer the game draws with
// (EntityViews over a real createArt registry). What is pinned here:
//
// 1. PACK ART ONLY. A weapon draws only when a theme pack ships frames for it
//    (`weapon.<id>.<view>-<state>-<n>`); there is no procedural stand-in, so a
//    weapon nobody has drawn is not held at all. Beasts never hold anything.
// 2. PER-FACING DRAWINGS. Each facing shows its own drawing (mirrored for the
//    west half), never a rotated profile.
// 3. THE PIXEL GRID. The weapon is blitted unscaled (scale exactly ±1, no
//    rotation) at the pack's density, offset from the body by whole art pixels.
// 4. IN THE HAND. Its grip pixel lands on the fist the body frame draws, and the
//    body's own fist is redrawn over it.
//
// The weapon frames below are PLACEHOLDERS (blank textures of a given pixel
// size): the tests need geometry, not looks.

import { describe, expect, it } from 'vitest'
import { Graphics, Sprite, Texture, TextureSource, type Renderer } from 'pixi.js'
import { createArt, type FistBox, type HeldWeaponArt, type SpriteTextures } from './art'
import { EntityViews } from './sprites'
import { WEAPONS } from '../game/data/items'
import { NPCS } from '../game/data/npcs'
import { spawnNpc } from '../game/populate'
import { worldFromRows, walledRoom } from '../game/testkit'
import { makeEntity, type Entity } from '../game/entity'
import { facingDir } from './anim'
import { RING } from './weaponPose'
import type { WeaponView } from './theme'

const sizedRenderer = {
  generateTexture: (g: Graphics) => {
    const b = g.getLocalBounds()
    const source = new TextureSource({ width: Math.max(1, Math.ceil(b.maxX)), height: Math.max(1, Math.ceil(b.maxY)) })
    return new Texture({ source })
  },
} as unknown as Renderer

const GRID = 2 // the hi-res pack: two art pixels per logical unit

/** A blank texture `w`x`h` art pixels at the pack's density. */
const tex = (w: number, h: number, label: string): Texture => {
  const t = new Texture({ source: new TextureSource({ width: w / GRID, height: h / GRID, resolution: GRID }) })
  t.label = label
  return t
}

const VIEWS: WeaponView[] = ['e', 'se', 's', 'ne', 'n']

/** Placeholder art for `id`: every view an idle loop of 2 frames and an
 * `attack`-frame one-shot; grip (3,6), muzzle (14,2). */
const placeholderWeapon = (id: string, attack = 3): HeldWeaponArt => {
  const art: HeldWeaponArt = {}
  for (const v of VIEWS)
    art[v] = {
      idle: [0, 1].map((n) => tex(17, 11, `${id}.${v}-idle-${n}`)),
      attack: Array.from({ length: attack }, (_, n) => tex(17, 11, `${id}.${v}-attack-${n}`)),
      grip: [3, 6],
      muzzle: [14, 2],
    }
  return art
}

/** Body frames: one per drawn facing, 96px art in a 48-unit frame, each with a
 * measured fist at a different place (logical units). */
const BODY = Object.fromEntries(VIEWS.map((d) => [d, tex(96, 96, `body.${d}`)])) as Record<WeaponView, Texture>
const FIST: Record<WeaponView, FistBox> = {
  s: { x0: 30, y0: 26, x1: 34.5, y1: 30.5, gx: 32, gy: 28 },
  se: { x0: 29.5, y0: 26.5, x1: 34, y1: 31, gx: 31.5, gy: 28.5 },
  e: { x0: 20, y0: 25.5, x1: 24.5, y1: 30, gx: 22, gy: 28 },
  ne: { x0: 30, y0: 25, x1: 34, y1: 30, gx: 32, gy: 27.5 },
  n: { x0: 31, y0: 26, x1: 34.5, y1: 31, gx: 32.5, gy: 28.5 },
}
const BODY_SET = Object.fromEntries(VIEWS.map((d) => [d, { idle: BODY[d] }]))

interface Rig {
  views: EntityViews
  weaponTextures: Set<Texture>
}

const rig = (
  weapons: Record<string, HeldWeaponArt> = { rivetDriver: placeholderWeapon('rivetDriver'), pressureLance: placeholderWeapon('pressureLance', 0) },
): Rig => {
  const sprites: SpriteTextures = {
    artScale: GRID,
    weapons,
    chars: Object.fromEntries(Object.values(NPCS).map((d) => [d.archetype, BODY_SET])),
    fists: new Map(VIEWS.map((d) => [BODY[d], FIST[d]])),
  }
  const art = createArt(sizedRenderer, sprites, {}, {}, true)
  const weaponTextures = new Set<Texture>()
  for (const w of Object.values(weapons))
    for (const v of Object.values(w)) for (const t of [...(v?.idle ?? []), ...(v?.attack ?? [])]) weaponTextures.add(t)
  return { views: new EntityViews(art), weaponTextures }
}

const sprites = (r: Rig): Sprite[] => r.views.root.children.filter((c): c is Sprite => c instanceof Sprite)
const held = (r: Rig): Sprite[] => sprites(r).filter((s) => r.weaponTextures.has(s.texture))
const bodyOf = (r: Rig): Sprite => sprites(r).find((s) => Object.values(BODY).includes(s.texture))!
const caps = (r: Rig): Sprite[] => {
  const body = bodyOf(r)
  return sprites(r).filter((s) => s !== body && s.texture.source === body.texture.source)
}

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

const aimedAt = (facing: number): Entity => {
  const e = holding('rivetDriver')
  e.facing = facing
  e.ai!.mode = 'aggro' // engaged: weapon up
  return e
}

const drawn = (e: Entity, r = rig(), tick = 100): Rig => {
  r.views.update([e], 0, tick, 0)
  return r
}

const viewOf = (s: Sprite): string => s.texture.label!.split('.')[1].split('-')[0]
const isMultiple = (v: number, unit: number): boolean => Math.abs(v / unit - Math.round(v / unit)) < 1e-9

/** Every 8-way heading. */
const HEADINGS = RING.map((name, i) => ({ name, facing: (i * Math.PI) / 4 }))

describe('pack art only: no drawn art, nothing held', () => {
  it('a weapon with no pack frames draws nothing (no procedural stand-in)', () => {
    const r = drawn(holding('cageRam'))
    expect(held(r)).toHaveLength(0)
    expect(sprites(r)).toHaveLength(1) // just the body
  })

  it('an unknown weapon id draws nothing', () => {
    expect(sprites(drawn(holding('spork-of-doom')))).toHaveLength(1)
  })

  it('the pistol with pack frames draws exactly one weapon sprite', () => {
    expect(held(drawn(holding('rivetDriver')))).toHaveLength(1)
  })
})

describe('per-facing drawings: each facing shows its own view', () => {
  const expected: Record<string, [string, number]> = {
    e: ['e', 1],
    se: ['se', 1],
    s: ['s', 1],
    sw: ['se', -1],
    w: ['e', -1],
    nw: ['ne', -1],
    n: ['n', 1],
    ne: ['ne', 1],
  }
  it.each(HEADINGS)('aiming $name', ({ name, facing }) => {
    const [w] = held(drawn(aimedAt(facing)))
    expect([viewOf(w), Math.sign(w.scale.x)]).toEqual(expected[name])
  })

  it('a missing view borrows its neighbour rather than vanishing', () => {
    const only = placeholderWeapon('rivetDriver')
    delete only.s
    delete only.se
    const [w] = held(drawn(aimedAt(Math.PI / 2), rig({ rivetDriver: only })))
    expect(viewOf(w)).toBe('e')
  })

  it('low-ready (calm NPC, never fired) lowers the profile gun to the se drawing', () => {
    const e = holding('rivetDriver')
    e.ai!.mode = 'idle'
    expect(viewOf(held(drawn(e))[0])).toBe('se')
  })

  it('a shot raises it: the frame after the cooldown jumps shows the level e drawing', () => {
    const e = holding('rivetDriver')
    e.ai!.mode = 'idle'
    const r = rig()
    r.views.update([e], 0, 100, 0)
    e.combat!.cooldown = 20
    r.views.update([e], 0, 101, 0)
    expect(viewOf(held(r)[0])).toBe('e')
  })
})

describe('the pixel grid: unscaled, unrotated, on whole art pixels', () => {
  it.each(HEADINGS)('$name: scale exactly ±1, rotation 0, offset from the feet a whole art pixel', ({ facing }) => {
    for (const mode of ['aggro', 'idle'] as const) {
      const e = aimedAt(facing)
      e.ai!.mode = mode
      const r = drawn(e)
      const [w] = held(r)
      const body = bodyOf(r)
      expect(Math.abs(w.scale.x)).toBe(1)
      expect(w.scale.y).toBe(1)
      expect(w.rotation).toBe(0)
      expect(w.texture.source.resolution).toBe(GRID)
      expect(isMultiple(w.position.x - body.position.x, 1 / GRID)).toBe(true)
      expect(isMultiple(w.position.y - body.position.y, 1 / GRID)).toBe(true)
      // the anchor is the grip pixel's corner, so the grip lands on a pixel boundary too
      expect(w.anchor.x * w.texture.source.pixelWidth).toBeCloseTo(3, 9)
      expect(w.anchor.y * w.texture.source.pixelHeight).toBeCloseTo(6, 9)
    }
  })

  it('a maxed mod skin tints the weapon but never scales it', () => {
    const e = holding('rivetDriver')
    e.loadout = {
      inventory: [
        {
          itemId: 'rivetDriver',
          qty: 1,
          mods: [
            { id: 'heavy', stacks: 9 },
            { id: 'rapid', stacks: 9 },
          ],
        },
      ],
      activeSlot: 0,
    }
    const [w] = held(drawn(e))
    expect(Math.abs(w.scale.x)).toBe(1)
    expect(w.scale.y).toBe(1)
  })

  it('recoil punches back by whole art pixels only', () => {
    const e = aimedAt(0.3)
    const r = rig()
    r.views.update([e], 0, 100, 0)
    e.combat!.cooldown = 20
    for (let t = 101; t < 108; t++) {
      r.views.update([e], 0.37, t, 0)
      const [w] = held(r)
      const body = bodyOf(r)
      expect(isMultiple(w.position.x - body.position.x, 1 / GRID), `t=${t}`).toBe(true)
      expect(isMultiple(w.position.y - body.position.y, 1 / GRID), `t=${t}`).toBe(true)
    }
  })
})

describe('in the hand: the grip sits on the fist the frame draws', () => {
  it.each(HEADINGS)('$name (aiming and low-ready): grip pixel == fist grip pixel, mirrored with the body', ({ facing }) => {
    for (const mode of ['aggro', 'idle'] as const) {
      const e = aimedAt(facing)
      e.ai!.mode = mode
      const r = drawn(e)
      const [w] = held(r)
      const body = bodyOf(r)
      const { dir, flip } = facingDir(facing)
      const fist = FIST[dir]
      const unit = 1 / GRID
      // The fist's grip pixel on screen spans [left, left+unit).
      const hx = fist.gx - 24
      const left = body.position.x + (flip ? -hx - unit : hx)
      const top = body.position.y + (fist.gy - 48)
      // The weapon's grip pixel on screen.
      const wl = w.scale.x > 0 ? w.position.x : w.position.x - unit
      expect(wl, `${mode} x`).toBeCloseTo(left, 9)
      expect(w.position.y, `${mode} y`).toBeCloseTo(top, 9)
    }
  })

  it('a frame with no measured fist falls back to the per-facing rig, still on the grid', () => {
    const e = aimedAt(0)
    const r = rig()
    // A body frame the fist table does not know: the procedural set of a player.
    const p = holding('rivetDriver', 'player')
    p.facing = 0
    r.views.update([p], 0, 100, 0)
    const [w] = held(r)
    expect(w).toBeDefined()
    expect(Math.abs(w.scale.x)).toBe(1)
    void e
  })

  it('the cap: the body fist is redrawn over the weapon (same texture source, same transform, above it)', () => {
    const r = drawn(aimedAt(0))
    const [w] = held(r)
    const body = bodyOf(r)
    const [cap] = caps(r)
    expect(cap).toBeDefined()
    expect(cap.texture.frame.width).toBeCloseTo(FIST.e.x1 - FIST.e.x0, 9)
    expect(cap.texture.trim.x).toBeCloseTo(FIST.e.x0, 9)
    expect(cap.position.x).toBe(body.position.x)
    expect(cap.scale.x).toBe(body.scale.x)
    expect(cap.zIndex).toBeGreaterThan(w.zIndex)
    expect(w.zIndex).toBeGreaterThan(body.zIndex)
  })

  it('no cap when the muzzle faces the camera; facing away the weapon goes behind the body', () => {
    const s = drawn(aimedAt(Math.PI / 2))
    expect(caps(s)).toHaveLength(0)
    expect(held(s)[0].zIndex).toBeGreaterThan(bodyOf(s).zIndex)
    const n = drawn(aimedAt(-Math.PI / 2))
    expect(caps(n)).toHaveLength(0)
    expect(held(n)[0].zIndex).toBeLessThan(bodyOf(n).zIndex)
  })

  it('weapon z stays within a hair of the body (the depth key is in tiles)', () => {
    const r = drawn(aimedAt(0))
    expect(Math.abs(held(r)[0].zIndex - bodyOf(r).zIndex)).toBeLessThan(0.01)
  })
})

describe('animated: idle loop and attack one-shot', () => {
  it('the idle loop advances with the tick', () => {
    const e = aimedAt(0)
    const r = rig()
    const seen = new Set<string>()
    for (let t = 100; t < 130; t++) {
      r.views.update([e], 0, t, 0)
      seen.add(held(r)[0].texture.label!)
    }
    expect([...seen].sort()).toEqual(['rivetDriver.e-idle-0', 'rivetDriver.e-idle-1'])
  })

  it('a shot plays the attack frames in order over the attack window, then back to idle', () => {
    const e = aimedAt(0)
    const r = rig()
    r.views.update([e], 0, 100, 0)
    e.combat!.cooldown = 20
    const labels: string[] = []
    for (let t = 101; t < 110; t++) {
      r.views.update([e], 0, t, 0)
      labels.push(held(r)[0].texture.label!)
    }
    const attack = labels.filter((l) => l.includes('attack'))
    expect(attack[0]).toBe('rivetDriver.e-attack-0')
    expect(new Set(attack)).toEqual(new Set(['rivetDriver.e-attack-0', 'rivetDriver.e-attack-1', 'rivetDriver.e-attack-2']))
    expect(labels.at(-1)).toMatch(/idle/)
  })

  it('a melee weapon with no drawn swing chops through the per-sector drawings', () => {
    const e = holding('pressureLance')
    const r = rig()
    r.views.update([e], 0, 100, 0)
    e.combat!.cooldown = 15
    const views: string[] = []
    for (let t = 101; t < 108; t++) {
      r.views.update([e], 0, t, 0)
      views.push(viewOf(held(r)[0]))
    }
    expect(views).toContain('n') // raised overhead
    expect(views).toContain('e') // the strike
    expect(views.at(-1)).toBe('se') // back to low
  })
})

/** Archetypes whose drawn body has no hands to hold anything. */
const BEASTS = ['gloamhound', 'stalker', 'lurker', 'brute', 'boss'] as const

const ARMED_HUMANOIDS = Object.values(NPCS)
  .filter((d) => !(BEASTS as readonly string[]).includes(d.archetype) && WEAPONS[d.weapon]?.natural !== true)
  .map((d) => d.archetype)

describe('held weapon VISIBILITY — beasts bite, people hold', () => {
  const everything = (): Record<string, HeldWeaponArt> =>
    Object.fromEntries(Object.keys(WEAPONS).map((id) => [id, placeholderWeapon(id)]))

  it.each(BEASTS)('a %s spawned from its table draws no held weapon, even with art for every id', (arch) => {
    const e = npc(arch)
    expect(WEAPONS[e.combat!.weapon].natural, `${arch} wields ${e.combat!.weapon}`).toBe(true)
    const r = rig(everything())
    r.views.update([e], 0, 100, 0)
    e.combat!.cooldown = 20
    r.views.update([e], 0, 101, 0)
    expect(held(r)).toHaveLength(0)
  })

  it('there are armed humanoids to check (the filter is not vacuous)', () => {
    expect(ARMED_HUMANOIDS).toEqual(expect.arrayContaining(['drowner', 'acolyte', 'mutant', 'bellwether', 'breacher']))
  })

  it.each(ARMED_HUMANOIDS)('a %s spawned from its table draws its weapon when the pack draws it', (arch) => {
    expect(held(drawn(npc(arch), rig(everything())))).toHaveLength(1)
  })

  it('switching a humanoid to a natural weapon removes the sprite and its cap', () => {
    const e = aimedAt(0)
    const r = rig()
    r.views.update([e], 0, 100, 0)
    expect(sprites(r)).toHaveLength(3) // body, weapon, cap
    e.combat!.weapon = 'fangs'
    r.views.update([e], 0, 101, 0)
    expect(sprites(r)).toHaveLength(1)
  })
})
