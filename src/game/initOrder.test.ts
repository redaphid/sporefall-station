import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('module init order', () => {
  it('every src/game module loads as the first module of a fresh native-ESM graph', () => {
    let out: string
    try {
      out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/check-init-order.mts'], { encoding: 'utf8' })
    } catch (e) {
      out = (e as { stdout: string }).stdout
    }
    const report = JSON.parse(out) as { entries: number; failures: { entry: string; error: string }[] }
    expect(report.entries).toBeGreaterThan(50)
    expect(report.failures).toEqual([])
  }, 120_000)
})
