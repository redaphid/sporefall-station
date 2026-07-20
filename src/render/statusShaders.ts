// The per-character status-effect GPU layer — real SHADERS over any entity under
// a status (Entity.fx). It reuses the batched-energy-mesh pattern of
// bulletShader.ts EXACTLY: ONE pixi v8 Mesh + custom GLSL draws EVERY affected
// character's effect quad in a single additive draw call, per-quad traits ride
// as vertex attributes, and only `uTime` is a uniform. There is deliberately NO
// per-character pixi Filter pass (the earlier "measure the GPU" perf work made
// per-entity filters the thing to avoid) — a quad is pushed IFF the character
// has a shader-status, and simply not pushed when it clears (attach/detach by
// presence, no filter lifecycle to leak).
//
// The fragment shader branches on a per-quad EFFECT index into real procedural
// looks — lightning (branching arcs + hot core), fire, frost sheen, poison
// miasma, wet drip — each modulated by a per-quad INTENSITY float that
// statusUniforms.ts derives from the driving weapon + its mods (more Tesla mods
// ⇒ a brighter, angrier lightning). Colour rides as a vertex attribute too.
//
// Determinism: every animated quantity derives from uTime = sim view-time
// (tick + alpha) and a per-ENTITY seed — never Math.random, never wall clock —
// so the same electrified enemy crackles identically on host, client and replay.
// Mobile budget: quads are small, capped at MAX_STATUS_QUADS, mediump, cheap
// per-branch loops; construction is fail-safe (`ok` false ⇒ the caller simply
// draws nothing extra, the game never blanks).

import { Buffer, BufferUsage, Container, Geometry, Mesh, Shader } from 'pixi.js'
import type { Entity, WeaponMod } from '../game/entity'
import { weaponStack } from '../game/systems/inventory'
import { charFootPx } from './anim'
import { CHAR_PX, TILE_PX } from './art'
import { composeStatus, type StatusQuad } from './statusUniforms'

/** Upper bound on status quads per frame (one per affected character). */
export const MAX_STATUS_QUADS = 128

const VERTEX = /* glsl */ `
  attribute vec2 aPosition;
  attribute vec2 aLocal;
  attribute vec3 aColor;
  attribute vec4 aData;

  varying vec2 vLocal;
  varying vec3 vColor;
  varying vec4 vData;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;

  void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vLocal = aLocal;
    vColor = aColor;
    vData = aData;
  }
`

