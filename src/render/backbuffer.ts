// The backbuffer weapon-FX pipeline — paper-cranes' prevFrame architecture
// (src/Visualizer.js: two framebuffers ping-ponged, the previous COMPOSITE
// frame fed back as a texture) rebuilt on pixi v8 render-to-texture:
//
//   scene pass   — the world container renders into `sceneRT` (resolution-
//                  scaled below device res for phone-GPU fill-rate headroom);
//   composite    — ONE full-screen mesh pass samples sceneRT through the
//                  summed distortion field (distortion.ts primitives: shock
//                  rings, heat shimmer, refraction lenses), mixes the RETAINED
//                  previous composite frame (feedback trails, portal swirl)
//                  and adds the fractal flourishes, into rtA/rtB (ping-pong);
//   present      — a plain Sprite shows the current composite on the stage.
//
// UI/DOM chrome and the screen-post overlays live OUTSIDE the pipeline. The
// fractal flourishes are adapted from paper-cranes shaders (see the FRAGMENT
// comments): the kaleidoscope fold + complex-square iteration from
// shaders/redaphid/wip/fractal_kaleidoscope.frag, the kaliset fold
// abs(p)/dot(p,p) from shaders/redaphid/kali/1.frag, and the rotate-the-
// previous-frame portal swirl from shaders/spinny.frag — palette-constrained
// to the active theme via the uPalDeep/Mid/Hot ramp.
//
// Robustness: construction and every render are fail-safe. If anything throws
// (no render-to-texture, shader refuses to compile), the pipeline permanently
// reattaches the scene for DIRECT rendering and becomes a no-op — the game
// never blanks. Modes: 'full' (everything), 'reduced' (distortion only — no
// feedback, no fractals), 'off' (direct render, zero extra passes).
// Determinism: the shader animates purely off uTime = tick + alpha and per-
// prim seeds — never wall clock, never the world RNG.

import { Container, Mesh, MeshGeometry, RenderTexture, Shader, Sprite } from 'pixi.js'
import type { ShaderFxMode } from '../app/settings'
import { MAX_PRIMS } from './distortion'

export type { ShaderFxMode }

/** Minimum on the render-scale clamp — below this the composite is mush. */
const SCALE_MIN = 0.25
const SCALE_MAX = 2

const VERTEX = /* glsl */ `
  attribute vec2 aPosition;
  attribute vec2 aUV;
  varying vec2 vUv;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
  }
`

