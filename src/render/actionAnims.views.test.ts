// draw and fidget at the entity layer the game draws with: EntityViews over a
// real createArt registry, fed a tiny fake pack whose every frame is its own
// labelled texture, and the real sim underneath. The tests read back which
// frame each sprite shows, tick by tick.
//
// The GOLDEN half pins "a pack without the new frames renders exactly as
// today": the per-tick sprite trace (texture, position, rotation, scale, alpha,
// held weapon) is recorded from origin/main's renderer and must not move by a
// bit (stored as per-window sha256 digests). Regenerate only from a checkout of
// the old RENDERER (origin/main at 8ecfd465), never from this branch's:
//   ACTION_ANIMS_GOLDEN=<path>.json pnpm exec vitest run src/render/actionAnims.views.test.ts
// The trace runs the real sim, so a sim change moves it legitimately. Then copy
// this branch's src/game over that checkout first: old renderer, current sim.
// (Done once: the engage wind-up, NpcDef.drawTicks, delays the drowner's first
// shot 16 ticks; draw windows from tick 51 moved, window 0 and the kennel not.)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Texture, type Renderer, type Sprite } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import type { Entity } from '../game/entity'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { runTicks, walledRoom, worldFromRows } from '../game/testkit'
import type { World } from '../game/world'
import { createArt, type CharSet, type DirPose } from './art'
import { EntityViews } from './sprites'

const DIRS = ['s', 'se', 'e', 'ne', 'n'] as const
const tex = (label: string): Texture => new Texture({ label })

/** A pose per direction: legacy idle + step, an 8-frame walk clip, and
 * optionally 8-frame `draw` / `fidget` clips — every frame its own texture,
 * labelled `<name>.<dir>.<state>.<n>`. */
const fakeSet = (name: string, extra: readonly ('draw' | 'fidget')[]): CharSet => {
  const set: CharSet = {}
  for (const d of DIRS) {
    const clip = (state: string): Texture[] => Array.from({ length: 8 }, (_, n) => tex(`${name}.${d}.${state}.${n}`))
    const pose: DirPose = { idle: tex(`${name}.${d}.idle`), step: tex(`${name}.${d}.step`), clips: { walk: clip('walk') } }
    for (const s of extra) pose.clips![s] = clip(s)
    set[d] = pose
  }
  return set
}

const fakeRenderer = { generateTexture: () => Texture.EMPTY } as unknown as Renderer

const artFor = (extra: readonly ('draw' | 'fidget')[]) =>
  createArt(
    fakeRenderer,
    { chars: { drowner: fakeSet('drowner', extra), gloamhound: fakeSet('gloamhound', extra), player: fakeSet('player', []) } },
    {},
    {},
    true,
  )

interface ViewInternals {
  views: Map<number, { sprite: Sprite; weapon?: Sprite }>
}
const viewOf = (v: EntityViews, id: number) => (v as unknown as ViewInternals).views.get(id)

const teleport = (e: Entity, x: number, y: number): void => {
  e.pos = { x, y }
  e.prevPos = { x, y }
}

/** The draw scene of actionAnims.test.ts, rendered every tick. */
const drawScene = () => {
  const w = worldFromRows(walledRoom(40, 12), { seed: 7 })
  const p = spawnPlayer(w, 0, 3.5, 5.5)
  const d = spawnNpc(w, 'drowner', 33.5, 5.5)
  return {
    w,
    focus: [d],
    before: (i: number): void => {
      if (i === 60) teleport(p, d.pos.x - 6, d.pos.y)
      if (i === 160) teleport(p, 1.5, 1.5)
      if (i === 260) teleport(p, d.pos.x - 6, d.pos.y)
    },
    n: 330,
  }
}

/** Two tethered hounds (speed 0), rendered every tick. */
const kennelScene = () => {
  const w = worldFromRows(walledRoom(20, 10), { seed: 11 })
  const a = spawnNpc(w, 'gloamhound', 9.5, 3.5)
  const b = spawnNpc(w, 'gloamhound', 9.5, 6.5)
  a.speed = 0
  b.speed = 0
  return { w, focus: [a, b], before: (): void => {}, n: 700 }
}

interface Frame {
  tick: number
  tex: string
  x: number
  y: number
  rot: number
  sx: number
  sy: number
  alpha: number
  weapon: string | null
}

