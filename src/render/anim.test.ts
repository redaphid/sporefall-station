import { describe, expect, it } from 'vitest'
import {
  burnPulse,
  CHAR_FOOT_OFFSET,
  charFootPx,
  charSpriteBounds,
  cycleFrame,
  depthKey,
  facing8,
  facingDir,
  isMoving,
  onceFrame,
  walkBob,
  type Facing8,
} from './anim'

const PI = Math.PI
/** Sector centres in compass order, screen coords (+x east, +y south). */
const CENTRES: [number, Facing8][] = [
  [0, 'e'],
  [PI / 4, 'se'],
  [PI / 2, 's'],
  [(3 * PI) / 4, 'sw'],
  [PI, 'w'],
  [(5 * PI) / 4, 'nw'],
  [(3 * PI) / 2, 'n'],
  [(7 * PI) / 4, 'ne'],
]

describe('facing8', () => {
  it('maps all eight sector centres to their compass facing', () => {
    for (const [a, f] of CENTRES) expect(facing8(a), `heading ${a}`).toBe(f)
  })

  it('holds the facing across the whole 45° sector (just inside both edges)', () => {
    const eps = 1e-9
    for (const [a, f] of CENTRES) {
      expect(facing8(a - PI / 8 + eps), `${f} ccw edge`).toBe(f)
      expect(facing8(a + PI / 8 - eps), `${f} cw edge`).toBe(f)
    }
  })

  it('resolves exact 22.5° boundaries to one of the two adjacent sectors — never anything else', () => {
    // The double for (2k+1)·π/8 rarely divides π/4 to an exact .5, so which
    // neighbour wins is an FP detail; what matters (and is IEEE-deterministic,
    // so identical on every device/replay) is that a boundary heading always
    // lands in an adjacent sector and always the SAME one.
    for (let k = 0; k < 8; k++) {
      const a = ((2 * k + 1) * PI) / 8
      const adjacent = [CENTRES[k][1], CENTRES[(k + 1) % 8][1]]
      const got = facing8(a)
      expect(adjacent, `boundary ${k} (${a})`).toContain(got)
      expect(facing8(a), `boundary ${k} determinism`).toBe(got)
    }
  })

  it('normalizes negative headings', () => {
    expect(facing8(-PI / 2)).toBe('n')
    expect(facing8(-PI / 4)).toBe('ne')
    expect(facing8(-PI)).toBe('w')
    expect(facing8((-3 * PI) / 4)).toBe('nw')
    // negative boundary: -22.5° normalizes to 337.5° — adjacent sectors only
    expect(['ne', 'e']).toContain(facing8(-PI / 8))
  })

  it('wraps headings beyond ±2π', () => {
    for (const [a, f] of CENTRES) {
      expect(facing8(a + 4 * PI), `${f} +4π`).toBe(f)
      expect(facing8(a - 6 * PI), `${f} -6π`).toBe(f)
    }
  })

  it('reads south (idle, toward camera) on degenerate headings', () => {
    expect(facing8(Number.NaN)).toBe('s')
    expect(facing8(Number.POSITIVE_INFINITY)).toBe('s')
    expect(facing8(Number.NEGATIVE_INFINITY)).toBe('s')
  })
})

describe('facingDir', () => {
  it('renders the east half unmirrored', () => {
    expect(facingDir(0)).toEqual({ dir: 'e', flip: false })
    expect(facingDir(PI / 4)).toEqual({ dir: 'se', flip: false })
    expect(facingDir(-PI / 4)).toEqual({ dir: 'ne', flip: false })
  })

  it('renders the cardinals s and n unmirrored', () => {
    expect(facingDir(PI / 2)).toEqual({ dir: 's', flip: false })
    expect(facingDir(-PI / 2)).toEqual({ dir: 'n', flip: false })
  })

  it('mirrors the west half from the east art', () => {
    expect(facingDir(PI)).toEqual({ dir: 'e', flip: true })
    expect(facingDir((3 * PI) / 4)).toEqual({ dir: 'se', flip: true })
    expect(facingDir((5 * PI) / 4)).toEqual({ dir: 'ne', flip: true })
  })

  it('only ever mirrors — the five drawn directions cover all 8 sectors', () => {
    const drawn = new Set<string>()
    for (let a = -4 * PI; a <= 4 * PI; a += PI / 32) drawn.add(facingDir(a).dir)
    expect([...drawn].sort()).toEqual(['e', 'n', 'ne', 's', 'se'])
  })

  it('defaults degenerate headings to unmirrored south', () => {
    expect(facingDir(Number.NaN)).toEqual({ dir: 's', flip: false })
  })
})

describe('feet anchoring (charFootPx / charSpriteBounds)', () => {
  it('puts the feet half a tile below the entity centre', () => {
    expect(CHAR_FOOT_OFFSET).toBe(0.5)
    expect(charFootPx(10, 32)).toBe(336) // (10 + 0.5) * 32
    expect(charFootPx(0, 32)).toBe(16)
    expect(charFootPx(-1, 32)).toBe(-16)
  })

  it('keeps the feet pixel INVARIANT when the sprite canvas grows', () => {
    // The 32→48 canvas upgrade must raise the head, never sink the feet.
    const before = charSpriteBounds(7.25, 32, 32)
    const after = charSpriteBounds(7.25, 32, 48)
    expect(after.bottom).toBe(before.bottom)
    expect(after.top).toBe(before.top - 16) // taller only upward
  })

  it('a 48px character overlaps the tile behind (above) it', () => {
    // Entity centred on tile row 10 (y=10.5 centre): sprite top reaches into
    // row 9's pixels — the overlap the bigger canvas exists to create.
    const b = charSpriteBounds(10.5, 32, 48)
    expect(b.bottom).toBe(352) // bottom of tile row 10
    expect(b.top).toBe(304) // above 320 = top of row 10 → into row 9
    expect(b.top).toBeLessThan(10 * 32)
  })
})

