// How a character's body moves (motion.ts LOCOMOTION) is a property of the ART
// it is drawn with, not of its sim archetype: the swampspace `cop` is a
// spore-drone and must hover, while the city pack's `cop` is a human and must
// not. These tests drive the entity layer the game draws with (EntityViews over
// a real createArt registry, fed from the real theme manifests) and read the
// sprite transform it produces, so a lookup keyed by the wrong string fails
// here even though locomotionFor() alone would pass.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Texture, type Renderer } from 'pixi.js'
import { createArt, type CharSet, type DirPose, type SpriteTextures } from './art'
import { ANIM_STATES, MAX_ANIM_FRAMES } from './animState'
import { EntityViews } from './sprites'
import {
  BASE_THEME_ID,
  CHAR_NAMES,
  charArtKinds,
  DEFAULT_THEME_ID,
  DIRS5,
  emptyManifest,
  resolveSpritePaths,
  validateManifest,
  type LoadedTheme,
  type ThemeChain,
} from './theme'
import { makeEntity, type Entity } from '../game/entity'
import { SIM_DT } from '../game/types'

const loadTheme = (id: string): LoadedTheme => {
  const raw: unknown = JSON.parse(readFileSync(join(process.cwd(), 'public', 'themes', id, 'manifest.json'), 'utf8'))
  return { id, dir: `themes/${id}/`, manifest: validateManifest(raw).manifest }
}

/** The chain loadThemeChain builds: [active, swampspace base]. */
const chainFor = (id: string): ThemeChain => (id === BASE_THEME_ID ? [loadTheme(id)] : [loadTheme(id), loadTheme(BASE_THEME_ID)])

/** A hand-written pack layered on top of a real chain (it wins every key it maps). */
const overlay = (sprites: Record<string, readonly string[] | null>, under: ThemeChain): ThemeChain => [
  { id: 'overlay', dir: 'themes/overlay/', manifest: { ...emptyManifest(), sprites } },
  ...under,
]

/** What loadSpriteTextures bakes for the character sets, with every file
 * "loading" as a blank texture: a set per char name whose keys resolve, with
 * legacy idle/step plus contiguous `<dir>-<state>-<n>` clips. */
const fakeBake = (chain: ThemeChain): SpriteTextures => {
  const has = (key: string): boolean => (resolveSpritePaths(key, chain)?.length ?? 0) > 0
  const tex = (key: string): Texture | undefined => (has(key) ? Texture.EMPTY : undefined)
  const chars: Record<string, CharSet> = {}
  for (const name of CHAR_NAMES) {
    const set: CharSet = {}
    for (const d of DIRS5) {
      const pose: DirPose = { idle: tex(`char.${name}.${d}-idle`), step: tex(`char.${name}.${d}-step`) }
      const clips: NonNullable<DirPose['clips']> = {}
      for (const s of ANIM_STATES) {
        const frames: Texture[] = []
        for (let n = 0; n < MAX_ANIM_FRAMES && has(`char.${name}.${d}-${s}-${n}`); n++) frames.push(Texture.EMPTY)
        if (frames.length > 0) clips[s] = frames
      }
      if (Object.keys(clips).length > 0) pose.clips = clips
      if (pose.idle || pose.step || pose.clips) set[d] = pose
    }
    if (Object.values(set).some((p) => p.idle || p.clips?.idle?.length)) chars[name] = set
  }
  return { chars, charKinds: charArtKinds(chain) }
}

/** Procedural fallbacks only ever reach generateTexture; a blank one will do. */
const fakeRenderer = { generateTexture: () => Texture.EMPTY } as unknown as Renderer

/** The sprite transform over 120 ticks for one character standing still or
 * walking east: how far it LIFTS (px of vertical travel), WIDENS (range of
 * |scale.x|) and BREATHES (range of scale.y). */
const observe = (chain: ThemeChain, archetype: string, moving: boolean) => {
  const art = createArt(fakeRenderer, fakeBake(chain), {}, {}, true)
  const views = new EntityViews(art)
  const e: Entity = { ...makeEntity('npc', archetype, 10, 10), id: 3, facing: 0 }
  const ys: number[] = []
  const sxs: number[] = []
  const sys: number[] = []
  for (let tick = 200; tick < 320; tick++) {
    if (moving) {
      e.prevPos = { ...e.pos }
      e.pos = { x: e.pos.x + 2 * SIM_DT, y: e.pos.y }
    }
    views.update([e], 0.5, tick, 0)
    const s = views.root.children[0]
    ys.push(s.position.y)
    sxs.push(Math.abs(s.scale.x))
    sys.push(s.scale.y)
  }
  const range = (v: number[]): number => Math.max(...v) - Math.min(...v)
  return { lift: range(ys), widen: range(sxs), breathe: range(sys) }
}

type Gait = 'hover' | 'pulse' | 'stride'

/** Classify a STANDING body: a hoverer floats, a pulser widens, a strider only breathes. */
const idleGait = (chain: ThemeChain, archetype: string): Gait => {
  const o = observe(chain, archetype, false)
  if (o.lift > 0) return 'hover'
  if (o.widen > 0) return 'pulse'
  return 'stride'
}

/** Vertical travel of a WALKING body, in px. The stride's procedural walk bob
 * is ±1.5px; a moving hoverer floats ±2.97px. */
const walkLift = (chain: ThemeChain, archetype: string): number => observe(chain, archetype, true).lift

const HIRES = chainFor(DEFAULT_THEME_ID)
const BASE = chainFor(BASE_THEME_ID)
const CITY = chainFor('city')

