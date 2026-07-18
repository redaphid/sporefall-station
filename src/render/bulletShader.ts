// A batched GPU energy-field — the shader substrate under the procedural bullet
// visuals (and reusable by any layer that wants glowing energy: pickups,
// explosions, auras — see `EnergyFieldMesh.push`). One pixi v8 Mesh + custom
// GLSL program draws EVERY quad in a single additive draw call: per-quad traits
// ride as vertex attributes, only `uTime` is a uniform. The fragment shader is
// paper-cranes-style shadertoy energy: a 1/r² halo around a hot core, flicker
// and arc-jitter hashed from a per-quad SEED + stepped time (deterministic —
// render-side only, never the world RNG), and an RGB-split chromatic fringe
// that only deep mod stacks unlock.
//
// Mobile budget: quads are small (a few tiles), capped at MAX_QUADS, and there
// is no per-projectile filter pass and no per-frame texture generation. If the
// shader fails to compile (ancient GPU/driver), `ok` is false and the caller
// falls back to plain tinted sprites — the game never blanks.

import { Buffer, BufferUsage, Container, Geometry, Mesh, Shader } from 'pixi.js'

/** Upper bound on energy quads per frame (bullets + trail ghosts + extras). */
export const MAX_QUADS = 384

const VERTEX = /* glsl */ `
  attribute vec2 aPosition;
  attribute vec2 aLocal;
  attribute vec3 aColor;
  attribute vec4 aData;
  attribute vec2 aData2;

  varying vec2 vLocal;
  varying vec3 vColor;
  varying vec4 vData;
  varying vec2 vData2;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;

  void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vLocal = aLocal;
    vColor = aColor;
    vData = aData;
    vData2 = aData2;
  }
`

// vData  = (intensity, pulse, jitter, seed)
// vData2 = (chroma, unused)
const FRAGMENT = /* glsl */ `
  precision mediump float;

  varying vec2 vLocal;
  varying vec3 vColor;
  varying vec4 vData;
  varying vec2 vData2;

  uniform float uTime;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  // Radial energy: hot smoothstep core + 1/r^2 halo (the shadertoy classic).
  float energy(vec2 p, float w) {
    float r = length(p);
    return smoothstep(0.30 * w, 0.0, r) * 1.7 + 0.05 * w / (r * r + 0.045);
  }

  void main() {
    float seed = vData.w;
    float tt = uTime;
    // Stepped-time flicker: same tick -> same frame, on every peer and replay.
    float flick = 1.0 + vData.z * (hash(seed + floor(tt * 0.5)) - 0.5) * 1.4;
    // Armed-payload throb.
    float w = 1.0 + vData.y * 0.3 * sin(tt * 0.55 + seed * 6.2831);
    vec2 p = vLocal;
    // Tesla arc-jitter warps the field itself, not just the brightness.
    p += vData.z * 0.20 * vec2(
      sin(tt * 1.7 + seed * 9.1 + p.y * 5.0),
      cos(tt * 1.3 + seed * 4.7 + p.x * 5.0));
    float e = energy(p, w);
    vec3 col = vColor * e;
    // Chromatic fringe: offset red/blue sub-samples, only past a deep stack.
    float ch = vData2.x;
    if (ch > 0.01) {
      vec2 o = ch * 0.13 * vec2(cos(tt * 0.9 + seed * 3.1), sin(tt * 0.9 + seed * 3.1));
      col.r = vColor.r * energy(p + o, w);
      col.b = vColor.b * energy(p - o, w);
    }
    // Fade at the quad rim so the finite quad never shows a hard edge.
    float rim = smoothstep(1.0, 0.78, max(abs(vLocal.x), abs(vLocal.y)));
    col *= flick * vData.x * rim;
    gl_FragColor = vec4(col, 0.0); // additive blend: rgb adds, never darkens
  }
`

export interface EnergyQuad {
  /** Center, world pixels. */
  x: number
  y: number
  /** Heading (radians) — the quad stretches along it. */
  angle: number
  /** Half-extent perpendicular to the heading, pixels. */
  radiusPx: number
  /** Elongation along the heading (1 = round). */
  stretch: number
  /** 0xRRGGBB tint. */
  color: number
  /** Brightness 0..~1.5. */
  intensity: number
  /** Throb 0..1. */
  pulse: number
  /** Arc-jitter 0..1. */
  jitter: number
  /** RGB-split 0..1. */
  chroma: number
  /** Stable per-thing seed (derive from entity id) — keeps flicker replayable. */
  seed: number
}

/**
 * The reusable batched energy layer. Per frame: `begin()`, `push(...)` any
 * number of quads (extra ones beyond MAX_QUADS are dropped), then `end(time)`
 * with a SIM-derived time (tick + alpha — never wall clock) to upload + tick
 * the uniforms. Construction is fail-safe: check `ok` and fall back to sprites
 * when false.
 */
