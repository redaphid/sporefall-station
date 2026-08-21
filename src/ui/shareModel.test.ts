import { describe, expect, it } from 'vitest'
import {
  initialShare,
  runUpText,
  shareAction,
  shareButtonLabel,
  shareCopyRetried,
  shareErrorMessage,
  shareFailed,
  shareStarted,
  shareStatusText,
  shareSucceeded,
  shareUrl,
} from './shareModel'

describe('shareModel: the button never lies', () => {
  it('says nothing before the first tap', () => {
    expect(shareStatusText(initialShare())).toBeNull()
    expect(shareUrl(initialShare())).toBeNull()
    expect(shareButtonLabel(initialShare())).toContain('Share state')
  })

  it('shows a pending state while the capture is in flight', () => {
    const s = shareStarted()
    expect(shareButtonLabel(s)).toBe('Capturing…')
    expect(shareStatusText(s)).toMatch(/uploading/i)
    expect(shareUrl(s)).toBeNull()
  })

  it('swallows taps while pending, so a double-tap cannot start two uploads', () => {
    expect(shareAction(shareStarted())).toBe('none')
  })

  it('only claims "copied" when the clipboard actually took it', () => {
    const copied = shareSucceeded('https://x/?state=abc', 45, true)
    expect(shareStatusText(copied)).toMatch(/copied to the clipboard/i)

    const refused = shareSucceeded('https://x/?state=abc', 45, false)
    expect(shareStatusText(refused)).not.toMatch(/copied to the clipboard/i)
    expect(shareStatusText(refused)).toMatch(/clipboard refused/i)
  })

  it('offers the URL for manual selection either way — a link you cannot reach is not shared', () => {
    expect(shareUrl(shareSucceeded('https://x/?state=abc', 45, true))).toBe('https://x/?state=abc')
    expect(shareUrl(shareSucceeded('https://x/?state=abc', 45, false))).toBe('https://x/?state=abc')
  })

  it('turns into a plain Copy after a refused clipboard, and retries WITHOUT re-uploading', () => {
    const refused = shareSucceeded('https://x/?state=abc', 45, false)
    expect(shareButtonLabel(refused)).toContain('Copy link')
    expect(shareAction(refused)).toBe('copy')
  })

  it('goes back to sharing once the link is safely on the clipboard', () => {
    const copied = shareSucceeded('https://x/?state=abc', 45, true)
    expect(shareAction(copied)).toBe('share')
  })

  it('a successful copy retry keeps the ORIGINAL run-up — it must not claim the link has none', () => {
    const refused = shareSucceeded('https://x/?state=abc', 45, false)
    const retried = shareCopyRetried(refused, true)
    expect(shareStatusText(retried)).toContain('1.5s of run-up')
    expect(shareStatusText(retried)).toMatch(/copied to the clipboard/i)
    expect(shareUrl(retried)).toBe('https://x/?state=abc')
  })

  it('a copy retry that fails again stays honest and stays retryable', () => {
    const twice = shareCopyRetried(shareSucceeded('https://x/?state=abc', 45, false), false)
    expect(shareStatusText(twice)).toMatch(/clipboard refused/i)
    expect(shareAction(twice)).toBe('copy')
  })

  it('a copy retry against a state with no link is a no-op', () => {
    expect(shareCopyRetried(initialShare(), true)).toEqual(initialShare())
    expect(shareCopyRetried(shareStarted(), true)).toEqual(shareStarted())
  })
})

describe('shareModel: failures surface the real reason', () => {
  it('repeats the self-check refusal verbatim rather than "something went wrong"', () => {
    const s = shareFailed(new Error('refusing to share a state that does not reproduce itself: rng at tick 812'))
    expect(shareStatusText(s)).toContain('does not reproduce itself')
    expect(shareStatusText(s)).toContain('tick 812')
  })

  it('repeats the server\'s own words on an upload failure', () => {
    expect(shareStatusText(shareFailed(new Error('upload failed: 500 kv write denied')))).toContain(
      'upload failed: 500 kv write denied',
    )
  })

  it('never paints a failure as a success, and offers no URL', () => {
    const s = shareFailed(new Error('boom'))
    expect(shareStatusText(s)).toMatch(/^Share failed/)
    expect(shareUrl(s)).toBeNull()
  })

  it('lets a failed share be retried', () => {
    expect(shareAction(shareFailed(new Error('boom')))).toBe('share')
    expect(shareButtonLabel(shareFailed(new Error('boom')))).toContain('Try again')
  })

  it('survives anything a catch can receive', () => {
    expect(shareErrorMessage('plain string')).toBe('plain string')
    expect(shareErrorMessage(new Error(''))).toBe('unknown error')
    expect(shareErrorMessage(undefined)).toBe('undefined')
    expect(shareErrorMessage({ toString: () => { throw new Error('hostile') } })).toBe('unknown error')
  })

  it('elides an error too long for a phone screen instead of overflowing it', () => {
    const msg = shareErrorMessage(new Error('x'.repeat(500)))
    expect(msg.length).toBe(200)
    expect(msg.endsWith('…')).toBe(true)
  })
})

describe('shareModel: run-up is reported, including when there is none', () => {
  it('converts ticks to the seconds of gameplay the link carries', () => {
    expect(runUpText(45)).toBe('1.5s of run-up') // SIM_DT = 1/30
    expect(runUpText(30)).toBe('1.0s of run-up')
  })

  it('says plainly when a capture carries no lead-in', () => {
    expect(runUpText(0)).toMatch(/no run-up/)
    expect(shareStatusText(shareSucceeded('https://x/?state=abc', 0, true))).toMatch(/no run-up/)
  })
})