// One pass, everything summed. Distances are measured in units of screen
// height (uv * (aspect, 1)); displacement converts back with the inverse.
const FRAGMENT = /* glsl */ `
  precision mediump float;

  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uPrev;
  uniform float uTime;      // sim view-time: tick + alpha (30/s) — never wall clock
  uniform float uAspect;    // screen w/h
  uniform float uFeedback;  // 1 = echo trails + portal swirl (full mode only)
  uniform float uFractals;  // 1 = kaleidoscope bloom + portal kaliset (full only)
  uniform float uPrimCount;
  uniform vec4 uPrimA[${MAX_PRIMS}]; // (u, v, radiusUv, age01)
  uniform vec4 uPrimB[${MAX_PRIMS}]; // (kind, strength, seed, envelope)
  uniform vec4 uPortal;     // (u, v, radiusUv, on)
  uniform vec3 uPalDeep;    // theme ramp: deep / mid / hot
  uniform vec3 uPalMid;
  uniform vec3 uPalHot;

  void main() {
    vec2 asp = vec2(uAspect, 1.0);
    vec2 disp = vec2(0.0);
    float bloomW = 0.0;
    vec2 bloomLocal = vec2(0.0);
    float bloomAge = 0.0;
    float bloomSeed = 0.0;
    float bloomEnv = 0.0;

    for (int i = 0; i < ${MAX_PRIMS}; i++) {
      if (float(i) >= uPrimCount) break;
      vec4 a = uPrimA[i];
      vec4 b = uPrimB[i];
      vec2 d = (vUv - a.xy) * asp;
      float r = length(d);
      float R = max(a.z, 1e-4);
      vec2 dir = d / max(r, 1e-4);
      float str = b.y * b.w; // strength x in/out envelope
      if (b.x < 0.5) {
        // SHOCKWAVE: an expanding ring of radial displacement (explosions).
        float ring = R * a.w;
        float band = max(R * 0.22, 0.012);
        float g = exp(-pow((r - ring) / band, 2.0));
        disp += dir * g * str * (1.0 - a.w) * 0.028;
      } else if (b.x < 1.5) {
        // HEAT SHIMMER: small rising sine-noise wobble inside the radius
        // (fire cells, doused-burn steam).
        float fall = smoothstep(R, R * 0.25, r);
        float t = uTime * 0.42 + b.z * 61.0;
        disp += fall * str * 0.0045 * vec2(
          sin(t * 6.3 + vUv.y * 130.0 + b.z * 40.0),
          cos(t * 4.7 + vUv.x * 110.0) * 0.6 - 0.4);
      } else if (b.x < 2.5) {
        // REFRACTION: a gaussian lens — a one-shot pulse on impacts, a steady
        // warp riding sustained deep-stack rounds (their age saturates at 1).
        float g = exp(-(r * r) / (R * R * 0.45));
        disp += dir * g * str * (sin(min(a.w, 1.0) * 3.14159) * 0.014 + 0.006);
      } else {
        // BLOOM: no displacement — remember the strongest core for the
        // fractal pass below (evaluated once per pixel, not per prim).
        float w = str * smoothstep(R, 0.0, r);
        if (w > bloomW) {
          bloomW = w;
          bloomLocal = d / R;
          bloomAge = a.w;
          bloomSeed = b.z;
          bloomEnv = b.w;
        }
      }
    }

    vec2 uv = clamp(vUv + disp / asp, vec2(0.001), vec2(0.999));
    vec3 col = texture2D(uScene, uv).rgb;

    // FEEDBACK ECHO — paper-cranes' getLastFrameColor(prevFrame) pattern:
    // a decayed, luminance-gated max() with the previous composite frame.
    // Bright energy (deep-stack rounds, blooms) leaves fading trails; static
    // scenery never smears because current >= decayed previous.
    if (uFeedback > 0.5) {
      vec2 fuv = vUv;
      if (uPortal.w > 0.5) {
        // Exit-portal vortex (paper-cranes spinny.frag: rotate the previous
        // frame around a centre) — echoes wind into a slow spiral.
        vec2 pd = (fuv - uPortal.xy) * asp;
        float pr = length(pd);
        float w = smoothstep(uPortal.z, uPortal.z * 0.15, pr);
        float ang = w * 0.22;
        float c = cos(ang);
        float s = sin(ang);
        pd = mat2(c, -s, s, c) * pd;
        fuv = uPortal.xy + pd / asp;
      }
      // A hint of zoom toward centre stretches trails into comet tails.
      fuv += (vec2(0.5) - fuv) * 0.0016;
      vec3 prev = texture2D(uPrev, fuv).rgb;
      float lum = dot(prev, vec3(0.299, 0.587, 0.114));
      // The gate sits HIGH: only genuinely hot pixels (explosion cores, flame,
      // energy glow) echo — ordinary sprites stay ghost-free.
      col = max(col, prev * 0.72 * smoothstep(0.45, 0.85, lum));
    }

    if (uFractals > 0.5) {
      // KALEIDOSCOPIC BLOOM (fractal_kaleidoscope.frag: kaleidoscopeCoords
      // fold + complexMul iteration): mirror-fold the angle, iterate a short
      // complex-square fractal, tint on the theme ramp, window by age.
      if (bloomW > 0.003) {
        float lq = length(bloomLocal);
        float ang2 = atan(bloomLocal.y, bloomLocal.x);
        float seg = 6.28318 / (5.0 + floor(bloomSeed * 4.0));
        ang2 = abs(mod(ang2, seg) - seg * 0.5);
        vec2 z = vec2(cos(ang2), sin(ang2)) * lq * (1.1 + bloomAge * 2.2);
        float v = 0.0;
        for (int j = 0; j < 3; j++) {
          z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y)
            + vec2(sin(bloomSeed * 6.28 + bloomAge * 2.4), cos(bloomSeed * 4.0 + bloomAge * 1.7));
          z += 0.3 * vec2(sin(z.y), cos(z.x));
        v += 1.0 / (length(z) + 0.5);
        }
        v *= 0.3333;
        float env = sin(min(bloomAge, 1.0) * 3.14159) * bloomEnv;
        float fall = 1.0 - min(lq, 1.0);
        vec3 tint = mix(uPalMid, uPalHot, clamp(v * 0.9, 0.0, 1.0));
        col += tint * v * v * env * fall * bloomW * 1.6;
      }
      // EXIT-PORTAL IDLE (kali/1.frag kaliset: p = abs(p)/dot(p,p) fold):
      // a faint fractal glimmer breathing inside the portal ring.
      if (uPortal.w > 0.5) {
        vec2 pd = (vUv - uPortal.xy) * asp / max(uPortal.z, 1e-4);
        float pr = length(pd);
        if (pr < 1.0) {
          vec3 p = vec3(pd * 1.35, 0.42 + 0.08 * sin(uTime * 0.11));
          vec3 acc = vec3(0.0);
          for (int k = 0; k < 5; k++) {
            p = abs(p) / dot(p, p);
            acc += exp(-p * 14.0);
            p -= vec3(0.62, 0.44, 0.98);
          }
          float m = (acc.x + acc.y + acc.z) * 0.2;
          float win = (1.0 - pr) * (1.0 - pr);
          vec3 tint = mix(uPalDeep, uPalMid, clamp(m, 0.0, 1.0));
          col += tint * m * win * 0.5;
        }
      }
    }

    gl_FragColor = vec4(col, 1.0);
  }
`