export class EnergyFieldMesh {
  readonly root = new Container()
  readonly ok: boolean

  private pos!: Float32Array
  private local!: Float32Array
  private color!: Float32Array
  private data!: Float32Array
  private data2!: Float32Array
  private posBuf!: Buffer
  private localBuf!: Buffer
  private colorBuf!: Buffer
  private dataBuf!: Buffer
  private data2Buf!: Buffer
  private shader!: Shader
  private count = 0
  private lastCount = 0

  constructor() {
    let ok = false
    try {
      this.pos = new Float32Array(MAX_QUADS * 8)
      this.local = new Float32Array(MAX_QUADS * 8)
      this.color = new Float32Array(MAX_QUADS * 12)
      this.data = new Float32Array(MAX_QUADS * 16)
      this.data2 = new Float32Array(MAX_QUADS * 8)
      const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST
      this.posBuf = new Buffer({ data: this.pos, usage })
      this.localBuf = new Buffer({ data: this.local, usage })
      this.colorBuf = new Buffer({ data: this.color, usage })
      this.dataBuf = new Buffer({ data: this.data, usage })
      this.data2Buf = new Buffer({ data: this.data2, usage })
      // Static quad-local corners (-1..1) — never change after construction.
      for (let q = 0; q < MAX_QUADS; q++) {
        this.local.set([-1, -1, 1, -1, 1, 1, -1, 1], q * 8)
      }
      const indices = new Uint32Array(MAX_QUADS * 6)
      for (let q = 0; q < MAX_QUADS; q++) {
        const v = q * 4
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6)
      }
      const geometry = new Geometry({
        attributes: {
          aPosition: { buffer: this.posBuf, format: 'float32x2' },
          aLocal: { buffer: this.localBuf, format: 'float32x2' },
          aColor: { buffer: this.colorBuf, format: 'float32x3' },
          aData: { buffer: this.dataBuf, format: 'float32x4' },
          aData2: { buffer: this.data2Buf, format: 'float32x2' },
        },
        indexBuffer: indices,
      })
      this.shader = Shader.from({
        gl: { vertex: VERTEX, fragment: FRAGMENT },
        resources: {
          energyUniforms: { uTime: { value: 0, type: 'f32' } },
        },
      })
      const mesh = new Mesh({ geometry, shader: this.shader })
      mesh.blendMode = 'add'
      this.root.addChild(mesh)
      ok = true
    } catch (err) {
      console.warn('[bullets] energy shader unavailable, falling back to sprites', err)
    }
    this.ok = ok
  }

  begin(): void {
    this.count = 0
  }

  push(q: EnergyQuad): void {
    if (!this.ok || this.count >= MAX_QUADS) return
    const i = this.count++
    const cos = Math.cos(q.angle)
    const sin = Math.sin(q.angle)
    // Basis vectors: along-heading (stretched) and perpendicular.
    const ax = cos * q.radiusPx * q.stretch
    const ay = sin * q.radiusPx * q.stretch
    const px = -sin * q.radiusPx
    const py = cos * q.radiusPx
    // Corners in aLocal order (-1,-1)(1,-1)(1,1)(-1,1).
    this.pos.set(
      [
        q.x - ax - px, q.y - ay - py,
        q.x + ax - px, q.y + ay - py,
        q.x + ax + px, q.y + ay + py,
        q.x - ax + px, q.y - ay + py,
      ],
      i * 8,
    )
    const r = ((q.color >> 16) & 0xff) / 255
    const g = ((q.color >> 8) & 0xff) / 255
    const b = (q.color & 0xff) / 255
    for (let v = 0; v < 4; v++) {
      this.color.set([r, g, b], i * 12 + v * 3)
      this.data.set([q.intensity, q.pulse, q.jitter, q.seed], i * 16 + v * 4)
      this.data2.set([q.chroma, 0], i * 8 + v * 2)
    }
  }

  /** Upload this frame's quads. `time` must be sim-derived (tick + alpha). */
  end(time: number): void {
    if (!this.ok) return
    // Degenerate any quads used last frame but not this one (zero-area = culled).
    for (let q = this.count; q < this.lastCount; q++) this.pos.fill(0, q * 8, q * 8 + 8)
    const touched = Math.max(this.count, this.lastCount)
    this.lastCount = this.count
    if (touched > 0) {
      this.posBuf.update()
      this.colorBuf.update()
      this.dataBuf.update()
      this.data2Buf.update()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi v8 uniform group access
    ;(this.shader.resources.energyUniforms as any).uniforms.uTime = time
  }
}