describe('depthKey (y-sort)', () => {
  it('draws the lower-on-screen entity in front', () => {
    expect(depthKey('npc', 10.4)).toBeGreaterThan(depthKey('prop', 10.0))
    expect(depthKey('npc', 9.6)).toBeLessThan(depthKey('prop', 10.0))
  })

  it('ties exactly at equal y (stable either way, never NaN)', () => {
    expect(depthKey('npc', 10)).toBe(depthKey('prop', 10))
  })

  it('floats fire above everything at any plausible depth', () => {
    expect(depthKey('fire', 0)).toBeGreaterThan(depthKey('npc', 512))
    expect(depthKey('fire', 3)).toBeGreaterThan(depthKey('fire', 2) - 1) // still y-sorted among flames
  })
})

describe('cycleFrame', () => {
  it('holds on frame 0 for a single-frame clip', () => {
    expect(cycleFrame(0, 1, 6)).toBe(0)
    expect(cycleFrame(999, 1, 6)).toBe(0)
  })

  it('advances one frame every ticksPerFrame and wraps', () => {
    expect(cycleFrame(0, 3, 5)).toBe(0)
    expect(cycleFrame(4, 3, 5)).toBe(0)
    expect(cycleFrame(5, 3, 5)).toBe(1)
    expect(cycleFrame(10, 3, 5)).toBe(2)
    expect(cycleFrame(15, 3, 5)).toBe(0)
  })

  it('is deterministic — same tick yields the same frame', () => {
    expect(cycleFrame(37, 4, 3)).toBe(cycleFrame(37, 4, 3))
  })
})

describe('onceFrame', () => {
  it('is -1 before the clip starts', () => {
    expect(onceFrame(4, 5, 3, 4)).toBe(-1)
  })

  it('walks frames from the start tick', () => {
    expect(onceFrame(10, 10, 3, 4)).toBe(0)
    expect(onceFrame(13, 10, 3, 4)).toBe(0)
    expect(onceFrame(14, 10, 3, 4)).toBe(1)
    expect(onceFrame(21, 10, 3, 4)).toBe(2)
  })

  it('is -1 once every frame has played (finished)', () => {
    expect(onceFrame(21, 10, 3, 4)).toBe(2)
    expect(onceFrame(22, 10, 3, 4)).toBe(-1)
    expect(onceFrame(500, 10, 3, 4)).toBe(-1)
  })
})

describe('isMoving', () => {
  it('is false when velocity is under the threshold', () => {
    expect(isMoving(0, 0)).toBe(false)
    expect(isMoving(0.01, -0.02)).toBe(false)
  })

  it('is true when the entity is walking', () => {
    expect(isMoving(1.5, 0)).toBe(true)
    expect(isMoving(0, -2)).toBe(true)
  })
})

describe('walkBob', () => {
  it('is zero at the start of the cycle', () => {
    expect(walkBob(0)).toBeCloseTo(0, 5)
  })

  it('stays within the bob amplitude', () => {
    for (let t = 0; t < 20; t += 0.37) expect(Math.abs(walkBob(t))).toBeLessThanOrEqual(1.5001)
  })
})

describe('burnPulse', () => {
  it('stays within 0..1', () => {
    for (let t = 0; t < 20; t += 0.29) {
      const p = burnPulse(t)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('is deterministic for a given time', () => {
    expect(burnPulse(3.5)).toBe(burnPulse(3.5))
  })
})

// --- tap-pick alignment with the visible 48px sprite ---------------------
// The tap radius must cover every pixel a feet-anchored CHAR_PX sprite can
// occupy, or a tap on a character's head would miss it. Pure geometry: the
// sprite spans x ∈ ±CHAR_PX/2 and y ∈ [foot−CHAR_PX, foot] around the entity.
import { pickNearestEntity, PICK_RADIUS } from '../game/select'
import { CHAR_PX, TILE_PX } from './art'
import type { Entity } from '../game/entity'

describe('tap-pick covers the whole visible character sprite', () => {
  const halfW = CHAR_PX / 2 / TILE_PX // 0.75 tiles
  const foot = CHAR_FOOT_OFFSET // +0.5 tiles below centre
  const top = foot - CHAR_PX / TILE_PX // −1.0 tiles above centre

  it('every corner of the 48px canvas is inside PICK_RADIUS', () => {
    for (const [dx, dy] of [
      [-halfW, top],
      [halfW, top],
      [-halfW, foot],
      [halfW, foot],
    ]) {
      expect(Math.hypot(dx, dy), `corner ${dx},${dy}`).toBeLessThanOrEqual(PICK_RADIUS)
    }
  })

  it('a tap on the head of a feet-anchored character picks it', () => {
    const e = {
      id: 1,
      kind: 'npc',
      archetype: 'thug',
      pos: { x: 10, y: 10 },
    } as unknown as Entity
    // Head centre sits ~1 tile above the entity centre on the 48px canvas.
    expect(pickNearestEntity([e], 10, 10 + top + 0.1, PICK_RADIUS)).toBe(e)
    // The old radius (1.2) would have missed the canvas's top corners.
    expect(Math.hypot(halfW, top)).toBeGreaterThan(1.2)
  })
})
