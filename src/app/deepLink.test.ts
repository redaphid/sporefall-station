import { describe, expect, it } from 'vitest'
import { overridesSave, persistsRun, readDeepLink, resumesSave, unknownScenarioMessage, wantsFreshBuild } from './deepLink'

const link = (qs: string) => readDeepLink(new URLSearchParams(qs))

// The owner opened `?mode=solo&seed=18&scenario=armed&floor=3` and was handed
// what looked like their existing game, and the link's run was then autosaved
// over their real one. A link that names a world must always win over the save,
// and must never write to it.
describe('deep links vs the saved run', () => {
  const OWNER_URL = '?mode=solo&seed=18&scenario=armed&floor=3'

  it('the reported URL overrides the save: no resume, no autosave', () => {
    const l = link(OWNER_URL)
    expect(l.scenario).toBe('armed')
    expect(overridesSave(l)).toBe(true)
    expect(resumesSave(l)).toBe(false)
    expect(persistsRun(l)).toBe(false)
    expect(wantsFreshBuild(l)).toBe(true)
  })

  it.each(['?state=abc123', '?world=fire-demo', '?mode=solo&world=@inline&e2e'])('%s overrides the save', (qs) => {
    const l = link(qs)
    expect(resumesSave(l)).toBe(false)
    expect(persistsRun(l)).toBe(false)
    expect(wantsFreshBuild(l)).toBe(true)
  })

  it('an e2e ?script= overrides the save but is not a link worth updating for', () => {
    const l = link('?mode=solo&script=walk')
    expect(resumesSave(l)).toBe(false)
    expect(persistsRun(l)).toBe(false)
    expect(wantsFreshBuild(l)).toBe(false)
  })

  it.each(['', '?mode=solo', '?mode=solo&seed=18', '?scenario=', '?room=abc&name=Aaron'])(
    '%s is an ordinary run: resumes and autosaves',
    (qs) => {
      const l = link(qs)
      expect(resumesSave(l)).toBe(true)
      expect(persistsRun(l)).toBe(true)
      expect(wantsFreshBuild(l)).toBe(false)
    },
  )
})

describe('unknownScenarioMessage', () => {
  it('names the scenario, the build and the way out, and promises the save is safe', () => {
    const msg = unknownScenarioMessage('armd', ['armed', 'fire'], '553')
    expect(msg).toContain('"armd"')
    expect(msg).toContain('553')
    expect(msg).toContain('armed, fire')
    expect(msg).toMatch(/saved run is untouched/)
    expect(msg).toMatch(/reload/i)
  })
})
