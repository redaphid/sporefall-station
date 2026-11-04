import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PAGES } from './pages'

describe('the pages Vite builds', () => {
  it('builds the game as the `index` entry, so its chunk stays assets/index-*.js', () => {
    expect(PAGES.index).toBe('index.html')
  })

  it('names, as an entry, every script the e2e runners and doctor.sh look for', () => {
    const checkers = ['e2e/run-stairs.sh', 'e2e/run-deep-link-wins.sh', '.claude/skills/verify-sporefall/scripts/doctor.sh']
    for (const file of checkers) {
      const wanted = [...readFileSync(file, 'utf8').matchAll(/assets\/([a-z]+)-\[/g)].map((m) => m[1])
      expect(wanted.length, file).toBeGreaterThan(0)
      for (const key of wanted) expect(Object.keys(PAGES), `${file} greps for assets/${key}-*.js`).toContain(key)
    }
  })

  it('has a page file for every entry', () => {
    for (const file of Object.values(PAGES)) expect(readFileSync(file, 'utf8')).toMatch(/<script type="module" src="\/src\//)
  })
})