/** rgb triple from 0xRRGGBB into a Float32Array slot. */
const writeRgb = (out: Float32Array, c: number): void => {
  out[0] = ((c >> 16) & 0xff) / 255
  out[1] = ((c >> 8) & 0xff) / 255
  out[2] = (c & 0xff) / 255
}

/** Linear blend of two 0xRRGGBB colors. Exported for the palette-ramp tests. */
export const mixRgb = (a: number, b: number, t: number): number => {
  const ch = (sa: number, sb: number): number => Math.round(sa + (sb - sa) * t)
  return (
    (ch((a >> 16) & 0xff, (b >> 16) & 0xff) << 16) |
    (ch((a >> 8) & 0xff, (b >> 8) & 0xff) << 8) |
    ch(a & 0xff, b & 0xff)
  )
}

/** The theme-constrained tint ramp the fractal pass draws from: deep (toward
 * the background), mid (the accent itself), hot (accent pushed to white). */
export const paletteRamp = (background: number, accent: number): { deep: number; mid: number; hot: number } => ({
  deep: mixRgb(background, accent, 0.4),
  mid: accent,
  hot: mixRgb(accent, 0xffffff, 0.65),
})

/** The subset of pixi's Renderer the pipeline touches — injectable in tests. */
export interface PipelineRenderer {
  screen: { width: number; height: number }
  render(options: { container: Container; target: RenderTexture; clear?: boolean }): void
}

interface Rig {
  scene: RenderTexture
  ping: RenderTexture
  pong: RenderTexture
  mesh: Mesh
  meshRoot: Container
  out: Sprite
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi v8 uniform group access
  uniforms: any
  shader: Shader
}

export interface BackbufferOptions {
  /** Composite render scale relative to CSS pixels (default 0.75; clamped). */
  scale?: number
  mode?: ShaderFxMode
}

export class BackbufferPipeline {
  /** Mount THIS on the stage where the world used to go. It holds either the
   * composited output sprite (piped) or the scene itself (direct fallback). */
  readonly view = new Container()

  /** Pack distortion.packPrims straight into these — no per-frame allocation. */
  readonly primA = new Float32Array(MAX_PRIMS * 4)
  readonly primB = new Float32Array(MAX_PRIMS * 4)

  private readonly portal = new Float32Array(4)
  private readonly palDeep = new Float32Array(3)
  private readonly palMid = new Float32Array(3)
  private readonly palHot = new Float32Array(3)

  private rig: Rig | undefined
  private broken = false
  private mode: ShaderFxMode
  private readonly scale: number
  private w = 0
  private h = 0
  private flip = false
  private piped = false

