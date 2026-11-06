// A run opens with a card choice. Solo, seed 7: the hand is up at landfall, the
// player stands still while it is open, a tap takes a card, and the run goes on.
//
//   pnpm run build && pnpm exec vite preview --port 4899 --strictPort &
//   node scripts/own-chrome.mjs launch     # prints cdpUrl and lockfile
//   E2E_CDP=<cdpUrl> BASE_URL=http://localhost:4899 node e2e/feature-opening-draft.mjs

import { record } from './lib.mjs'

const peek = (page) =>
  page.evaluate(() => {
    const w = window.__world
    const me = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      opening: Boolean(me.playerCtl.draft?.opening),
      title: document.querySelector('.draft-screen')?.textContent?.includes('LANDFALL') ?? false,
      stacks: (me.loadout?.inventory ?? []).reduce((n, st) => n + (st.mods ?? []).reduce((k, m) => k + m.stacks, 0), 0),
    }
  })

const beats = {}

const ok = await record({
  name: 'opening-draft',
  params: { mode: 'solo', seed: '7', e2e: '' },
  stills: [
    {
      tick: 10,
      label: '1-landfall-hand',
      act: async (page) => {
        await page.waitForSelector('.draft-card')
        beats.open = await peek(page)
      },
    },
    {
      tick: 40,
      label: '2-picked',
      act: async (page) => {
        await page.click('.draft-card[data-index="1"]')
        await page.waitForTimeout(500)
        beats.picked = await peek(page)
      },
    },
  ],
  readState: () => ({}),
  expect: () => {
    const f = []
    if (!beats.open?.opening || !beats.open.title) f.push(`no opening hand at landfall: ${JSON.stringify(beats.open)}`)
    if (beats.picked?.opening) f.push('the hand should close after a tap')
    if (beats.picked?.stacks !== (beats.open?.stacks ?? NaN) + 1) f.push(`a pick should add one mod stack: ${JSON.stringify(beats)}`)
    return f
  },
})
process.exit(ok ? 0 : 1)