// vData = (effect, intensity, energy, seed). Local coords: x,y in [-1,1];
// y = -1 top of the character, +1 at the feet.
const FRAGMENT = /* glsl */ `
  precision mediump float;

  varying vec2 vLocal;
  varying vec3 vColor;
  varying vec4 vData;

  uniform float uTime;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  // Cheap value noise.
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // --- LIGHTNING: 3 branching arcs that jitter along the body, a hot white
  // core and a coloured halo, crackling on stepped time (deterministic).
  vec3 lightning(vec2 p, float seed, float inten) {
    float glow = 0.0;
    float core = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float s = seed * 7.0 + fi * 13.7;
      // Crackle: each bolt blinks on/off on a fast stepped clock.
      float on = step(0.35, hash(s + floor(uTime * 4.0 + fi * 2.3)));
      // Horizontal path of the bolt as a function of height (two octaves).
      float x0 = (vnoise(vec2(s, p.y * 2.5 + uTime * 5.0)) * 2.0 - 1.0) * 0.42;
      x0 += (vnoise(vec2(s + 9.0, p.y * 8.0 + uTime * 9.0)) * 2.0 - 1.0) * 0.14;
      x0 += (fi - 1.0) * 0.16; // fan the three bolts apart
      float d = abs(p.x - x0);
      core += on * 0.010 / (d + 0.010);
      glow += on * 0.045 / (d + 0.06);
    }
    core = min(core, 3.0);
    vec3 col = vColor * glow * 0.6 + vec3(0.7, 0.85, 1.0) * core;
    return col * inten;
  }

  // --- FIRE: flames licking upward, hot base fading to the mod's ember hue.
  vec3 fire(vec2 p, float seed, float inten) {
    float up = (-p.y) * 0.5 + 0.5;              // 0 feet .. 1 head
    float n = vnoise(vec2(p.x * 3.0 + seed, (p.y * 3.0) + uTime * 6.0));
    n += 0.5 * vnoise(vec2(p.x * 7.0 - seed, (p.y * 6.0) + uTime * 9.0));
    float body = smoothstep(1.1, 0.1, abs(p.x) * (1.2 + up)) * (0.5 + 0.7 * n);
    float flame = body * smoothstep(1.0, 0.15, up) * (0.6 + up);
    vec3 hot = mix(vec3(1.0, 0.95, 0.5), vColor, up);
    return hot * flame * inten * 1.6;
  }

  // --- FROST: an icy sheen + drifting crystalline sparkle.
  vec3 frost(vec2 p, float seed, float inten) {
    float sheen = smoothstep(1.0, 0.0, length(p * vec2(0.9, 0.8)));
    vec2 cell = floor(p * 6.0 + seed);
    float spark = step(0.90, hash2(cell) - 0.15 * sin(uTime * 2.0 + hash2(cell) * 30.0));
    float frostN = vnoise(p * 4.0 - vec2(0.0, uTime * 0.6));
    vec3 col = vColor * (sheen * (0.35 + 0.4 * frostN) + spark * 0.9);
    return col * inten * 1.2;
  }

  // --- POISON / SPORE: a bubbling green miasma of rising metaballs.
  vec3 poison(vec2 p, float seed, float inten) {
    float m = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float t = uTime * 0.6 + fi * 1.7 + seed * 6.0;
      vec2 c = vec2(sin(t * 1.3 + fi) * 0.5, mod(-t * 0.4 + fi * 0.5, 2.0) - 1.0);
      float r = 0.18 + 0.06 * sin(t * 2.0);
      m += r * r / (dot(p - c, p - c) + 0.02);
    }
    float body = smoothstep(0.6, 1.4, m);
    return vColor * body * inten * 1.1;
  }

  // --- WET: a cool sheen with drips sliding down the body.
  vec3 wet(vec2 p, float seed, float inten) {
    float sheen = smoothstep(1.0, 0.1, length(p * vec2(0.9, 0.85))) * 0.5;
    float col = floor((p.x + 1.0) * 4.0 + seed * 10.0);
    float drip = fract(p.y * 0.5 + 0.5 - uTime * 0.5 - hash(col) * 3.0);
    float streak = smoothstep(0.08, 0.0, abs(fract((p.x + 1.0) * 4.0 + seed * 10.0) - 0.5))
                 * smoothstep(0.5, 0.0, drip);
    return vColor * (sheen + streak * 0.9) * inten;
  }

  void main() {
    int effect = int(vData.x + 0.5);
    float inten = vData.y;
    float seed = vData.w;
    vec2 p = vLocal;

    vec3 col;
    if (effect == 0) col = lightning(p, seed, inten);
    else if (effect == 1) col = fire(p, seed, inten);
    else if (effect == 2) col = frost(p, seed, inten);
    else if (effect == 3) col = poison(p, seed, inten);
    else col = wet(p, seed, inten);

    // Rim fade so the finite quad never shows a hard edge.
    float rim = smoothstep(1.0, 0.72, max(abs(p.x), abs(p.y)));
    gl_FragColor = vec4(col * rim, 0.0); // additive: rgb adds, never darkens
  }
`

/** Deterministic 0..1 hash of an entity id — the flicker/phase seed. */
const seedOf = (id: number): number => {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  return ((h >>> 16) & 0xffff) / 0x10000
}

export interface StatusQuadPush {
  /** Centre in world pixels. */
  x: number
  y: number
  /** Half-extent in world pixels (x, y). */
  halfW: number
  halfH: number
  effect: number
  intensity: number
  color: number
  seed: number
  energy: number
}

/**
 * The batched status-effect mesh. Per frame: `begin()`, `push(...)` a quad for
 * every affected character, then `end(time)` with SIM view-time (tick + alpha).
 * Construction is fail-safe: check `ok` and skip the layer when false.
 */
export class StatusFieldMesh {
  readonly root = new Container()
  readonly ok: boolean

  private pos!: Float32Array
  private local!: Float32Array
  private color!: Float32Array
  private data!: Float32Array
  private posBuf!: Buffer
  private colorBuf!: Buffer
  private dataBuf!: Buffer
  private shader!: Shader
  private count = 0
  private lastCount = 0