describe('locomotion follows the drawn body, at the entity layer', () => {
  it('the swampspace packs draw cop/lurker as fliers (hover) and pod/sporeling as sacs (pulse)', () => {
    for (const [name, chain] of [['swampspace-hires', HIRES], ['swampspace', BASE]] as const) {
      expect(idleGait(chain, 'cop'), `${name} cop = spore-drone`).toBe('hover')
      expect(idleGait(chain, 'lurker'), `${name} lurker = gloom-lurker`).toBe('hover')
      expect(idleGait(chain, 'pod'), `${name} pod = brood-sac`).toBe('pulse')
      expect(idleGait(chain, 'sporeling'), `${name} sporeling = sporeling-mite`).toBe('pulse')
    }
  })

  it('a moving drone floats harder instead of acquiring a walk bob', () => {
    expect(walkLift(HIRES, 'cop')).toBeGreaterThan(4)
  })

  it('the Airlock Warden borrows the cop body, so in swampspace it hovers too', () => {
    expect(idleGait(HIRES, 'bouncer')).toBe('hover')
  })

  it('walkers stride', () => {
    for (const a of ['player', 'thug', 'civilian', 'scientist', 'brute', 'boss', 'gangster', 'robot']) {
      expect(idleGait(HIRES, a), a).toBe('stride')
    }
  })

  it("the city pack's cop is a human: it strides, and so does the bouncer wearing its body", () => {
    expect(idleGait(CITY, 'cop')).toBe('stride')
    expect(idleGait(CITY, 'bouncer')).toBe('stride')
  })

  it('an archetype the active pack does not draw moves like the art it falls through to', () => {
    // city maps no lurker, so the chain draws the swampspace gloom-lurker.
    expect(idleGait(CITY, 'lurker')).toBe('hover')
  })

  it('an odd, missing or hostile idle path strides and never throws', () => {
    const odd = [
      'weird.png',
      'chars/spore-drone.png',
      'chars/spore-drone-e-idle.png',
      'chars/spore-drone-s-idle.webp',
      'chars/SPORE-DRONE-s-idle.png',
      'chars/-s-idle.png',
      '-s-idle.png',
      'chars/spore-drone-s-idle.png/',
      'chars/constructor-s-idle.png',
      'chars/__proto__-s-idle.png',
      'chars/toString-s-idle.png',
      'chars/hasOwnProperty-s-idle.png',
    ]
    for (const path of odd) {
      const chain = overlay({ 'char.cop.s-idle': [path] }, [])
      expect(() => idleGait(chain, 'cop'), path).not.toThrow()
      expect(idleGait(chain, 'cop'), path).toBe('stride')
      expect(() => walkLift(chain, 'cop'), path).not.toThrow()
    }
    // null forces procedural art; an empty chain has no art at all.
    expect(idleGait(overlay({ 'char.cop.s-idle': null }, HIRES), 'cop')).toBe('stride')
    expect(idleGait([], 'cop')).toBe('stride')
  })

  it('the directory part of the path is not the kind', () => {
    expect(idleGait(overlay({ 'char.thug.s-idle': ['/sprites/any/where/spore-drone-s-idle.png'] }, []), 'thug')).toBe(
      'hover',
    )
    expect(idleGait(overlay({ 'char.thug.s-idle': ['/sprites/spore-drone-s-idle/thug.png'] }, []), 'thug')).toBe(
      'stride',
    )
  })
})

describe('drawn cycles are not bobbed twice', () => {
  const drawnLoop = (name: string, kind: string, state: 'idle' | 'walk', count: number): Record<string, string[]> => {
    const out: Record<string, string[]> = {}
    for (const d of DIRS5) {
      for (let n = 0; n < count; n++) out[`char.${name}.${d}-${state}-${n}`] = [`chars/${kind}-${d}-${state}-${n}.png`]
    }
    return out
  }
  const walkFrames = (name: string, kind: string, count: number) => drawnLoop(name, kind, 'walk', count)

  it('a walker whose pack draws its walk cycle gets no procedural bob on top of it', () => {
    // The frog-settler ships 8 drawn walk frames that already carry a head bob;
    // the thug still walks on the legacy idle/step pair and keeps the bob.
    expect(walkLift(HIRES, 'civilian')).toBe(0)
    expect(walkLift(HIRES, 'player')).toBe(0)
    expect(walkLift(HIRES, 'thug')).toBeGreaterThan(2)
  })

  it('a drone whose walk is drawn hover frames floats procedurally only while it stands', () => {
    const chain = overlay(walkFrames('cop', 'spore-drone', 8), HIRES)
    expect(idleGait(chain, 'cop')).toBe('hover')
    expect(walkLift(chain, 'cop')).toBe(0)
  })

  it('a pack that draws the idle loop owns the idle motion too', () => {
    const drone = overlay(drawnLoop('cop', 'spore-drone', 'idle', 4), HIRES)
    expect(observe(drone, 'cop', false)).toEqual({ lift: 0, widen: 0, breathe: 0 })
    const ranger = overlay(drawnLoop('player', 'vine-ranger', 'idle', 4), HIRES)
    expect(observe(ranger, 'player', false).breathe).toBe(0)
    expect(observe(HIRES, 'player', false).breathe).toBeGreaterThan(0)
  })

  it('a one-frame drawn clip is a held pose, not a cycle: the procedural motion stays', () => {
    expect(walkLift(overlay(walkFrames('cop', 'spore-drone', 1), HIRES), 'cop')).toBeGreaterThan(4)
    expect(walkLift(overlay(walkFrames('thug', 'bog-mutant', 1), HIRES), 'thug')).toBeGreaterThan(2)
  })
})