/** Run the scene and record each focus entity's sprite every tick. */
const trace = (
  scene: { w: World; focus: Entity[]; before: (i: number) => void; n: number },
  extra: readonly ('draw' | 'fidget')[],
): Record<number, Frame[]> => {
  const views = new EntityViews(artFor(extra))
  const out: Record<number, Frame[]> = {}
  for (const e of scene.focus) out[e.id] = []
  for (let i = 0; i < scene.n; i++) {
    scene.before(i)
    runTicks(scene.w, new Map(), 1)
    views.update(scene.w.entities, 0.5, scene.w.tick, scene.w.floor)
    for (const e of scene.focus) {
      const v = viewOf(views, e.id)
      if (!v) continue
      const s = v.sprite
      out[e.id].push({
        tick: scene.w.tick,
        tex: s.texture.label ?? '?',
        x: s.position.x,
        y: s.position.y,
        rot: s.rotation,
        sx: s.scale.x,
        sy: s.scale.y,
        alpha: s.alpha,
        weapon: v.weapon ? `${v.weapon.rotation.toFixed(6)}@${v.weapon.position.x.toFixed(3)},${v.weapon.position.y.toFixed(3)}` : null,
      })
    }
  }
  return out
}

/** "<state>.<n>" of a label like "drowner.e.draw.3", or the bare state. */
const shown = (f: Frame): string => f.tex.split('.').slice(2).join('.')

describe('draw at the entity layer', () => {
  it('the drowner shows draw.0 .. draw.7 at tpf 2 from the engage tick, with its held weapon hidden', () => {
    const scene = drawScene()
    const d = scene.focus[0]
    const frames = trace(scene, ['draw'])[d.id]
    const at = frames.findIndex((f) => shown(f).startsWith('draw.'))
    expect(at).toBeGreaterThan(0)
    const clip = frames.slice(at, at + 16)
    expect(clip.map(shown)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7].map((n) => `draw.${n}`))
    expect(clip.every((f) => f.weapon === null), 'the clip draws the pistol; the held one is stowed').toBe(true)
    // The sprite before and after holds the weapon the usual way.
    expect(frames[at - 1].weapon).not.toBeNull()
    expect(frames[at + 16].weapon).not.toBeNull()
    expect(shown(frames[at + 16])).not.toMatch(/^draw/)
    // Drawn-only: no procedural motion layered on the clip (no lean, no squash).
    for (const f of clip) {
      expect(f.rot).toBe(0)
      expect(Math.abs(f.sx)).toBe(1)
      expect(f.sy).toBe(1)
    }
  })
})

describe('fidget at the entity layer', () => {
  it('each hound shows fidget.0 .. fidget.7 at tpf 3, back to idle after, never both on the same tick', () => {
    const scene = kennelScene()
    const [a, b] = scene.focus
    const t = trace(scene, ['fidget'])
    const startsOf = (frames: Frame[]): number[] =>
      frames.filter((f, i) => shown(f) === 'fidget.0' && (i === 0 || shown(frames[i - 1]) !== 'fidget.0')).map((f) => f.tick)
    for (const frames of [t[a.id], t[b.id]]) {
      const starts = startsOf(frames)
      expect(starts.length).toBeGreaterThanOrEqual(2)
      for (const s0 of starts) {
        const at = frames.findIndex((f) => f.tick === s0)
        if (at + 24 > frames.length) continue
        expect(frames.slice(at, at + 24).map(shown)).toEqual(Array.from({ length: 24 }, (_, k) => `fidget.${Math.floor(k / 3)}`))
        if (at + 24 < frames.length) expect(shown(frames[at + 24])).toBe('idle')
      }
    }
    expect(startsOf(t[a.id]).filter((s) => startsOf(t[b.id]).includes(s))).toEqual([])
  })
})

const GOLDEN = join(process.cwd(), 'src', 'render', '__fixtures__', 'action-anims-noframes-trace.json')

/** sha256 of each 50-tick window of each entity's trace: a small fixture that
 * still says WHERE a divergence starts. */
const digest = (t: Frame[][]): string[][] =>
  t.map((frames) => {
    const out: string[] = []
    for (let i = 0; i < frames.length; i += 50) {
      const w = frames.slice(i, i + 50)
      out.push(`${w[0].tick}:${createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16)}`)
    }
    return out
  })

describe('a pack without draw/fidget frames renders exactly as origin/main did', () => {
  const now = {
    draw: digest(Object.values(trace(drawScene(), []))),
    kennel: digest(Object.values(trace(kennelScene(), []))),
  }
  const out = process.env.ACTION_ANIMS_GOLDEN
  if (out) writeFileSync(out, JSON.stringify(now, null, 1) + '\n')

  it('the golden digest exists and covers the engage and the long idle', () => {
    expect(existsSync(GOLDEN)).toBe(true)
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof now
    expect(golden.draw.map((c) => c.length)).toEqual([7])
    expect(golden.kennel.map((c) => c.length)).toEqual([14, 14])
  })

  it('sprite texture, transform, alpha and held weapon match the old renderer on every tick', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof now
    expect(now).toEqual(golden)
  })
})
