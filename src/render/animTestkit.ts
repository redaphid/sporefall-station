// Test kit for the character-animation tests at the entity layer: EntityViews
// over a real createArt registry, fed a tiny fake pack whose every frame is its
// own labelled texture, with the real sim underneath. A trace records what each
// focus entity's sprite (or its death ghost) shows, tick by tick.
//
// Test-only: nothing in the game imports this file.

import { Texture, type Renderer, type Sprite } from 'pixi.js'
import { createEventLog } from '../app/eventLog'
import type { Entity } from '../game/entity'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { spawnHive, spawnRaid, membersOf } from '../game/systems/groups'
import { arm, runTicks, walledRoom, worldFromRows } from '../game/testkit'
import type { InputCmd } from '../game/types'
import type { World } from '../game/world'
import type { AnimStateName } from './animState'
import { createArt, type ArtRegistry, type CharSet, type DirPose } from './art'
import { EntityViews } from './sprites'

const DIRS = ['s', 'se', 'e', 'ne', 'n'] as const
const tex = (label: string): Texture => new Texture({ label })

/** Frames per state a fake pack draws for one kind (absent = not drawn). */
export type FakeClips = Partial<Record<AnimStateName, number>>

/** A pose per direction: legacy idle + step, an 8-frame walk clip, plus the
 * states in `clips` at the given frame counts — every frame its own texture,
 * labelled `<name>.<dir>.<state>.<n>`. */
export const fakeSet = (name: string, clips: FakeClips = {}): CharSet => {
  const set: CharSet = {}
  for (const d of DIRS) {
    const clip = (state: string, n: number): Texture[] => Array.from({ length: n }, (_, k) => tex(`${name}.${d}.${state}.${k}`))
    const pose: DirPose = { idle: tex(`${name}.${d}.idle`), step: tex(`${name}.${d}.step`), clips: { walk: clip('walk', 8) } }
    for (const [s, n] of Object.entries(clips) as [AnimStateName, number][]) pose.clips![s] = clip(s, n)
    set[d] = pose
  }
  return set
}

const fakeRenderer = { generateTexture: () => Texture.EMPTY } as unknown as Renderer

/** Every kind the scenes below render. A kind absent from `clips` gets the
 * plain pack (legacy idle/step + walk). */
export const KINDS = ['player', 'mutant', 'drowner', 'gloamhound', 'lobber', 'hivespire', 'breacher', 'bellwether', 'mender', 'sporeling'] as const

export const fakeArt = (
  clips: Partial<Record<(typeof KINDS)[number], FakeClips>> = {},
  tpf: Partial<Record<AnimStateName, number>> = {},
): ArtRegistry => {
  const chars: Record<string, CharSet> = {}
  for (const k of KINDS) chars[k] = fakeSet(k, clips[k])
  return createArt(fakeRenderer, { chars }, {}, tpf, true)
}

interface ViewInternals {
  views: Map<number, { sprite: Sprite; weapon?: Sprite }>
  ghosts: { id: number; sprite: Sprite }[]
}
const internals = (v: EntityViews): ViewInternals => v as unknown as ViewInternals

export const teleport = (e: Entity, x: number, y: number): void => {
  e.pos = { x, y }
  e.prevPos = { x, y }
}

export interface Scene {
  w: World
  focus: Entity[]
  /** Called before tick i (0-based). */
  before: (i: number) => void
  n: number
  /** Inputs per player slot, every tick. */
  inputs?: Map<number, Partial<InputCmd>>
}

export interface Frame {
  tick: number
  tex: string
  x: number
  y: number
  rot: number
  sx: number
  sy: number
  alpha: number
  weapon: string | null
  /** The sprite is a death ghost (the entity has left the snapshot). */
  ghost?: true
}

export interface TraceOpts {
  /** Render after every `stride`-th tick only (a slow frame running several
   * ticks). Default 1. */
  stride?: number
  /** Ticks on which the entity layer is frozen (hitstop): no update runs. */
  frozen?: (tick: number) => boolean
  /** What the views are handed as the event log: the log main.ts keeps
   * (default), only the rendered tick's own events (`view.events` on a host),
   * or none at all. */
  events?: 'log' | 'lastTick' | 'none'
  /** A kill throws the body (displayBody.ts). Default off: the topple. */
  tumble?: boolean
}