  constructor() {
    let ok = false
    try {
      this.pos = new Float32Array(MAX_STATUS_QUADS * 8)
      this.local = new Float32Array(MAX_STATUS_QUADS * 8)
      this.color = new Float32Array(MAX_STATUS_QUADS * 12)
      this.data = new Float32Array(MAX_STATUS_QUADS * 16)
      const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST
      this.posBuf = new Buffer({ data: this.pos, usage })
      const localBuf = new Buffer({ data: this.local, usage })
      this.colorBuf = new Buffer({ data: this.color, usage })
      this.dataBuf = new Buffer({ data: this.data, usage })
      for (let q = 0; q < MAX_STATUS_QUADS; q++) this.local.set([-1, -1, 1, -1, 1, 1, -1, 1], q * 8)
      const indices = new Uint32Array(MAX_STATUS_QUADS * 6)
      for (let q = 0; q < MAX_STATUS_QUADS; q++) {
        const v = q * 4
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6)
      }
      const geometry = new Geometry({
        attributes: {
          aPosition: { buffer: this.posBuf, format: 'float32x2' },
          aLocal: { buffer: localBuf, format: 'float32x2' },
          aColor: { buffer: this.colorBuf, format: 'float32x3' },
          aData: { buffer: this.dataBuf, format: 'float32x4' },
        },
        indexBuffer: indices,
      })
      this.shader = Shader.from({
        gl: { vertex: VERTEX, fragment: FRAGMENT },
        resources: { statusUniforms: { uTime: { value: 0, type: 'f32' } } },
      })
      const mesh = new Mesh({ geometry, shader: this.shader })
      mesh.blendMode = 'add'
      this.root.addChild(mesh)
      ok = true
    } catch (err) {
      console.warn('[status] effect shader unavailable, skipping', err)
    }
    this.ok = ok
  }

  begin(): void {
    this.count = 0
  }

  push(q: StatusQuadPush): void {
    if (!this.ok || this.count >= MAX_STATUS_QUADS) return
    const i = this.count++
    this.pos.set(
      [
        q.x - q.halfW, q.y - q.halfH,
        q.x + q.halfW, q.y - q.halfH,
        q.x + q.halfW, q.y + q.halfH,
        q.x - q.halfW, q.y + q.halfH,
      ],
      i * 8,
    )
    const r = ((q.color >> 16) & 0xff) / 255
    const g = ((q.color >> 8) & 0xff) / 255
    const b = (q.color & 0xff) / 255
    for (let v = 0; v < 4; v++) {
      this.color.set([r, g, b], i * 12 + v * 3)
      this.data.set([q.effect, q.intensity, q.energy, q.seed], i * 16 + v * 4)
    }
  }

  /** Upload this frame's quads. `time` must be sim-derived (tick + alpha). */
  end(time: number): void {
    if (!this.ok) return
    for (let q = this.count; q < this.lastCount; q++) this.pos.fill(0, q * 8, q * 8 + 8)
    const touched = Math.max(this.count, this.lastCount)
    this.lastCount = this.count
    if (touched > 0) {
      this.posBuf.update()
      this.colorBuf.update()
      this.dataBuf.update()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi v8 uniform group access
    ;(this.shader.resources.statusUniforms as any).uniforms.uTime = time
  }
}

/** Half-width of a character's status quad, world px (a bit wider than the body
 * so a lightning arc can whip past the silhouette). */
const QUAD_HALF_W = CHAR_PX * 0.5
/** Half-height, world px — padded above the head for rising flames/arcs. */
const QUAD_HALF_H = CHAR_PX * 0.62

/**
 * The world-space status-effect layer. Mount `root` inside the world container
 * (rides the camera transform like the bullets). Each frame it reads every live
 * character's `fx`, resolves the weapon+mods that applied each status via the
 * source entity, composes the shader uniforms (statusUniforms.ts) and pushes one
 * quad per active shader-status — nothing for a status-free character.
 */
export class StatusFxLayer {
  readonly root = new Container()
  private mesh = new StatusFieldMesh()

  constructor() {
    if (this.mesh.ok) this.root.addChild(this.mesh.root)
  }

  update(entities: readonly Entity[], alpha: number, tick: number): void {
    if (!this.mesh.ok) return
    const t = tick + alpha
    this.mesh.begin()

    // Resolve a status's source entity → the live mod list on its held weapon.
    // NPCs / bare fists / a vanished shooter resolve to undefined → base look.
    const byId = new Map<number, Entity>()
    for (const e of entities) byId.set(e.id, e)
    const resolveMods = (source: number | undefined): readonly WeaponMod[] | undefined => {
      const src = source === undefined ? undefined : byId.get(source)
      return src ? weaponStack(src)?.mods : undefined
    }

    for (const e of entities) {
      if (e.dead || !e.fx) continue
      // Only characters carry a body silhouette worth cladding in an effect.
      if (e.kind !== 'player' && e.kind !== 'npc') continue
      const comp = composeStatus(e.fx, resolveMods)
      if (comp.quads.length === 0) continue

      const x = (e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha) * TILE_PX
      const yTiles = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha
      const footY = charFootPx(yTiles, TILE_PX)
      // Centre the quad on the body (feet-anchored 48px canvas → body centre is
      // half a canvas above the feet).
      const cy = footY - CHAR_PX * 0.5
      const seed = seedOf(e.id)
      for (const q of comp.quads) this.pushQuad(x, cy, q, seed, comp.energy)
    }

    this.mesh.end(t)
  }

  private pushQuad(x: number, y: number, q: StatusQuad, seed: number, energy: number): void {
    // A touch of extra reach as intensity climbs, so a deep-stack build reads
    // as a visibly bigger, angrier effect.
    const grow = 1 + 0.25 * q.intensity
    this.mesh.push({
      x,
      y,
      halfW: QUAD_HALF_W * grow,
      halfH: QUAD_HALF_H * grow,
      effect: q.effect,
      intensity: q.intensity,
      color: q.color,
      seed,
      energy,
    })
  }
}
