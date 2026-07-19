// @vitest-environment happy-dom
// The backbuffer pipeline's failure-and-mode contract. These tests never need a
// GPU: pixi's Shader/RenderTexture/Mesh construct fine headless (compilation
// happens at first real render), and the renderer seam (PipelineRenderer) is a
// plain object — so we can prove the DEGRADATION path (any failure → permanent
// transparent direct rendering, the game never blanks), the mode wiring
// (full/reduced/off), the ping-pong retention, and the no-allocation reuse.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container, RenderTexture } from 'pixi.js'
import { BackbufferPipeline, mixRgb, paletteRamp, type PipelineRenderer } from './backbuffer'
import { MAX_PRIMS } from './distortion'

interface Call {
  container: Container
  target: RenderTexture
}

const fakeRenderer = (w = 800, h = 600): PipelineRenderer & { calls: Call[] } => {
  const calls: Call[] = []
  return {
    screen: { width: w, height: h },
    calls,
    render(o: { container: Container; target: RenderTexture }) {
      calls.push({ container: o.container, target: o.target })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BackbufferPipeline — pass structure', () => {
  it('mounts the composited output (not the scene) when active', () => {
    const scene = new Container()
    const pipe = new BackbufferPipeline(fakeRenderer(), scene, { mode: 'full' })
    expect(pipe.active).toBe(true)
    expect(pipe.view.children).toHaveLength(1)
    expect(pipe.view.children[0]).not.toBe(scene)
  })

  it('one frame = exactly two renders: scene pass then ONE composite pass', () => {
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'full' })
    pipe.render(1, 0)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[0].container).toBe(scene)
    expect(r.calls[1].container).not.toBe(scene)
  })

  it('ping-pongs the composite target: consecutive frames alternate render textures', () => {
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'full' })
    pipe.render(1, 0)
    pipe.render(2, 0)
    pipe.render(3, 0)
    const composites = [r.calls[1], r.calls[3], r.calls[5]].map((c) => c.target)
    expect(composites[0]).not.toBe(composites[1]) // A, B
    expect(composites[0]).toBe(composites[2]) // back to A — a RETAINED pair, not new textures
  })

  it('the scene pass always reuses ONE scene texture (no per-frame allocation)', () => {
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'full' })
    pipe.render(1, 0)
    pipe.render(2, 0)
    expect(r.calls[0].target).toBe(r.calls[2].target)
  })

  it('render targets track the screen size, scaled below device resolution', () => {
    const scene = new Container()
    const r = fakeRenderer(1000, 500)
    const pipe = new BackbufferPipeline(r, scene, { mode: 'full', scale: 0.5 })
    pipe.render(1, 0)
    const rt = r.calls[0].target
    expect(rt.width).toBe(1000) // logical size = screen
    expect(rt.height).toBe(500)
    expect(rt.source.pixelWidth).toBe(500) // backing store at 0.5x
    r.screen.width = 640
    r.screen.height = 480
    pipe.render(2, 0)
    expect(rt.width).toBe(640)
    expect(rt.height).toBe(480)
  })

  it('uniform arrays are stable identities sized for the shader loop', () => {
    const pipe = new BackbufferPipeline(fakeRenderer(), new Container(), {})
    expect(pipe.primA).toHaveLength(MAX_PRIMS * 4)
    expect(pipe.primB).toHaveLength(MAX_PRIMS * 4)
    const a = pipe.primA
    pipe.render(1, 3)
    expect(pipe.primA).toBe(a) // packers write in place, forever
  })
})

