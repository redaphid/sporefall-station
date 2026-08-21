import { describe, expect, it, vi } from 'vitest'
import {
  frameErrorBannerText,
  frameErrorMessage,
  guardFrame,
  initialFrameErrors,
  noteFrameError,
  noteFrameOk,
} from './frameErrorModel'

describe('frame error reporting policy', () => {
  it('says nothing while nothing has failed', () => {
    expect(frameErrorBannerText(initialFrameErrors())).toBeNull()
  })

  it('logs the first few of a message, then throttles — but never goes silent', () => {
    let s = initialFrameErrors()
    const logged: number[] = []
    for (let i = 1; i <= 1000; i++) {
      const r = noteFrameError(s, 'TypeError: boom')
      s = r.state
      if (r.log) logged.push(i)
    }
    expect(logged.slice(0, 3), 'the first occurrences must always reach the console').toEqual([1, 2, 3])
    // Throttled, not muted: a fault that repeats for 1000 frames keeps reporting.
    expect(logged.length).toBeGreaterThan(3)
    expect(logged).toContain(300)
    expect(logged).toContain(900)
    expect(s.total).toBe(1000)
  })

  it('a NEW message is never swallowed by an in-flight throttle', () => {
    let s = initialFrameErrors()
    for (let i = 0; i < 500; i++) s = noteFrameError(s, 'TypeError: boom').state
    const r = noteFrameError(s, 'RangeError: different')
    expect(r.log, 'a different failure must be reported immediately').toBe(true)
    expect(r.state.messageCount).toBe(1)
    expect(r.state.total, 'the running total survives the message change').toBe(501)
  })

  it('a clean frame clears the streak but not the history', () => {
    let s = initialFrameErrors()
    s = noteFrameError(s, 'TypeError: boom').state
    s = noteFrameError(s, 'TypeError: boom').state
    expect(s.consecutive).toBe(2)
    s = noteFrameOk(s)
    expect(s.consecutive).toBe(0)
    expect(s.total, 'recovering does not erase the fact that it happened').toBe(2)
    expect(frameErrorBannerText(s), 'the banner stays up after recovery').toContain('Display error (x2)')
  })

  it('the banner carries the real message and flags a persistent stall', () => {
    let s = initialFrameErrors()
    s = noteFrameError(s, "TypeError: Cannot set properties of undefined (setting 'cash')").state
    expect(frameErrorBannerText(s)).toBe(
      "Display error — TypeError: Cannot set properties of undefined (setting 'cash')",
    )
    s = noteFrameError(s, "TypeError: Cannot set properties of undefined (setting 'cash')").state
    expect(frameErrorBannerText(s)).toContain('display stalled, still trying')
  })

  it('describes anything a catch can receive', () => {
    expect(frameErrorMessage(new TypeError('nope'))).toBe('TypeError: nope')
    expect(frameErrorMessage('plain string')).toBe('plain string')
    expect(frameErrorMessage(undefined)).toBe('undefined')
    expect(frameErrorMessage({ a: 1 })).toBe('[object Object]')
    // A thrown object whose toString itself throws must not take the reporter down.
    const hostile = {
      toString() {
        throw new Error('hostile')
      },
    }
    expect(frameErrorMessage(hostile)).toBe('unknown error')
  })
})

/**
 * The freeze itself. `frame()` re-armed requestAnimationFrame as its LAST
 * statement, so one throw ended that phone's rendering for the entire session —
 * the host kept simulating, prediction kept the player walking, and the rest of
 * the party appeared frozen. These assert the property that makes that
 * impossible: the re-arm happens no matter what.
 */
describe('guardFrame keeps the loop alive', () => {
  it('re-arms after a clean frame', () => {
    const rearm = vi.fn()
    const onError = vi.fn()
    guardFrame(() => {}, onError, rearm)
    expect(rearm).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('re-arms after a throw, and hands the error to the reporter', () => {
    const rearm = vi.fn()
    const onError = vi.fn()
    const boom = new TypeError("Cannot set properties of undefined (setting 'cash')")
    expect(() =>
      guardFrame(
        () => {
          throw boom
        },
        onError,
        rearm,
      ),
    ).not.toThrow()
    expect(rearm, 'the next frame must still be scheduled').toHaveBeenCalledTimes(1)
    expect(onError, 'the failure must be surfaced, not swallowed').toHaveBeenCalledWith(boom)
  })

  it('survives a fault that throws on EVERY frame, and recovers when it clears', () => {
    // 600 frames (~10 s) of a persistent throw, then the state heals.
    let rearms = 0
    let broken = true
    let rendered = 0
    let state = initialFrameErrors()
    const run = () =>
      guardFrame(
        () => {
          if (broken) throw new Error('renderView exploded')
          rendered++
          state = noteFrameOk(state)
        },
        (err) => {
          state = noteFrameError(state, frameErrorMessage(err)).state
        },
        () => rearms++,
      )
    for (let i = 0; i < 600; i++) run()
    expect(rearms, 'every broken frame still scheduled the next one').toBe(600)
    expect(state.total).toBe(600)
    expect(state.consecutive).toBe(600)
    expect(rendered, 'nothing rendered while broken').toBe(0)

    broken = false
    for (let i = 0; i < 10; i++) run()
    expect(rendered, 'rendering resumes by itself once the bad state clears').toBe(10)
    expect(state.consecutive).toBe(0)
    expect(state.total, 'and the incident is still on the record').toBe(600)
  })

  it('re-arms even when the error REPORTER throws too', () => {
    const rearm = vi.fn()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      guardFrame(
        () => {
          throw new Error('render')
        },
        () => {
          throw new Error('the banner is broken too')
        },
        rearm,
      ),
    ).not.toThrow()
    expect(rearm).toHaveBeenCalledTimes(1)
    expect(spy, 'a broken reporter is still reported — never silent').toHaveBeenCalled()
    spy.mockRestore()
  })
})