/** Run the scene and record each focus entity's sprite on every rendered tick.
 * The event log is fed after every tick, the way main.ts feeds it. */
export const trace = (scene: Scene, art: ArtRegistry, opts: TraceOpts = {}): Record<number, Frame[]> => {
  const views = new EntityViews(art, { tumble: opts.tumble ?? false })
  views.setLevel(scene.w.level)
  const log = createEventLog()
  const stride = opts.stride ?? 1
  const out: Record<number, Frame[]> = {}
  for (const e of scene.focus) out[e.id] = []
  for (let i = 0; i < scene.n; i++) {
    scene.before(i)
    runTicks(scene.w, scene.inputs ?? new Map(), 1)
    log.afterTick(scene.w.tick, scene.w.events)
    if ((i + 1) % stride !== 0 || opts.frozen?.(scene.w.tick)) continue
    const events =
      opts.events === 'none' ? [] : opts.events === 'lastTick' ? [{ tick: scene.w.tick, events: scene.w.events }] : log.entries
    views.update(scene.w.entities, 0.5, scene.w.tick, scene.w.floor, events)
    for (const e of scene.focus) {
      const v = internals(views).views.get(e.id)
      const g = v ? undefined : internals(views).ghosts.find((x) => x.id === e.id)
      const s = v?.sprite ?? g?.sprite
      if (!s) continue
      out[e.id].push({
        tick: scene.w.tick,
        tex: s.texture.label ?? '?',
        x: s.position.x,
        y: s.position.y,
        rot: s.rotation,
        sx: s.scale.x,
        sy: s.scale.y,
        alpha: s.alpha,
        weapon: v?.weapon ? `${v.weapon.rotation.toFixed(6)}@${v.weapon.position.x.toFixed(3)},${v.weapon.position.y.toFixed(3)}` : null,
        ...(g ? { ghost: true as const } : {}),
      })
    }
  }
  return out
}

/** "<state>.<n>" of a label like "drowner.e.draw.3", or the bare state. */
export const shown = (f: Frame): string => f.tex.split('.').slice(2).join('.')

/** A player who cannot die, so a scene measures the others. */
export const tank = (w: World, x: number, y: number): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.health!.max = 1_000_000
  p.health!.hp = 1_000_000
  return p
}

// ---------------------------------------------------------------------------
// Scenes

/** A player firing east into a mutant that swings its wrench back and dies: attack
 * (melee with a held knife, and the player's pistol), hurt on both, and the
 * hound's death ghost. */
export const brawlScene = (): Scene => {
  const w = worldFromRows(walledRoom(20, 10), { seed: 5 })
  const p = tank(w, 5.5, 5.5)
  arm(p, 'pistol')
  const h = spawnNpc(w, 'mutant', 9.5, 5.5)
  h.health!.max = 90
  h.health!.hp = 90
  return {
    w,
    focus: [p, h],
    before: () => {},
    n: 240,
    inputs: new Map([[0, { attack: true, aimX: 1, aimY: 0 }]]),
  }
}

/** A siege raid: the lobber shells the player from range (`lob` events). */
export const siegeScene = (): Scene => {
  const w = worldFromRows(walledRoom(44, 30), { seed: 21, floor: 4 })
  const p = tank(w, 8.5, 15.5)
  const g = spawnRaid(w, 'siege', { x: 30.5, y: 15.5 }, p)
  const gun = membersOf(w, g.id).find((m) => m.ai!.group!.role === 'artillery')!
  return { w, focus: [gun], before: () => {}, n: 300 }
}

/** A hive spire budding sporelings at a still player (`hiveSpawn`), with its
 * spread timer brought forward so it also roots a sprout (`hiveSpread`). */
export const hiveScene = (): Scene => {
  const w = worldFromRows(walledRoom(30, 16), { seed: 81, floor: 3 })
  const p = tank(w, 6.5, 8.5)
  p.speed = 0
  const spire = spawnHive(w, 18.5, 8.5)
  spire.hive!.nextSpreadAt = 120
  return { w, focus: [spire], before: () => {}, n: 300 }
}