describe('BackbufferPipeline — modes', () => {
  it("mode 'off' mounts the scene directly and never renders offscreen", () => {
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'off' })
    expect(pipe.active).toBe(false)
    expect(pipe.view.children[0]).toBe(scene)
    pipe.render(1, 0)
    expect(r.calls).toHaveLength(0)
  })

  it('setMode switches live: off → full re-pipes, full → off re-mounts the scene', () => {
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'off' })
    pipe.setMode('full')
    expect(pipe.active).toBe(true)
    expect(pipe.view.children[0]).not.toBe(scene)
    pipe.render(1, 0)
    expect(r.calls).toHaveLength(2)
    pipe.setMode('off')
    expect(pipe.view.children[0]).toBe(scene)
    pipe.render(2, 0)
    expect(r.calls).toHaveLength(2) // no new offscreen work
  })

  it("'reduced' still composites (distortion) — feedback/fractal gates are uniform-side", () => {
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'reduced' })
    expect(pipe.active).toBe(true)
    pipe.render(1, 0)
    expect(r.calls).toHaveLength(2)
  })
})

describe('BackbufferPipeline — graceful degradation', () => {
  it('a construction failure (no render-to-texture) falls back to direct rendering', () => {
    vi.spyOn(RenderTexture, 'create').mockImplementation(() => {
      throw new Error('no RTT on this GPU')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scene = new Container()
    const r = fakeRenderer()
    const pipe = new BackbufferPipeline(r, scene, { mode: 'full' })
    expect(pipe.failed).toBe(true)
    expect(pipe.active).toBe(false)
    expect(pipe.view.children[0]).toBe(scene) // the game still renders
    pipe.render(1, 0)
    expect(r.calls).toHaveLength(0)
  })

  it('a render-time failure (shader refuses to compile) downgrades permanently mid-run', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scene = new Container()
    const calls: Call[] = []
    const r: PipelineRenderer = {
      screen: { width: 800, height: 600 },
      render(o: { container: Container; target: RenderTexture }) {
        calls.push(o)
        throw new Error('FRAGMENT shader compile error')
      },
    }
    const pipe = new BackbufferPipeline(r, scene, { mode: 'full' })
    expect(pipe.active).toBe(true)
    pipe.render(1, 0)
    expect(pipe.failed).toBe(true)
    expect(pipe.active).toBe(false)
    expect(pipe.view.children[0]).toBe(scene) // transparently direct again
    const seen = calls.length
    pipe.render(2, 0)
    pipe.render(3, 0)
    expect(calls.length).toBe(seen) // never tries the GPU path again
  })

  it('after a failure, setMode cannot resurrect the broken pipeline', () => {
    vi.spyOn(RenderTexture, 'create').mockImplementation(() => {
      throw new Error('nope')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scene = new Container()
    const pipe = new BackbufferPipeline(fakeRenderer(), scene, { mode: 'full' })
    pipe.setMode('full')
    expect(pipe.active).toBe(false)
    expect(pipe.view.children[0]).toBe(scene)
  })
})

describe('palette ramp — theme-constrained fractal tints', () => {
  it('mixRgb endpoints and midpoint', () => {
    expect(mixRgb(0x000000, 0xffffff, 0)).toBe(0x000000)
    expect(mixRgb(0x000000, 0xffffff, 1)).toBe(0xffffff)
    expect(mixRgb(0x000000, 0xffffff, 0.5)).toBe(0x808080)
    expect(mixRgb(0xff0000, 0x00ff00, 0.5)).toBe(0x808000)
  })

  it('ramp: deep sits between background and accent, hot pushes accent toward white', () => {
    const ramp = paletteRamp(0x101020, 0x40c0ff)
    expect(ramp.mid).toBe(0x40c0ff)
    // deep: strictly between the two on every channel
    const ch = (c: number, s: number): number => (c >> s) & 0xff
    for (const s of [16, 8, 0]) {
      expect(ch(ramp.deep, s)).toBeGreaterThanOrEqual(Math.min(ch(0x101020, s), ch(0x40c0ff, s)))
      expect(ch(ramp.deep, s)).toBeLessThanOrEqual(Math.max(ch(0x101020, s), ch(0x40c0ff, s)))
      expect(ch(ramp.hot, s)).toBeGreaterThanOrEqual(ch(0x40c0ff, s))
    }
  })
})
