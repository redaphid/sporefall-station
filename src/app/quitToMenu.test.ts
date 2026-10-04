import { describe, expect, it } from 'vitest'
import { createQuitToMenu, QUIT_NET_GRACE_MS, type QuitDeps } from './quitToMenu'

const rig = (closeNet: () => Promise<void> = async () => {}) => {
  const log: string[] = []
  let releaseWait: () => void = () => {}
  const waits: number[] = []
  const deps: QuitDeps = {
    abandonRun: () => log.push('abandon'),
    closeNet: () => {
      log.push('closeNet')
      return closeNet()
    },
    goToMenu: () => log.push('menu'),
    wait: (ms) => {
      waits.push(ms)
      return new Promise((r) => (releaseWait = r))
    },
  }
  return { deps, log, waits, timeout: () => releaseWait() }
}

describe('createQuitToMenu', () => {
  it('abandons the run, closes the net session, then goes to the menu, in that order', async () => {
    const r = rig()
    await createQuitToMenu(r.deps)()
    expect(r.log).toEqual(['abandon', 'closeNet', 'menu'])
  })

  it('waits for the net close before leaving, so peers hear the host go', async () => {
    let finishClose: () => void = () => {}
    const r = rig(() => new Promise<void>((res) => (finishClose = res)))
    const done = createQuitToMenu(r.deps)()
    await Promise.resolve()
    expect(r.log).toEqual(['abandon', 'closeNet'])
    finishClose()
    await done
    expect(r.log).toEqual(['abandon', 'closeNet', 'menu'])
  })

  it('still reaches the menu when the net close hangs, after a bounded grace', async () => {
    const r = rig(() => new Promise<void>(() => {}))
    const done = createQuitToMenu(r.deps)()
    await Promise.resolve()
    expect(r.waits).toEqual([QUIT_NET_GRACE_MS])
    expect(r.log).not.toContain('menu')
    r.timeout()
    await done
    expect(r.log).toEqual(['abandon', 'closeNet', 'menu'])
  })

  it('still reaches the menu when the net close throws', async () => {
    const r = rig(() => Promise.reject(new Error('radio gone')))
    await createQuitToMenu(r.deps)()
    expect(r.log).toEqual(['abandon', 'closeNet', 'menu'])
  })

  it('a second quit while the first is leaving does nothing more', async () => {
    const r = rig()
    const quit = createQuitToMenu(r.deps)
    await Promise.all([quit(), quit()])
    expect(r.log).toEqual(['abandon', 'closeNet', 'menu'])
  })
})
