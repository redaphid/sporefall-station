import type { SimEvent } from '../game/types'

/**
 * Zero-asset WebAudio synth: every effect is an oscillator/noise envelope.
 * Created lazily on first user gesture (autoplay policy).
 */
export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private lastPlayed = new Map<string, number>()

  constructor() {
    const unlock = (): void => {
      this.ensure()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = 0.35
        this.master.connect(this.ctx.destination)
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  handle(events: readonly SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'hit':
          this.blip('hit', 160, 90, 0.06, 'square', 0.5)
          break
        case 'death':
          this.sweep('death', 220, 40, 0.25)
          break
        case 'pickup':
          this.blip('pickup', 660, 990, 0.09, 'sine', 0.6)
          break
        case 'modPickup':
          // A brighter two-step chirp than a plain pickup — "you upgraded your gun".
          this.blip('modPickup', 880, 1320, 0.14, 'triangle', 0.7)
          break
        case 'doorToggle':
          this.blip('door', 120, 80, 0.08, 'triangle', 0.7)
          break
        case 'pickStart':
          // Soft tumbler click — "the pick is in, hold still".
          this.blip('pick', 880, 440, 0.05, 'square', 0.35)
          break
        case 'pickCancel':
          // Low dud thunk — the channel broke, distinct from any success sound.
          this.blip('pickfail', 140, 60, 0.12, 'sawtooth', 0.5)
          break
        case 'doorBreach':
          // Splintering crack on top of the blast's boom.
          this.blip('breach', 500, 90, 0.18, 'sawtooth', 0.8)
          break
        case 'explosion':
          this.noise('boom', 0.35, 0.9)
          break
        case 'missionComplete':
          this.jingle()
          break
        case 'noise':
          this.blip('crack', 300, 150, 0.12, 'sawtooth', 0.4)
          break
        case 'floorChange':
          this.jingle(1.25)
          break
        case 'burnDoused':
          // A short falling hiss — steam off a smothered burn.
          this.noise('douse', 0.12, 0.35)
          break
      }
    }
  }

  /** Rate-limit each effect key so event bursts don't stack into noise. */
  private gate(key: string, minGapMs = 60): boolean {
    const now = performance.now()
    if (now - (this.lastPlayed.get(key) ?? 0) < minGapMs) return false
    this.lastPlayed.set(key, now)
    return true
  }

  private blip(key: string, from: number, to: number, dur: number, type: OscillatorType, vol: number): void {
    const ctx = this.ensure()
    if (!ctx || !this.gate(key)) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(from, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), ctx.currentTime + dur)
    gain.gain.setValueAtTime(vol, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    osc.connect(gain).connect(this.master!)
    osc.start()
    osc.stop(ctx.currentTime + dur)
  }

  private sweep(key: string, from: number, to: number, dur: number): void {
    this.blip(key, from, to, dur, 'sawtooth', 0.5)
  }

  private noise(key: string, dur: number, vol: number): void {
    const ctx = this.ensure()
    if (!ctx || !this.gate(key, 150)) return
    const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 400
    src.connect(filter).connect(gain).connect(this.master!)
    src.start()
  }

  private jingle(mult = 1): void {
    const ctx = this.ensure()
    if (!ctx || !this.gate('jingle', 500)) return
    const notes = [523, 659, 784, 1047]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq * mult
      const t = ctx.currentTime + i * 0.09
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
      osc.connect(gain).connect(this.master!)
      osc.start(t)
      osc.stop(t + 0.3)
    })
  }
}
