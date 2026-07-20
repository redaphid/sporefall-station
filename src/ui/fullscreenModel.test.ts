import { describe, expect, it, vi } from 'vitest'
import {
  canRequestFullscreen,
  enterFullscreen,
  exitFullscreen,
  fullscreenSupported,
  isFullscreen,
  shouldHideCursor,
  type CursorState,
  type FullscreenGate,
} from './fullscreenModel'

describe('shouldHideCursor', () => {
  const state = (over: Partial<CursorState> = {}): CursorState => ({
    paused: false,
    gameOver: false,
    selfDead: false,
    ...over,
  })

  it('hides the cursor during active play', () => {
    expect(shouldHideCursor(state())).toBe(true)
  })

  it('shows the cursor while paused (so the pause buttons are clickable)', () => {
    expect(shouldHideCursor(state({ paused: true }))).toBe(false)
  })

  it('shows the cursor on the game-over screen', () => {
    expect(shouldHideCursor(state({ gameOver: true }))).toBe(false)
  })

  it('shows the cursor when the local player is dead (death screen owns the moment)', () => {
    expect(shouldHideCursor(state({ selfDead: true }))).toBe(false)
  })

  it('any non-play condition wins over the others', () => {
    expect(shouldHideCursor(state({ paused: true, gameOver: true, selfDead: true }))).toBe(false)
  })
})

describe('canRequestFullscreen', () => {
  const gate = (over: Partial<FullscreenGate> = {}): FullscreenGate => ({
    enabled: true,
    supported: true,
    native: false,
    alreadyFullscreen: false,
    ...over,
  })

  it('requests when wanted, supported, non-native, and not already fullscreen', () => {
    expect(canRequestFullscreen(gate())).toBe(true)
  })

  it('does not request when the player disabled it', () => {
    expect(canRequestFullscreen(gate({ enabled: false }))).toBe(false)
  })

  it('does not request when the browser does not support it', () => {
    expect(canRequestFullscreen(gate({ supported: false }))).toBe(false)
  })

  it('does not request inside the native Capacitor shell (already fullscreen)', () => {
    expect(canRequestFullscreen(gate({ native: true }))).toBe(false)
  })

  it('does not re-request when already fullscreen', () => {
    expect(canRequestFullscreen(gate({ alreadyFullscreen: true }))).toBe(false)
  })
})

describe('Fullscreen API glue (feature-detected, injectable)', () => {
  it('fullscreenSupported / isFullscreen read the document flags', () => {
    expect(fullscreenSupported({ fullscreenEnabled: true })).toBe(true)
    expect(fullscreenSupported({ fullscreenEnabled: false })).toBe(false)
    expect(fullscreenSupported({})).toBe(false)
    expect(isFullscreen({ fullscreenElement: {} as Element })).toBe(true)
    expect(isFullscreen({ fullscreenElement: null })).toBe(false)
    expect(isFullscreen({})).toBe(false)
  })

  it('enterFullscreen requests when supported and not already fullscreen', () => {
    const req = vi.fn().mockResolvedValue(undefined)
    enterFullscreen({ requestFullscreen: req }, { fullscreenEnabled: true, fullscreenElement: null })
    expect(req).toHaveBeenCalledOnce()
  })

  it('enterFullscreen is a no-op when unsupported', () => {
    const req = vi.fn().mockResolvedValue(undefined)
    enterFullscreen({ requestFullscreen: req }, { fullscreenEnabled: false })
    expect(req).not.toHaveBeenCalled()
  })

  it('enterFullscreen is a no-op when already fullscreen', () => {
    const req = vi.fn().mockResolvedValue(undefined)
    enterFullscreen({ requestFullscreen: req }, { fullscreenEnabled: true, fullscreenElement: {} as Element })
    expect(req).not.toHaveBeenCalled()
  })

  it('enterFullscreen swallows a rejected request (browser denial must not crash)', () => {
    const req = vi.fn().mockRejectedValue(new Error('denied'))
    expect(() => enterFullscreen({ requestFullscreen: req }, { fullscreenEnabled: true, fullscreenElement: null })).not.toThrow()
    expect(req).toHaveBeenCalledOnce()
  })

  it('exitFullscreen leaves only when currently fullscreen', () => {
    const exit = vi.fn().mockResolvedValue(undefined)
    exitFullscreen({ fullscreenElement: {} as Element, exitFullscreen: exit })
    expect(exit).toHaveBeenCalledOnce()
    exit.mockClear()
    exitFullscreen({ fullscreenElement: null, exitFullscreen: exit })
    expect(exit).not.toHaveBeenCalled()
  })

  it('exitFullscreen swallows a rejected exit', () => {
    const exit = vi.fn().mockRejectedValue(new Error('nope'))
    expect(() => exitFullscreen({ fullscreenElement: {} as Element, exitFullscreen: exit })).not.toThrow()
  })
})