  constructor(
    private renderer: PipelineRenderer,
    private sceneRoot: Container,
    opts: BackbufferOptions = {},
  ) {
    this.mode = opts.mode ?? 'full'
    this.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, opts.scale ?? 0.75))
    writeRgb(this.palDeep, 0x2a2438)
    writeRgb(this.palMid, 0xffe066)
    writeRgb(this.palHot, 0xfff6cc)
    try {
      this.rig = this.build()
    } catch (err) {
      this.broken = true
      console.warn('[backbuffer] pipeline unavailable, rendering direct', err)
    }
    this.attach()
  }

  private build(): Rig {
    const make = (): RenderTexture =>
      RenderTexture.create({ width: 8, height: 8, resolution: this.scale, antialias: false })
    const scene = make()
    const ping = make()
    const pong = make()
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    })
    const shader = Shader.from({
      gl: { vertex: VERTEX, fragment: FRAGMENT },
      resources: {
        fxUniforms: {
          uTime: { value: 0, type: 'f32' },
          uAspect: { value: 1, type: 'f32' },
          uFeedback: { value: 1, type: 'f32' },
          uFractals: { value: 1, type: 'f32' },
          uPrimCount: { value: 0, type: 'f32' },
          uPrimA: { value: this.primA, type: 'vec4<f32>', size: MAX_PRIMS },
          uPrimB: { value: this.primB, type: 'vec4<f32>', size: MAX_PRIMS },
          uPortal: { value: this.portal, type: 'vec4<f32>' },
          uPalDeep: { value: this.palDeep, type: 'vec3<f32>' },
          uPalMid: { value: this.palMid, type: 'vec3<f32>' },
          uPalHot: { value: this.palHot, type: 'vec3<f32>' },
        },
        uScene: scene.source,
        uPrev: pong.source,
      },
    })
    // Mesh's option type wants a TextureShader; a plain Shader with explicit
    // sampler resources renders fine (bulletShader.ts uses the same pattern).
    const mesh = new Mesh({ geometry, shader: shader as unknown as Mesh['shader'] })
    const meshRoot = new Container()
    meshRoot.addChild(mesh)
    const out = new Sprite(ping)
    out.eventMode = 'none'
    return { scene, ping, pong, mesh, meshRoot, out, uniforms: (shader.resources.fxUniforms as Rig['uniforms']).uniforms, shader }
  }

  /** True while the composite path is live (built OK and mode != off). */
  get active(): boolean {
    return !this.broken && this.rig !== undefined && this.mode !== 'off'
  }

  /** True if construction/render ever failed — the permanent direct fallback. */
  get failed(): boolean {
    return this.broken
  }

  setMode(mode: ShaderFxMode): void {
    this.mode = mode
    this.attach()
  }

  getMode(): ShaderFxMode {
    return this.mode
  }

  setPortal(u: number, v: number, radiusUv: number): void {
    this.portal[0] = u
    this.portal[1] = v
    this.portal[2] = radiusUv
    this.portal[3] = 1
  }

  clearPortal(): void {
    this.portal[3] = 0
  }

  setPalette(background: number, accent: number): void {
    const ramp = paletteRamp(background, accent)
    writeRgb(this.palDeep, ramp.deep)
    writeRgb(this.palMid, ramp.mid)
    writeRgb(this.palHot, ramp.hot)
  }

  /** Swap the view between the composited sprite and the direct scene. */
  private attach(): void {
    const wantPiped = this.active
    if (wantPiped === this.piped && this.view.children.length > 0) return
    this.view.removeChildren()
    if (wantPiped && this.rig) {
      this.view.addChild(this.rig.out)
    } else {
      this.view.addChild(this.sceneRoot)
    }
    this.piped = wantPiped
  }

  /** Grow/shrink the render targets to the live screen size (allocation only
   * happens on an actual resize — never steady-state per frame). */
  private fit(): void {
    const { width, height } = this.renderer.screen
    if (width === this.w && height === this.h) return
    if (width <= 0 || height <= 0 || !this.rig) return
    this.w = width
    this.h = height
    this.rig.scene.resize(width, height, this.scale)
    this.rig.ping.resize(width, height, this.scale)
    this.rig.pong.resize(width, height, this.scale)
    this.rig.mesh.scale.set(width, height)
    this.rig.out.width = width
    this.rig.out.height = height
  }

  /**
   * Run the frame: scene -> sceneRT, composite -> current ping-pong target,
   * present. `time` must be sim view-time (tick + alpha); `primCount` is the
   * pack count written into primA/primB. On ANY throw the pipeline downgrades
   * itself to the direct path for good — the game keeps rendering.
   */
  render(time: number, primCount: number): void {
    if (!this.active) {
      this.attach() // keep the direct path mounted even after a failure
      return
    }
    const rig = this.rig!
    try {
      this.fit()
      const target = this.flip ? rig.pong : rig.ping
      const prev = this.flip ? rig.ping : rig.pong
      const u = rig.uniforms
      u.uTime = time
      u.uAspect = this.h > 0 ? this.w / this.h : 1
      u.uFeedback = this.mode === 'full' ? 1 : 0
      u.uFractals = this.mode === 'full' ? 1 : 0
      u.uPrimCount = primCount
      rig.shader.resources.uScene = rig.scene.source
      rig.shader.resources.uPrev = prev.source
      this.renderer.render({ container: this.sceneRoot, target: rig.scene, clear: true })
      this.renderer.render({ container: rig.meshRoot, target, clear: true })
      rig.out.texture = target
      // Presented at logical screen size regardless of the RT's backing scale.
      rig.out.width = this.w
      rig.out.height = this.h
      this.flip = !this.flip
    } catch (err) {
      this.broken = true
      console.warn('[backbuffer] render failed, falling back to direct rendering', err)
      this.attach()
    }
  }
}
