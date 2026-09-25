// @ts-check
// Freeze-shatter BALANCE proof, recorded in a real browser.
//
// The owner's report: "the freeze mod still allows players to 2-shot everything,
// including bosses." This drives the `boss-freeze` scenario — a real 320hp
// Mireclaw Alpha and an ordinary 40hp thug, both pre-frozen, in one frame — and
// lands one pistol round (14 damage) on each.
//
//   E2E_MODE=before  the OLD rule: BOTH die. The shatter is an instant kill, so
//                    the boss's 320hp pool is irrelevant. This is the bug.
//   E2E_MODE=after   the fix: the thug gibs, the boss survives, down exactly
//                    round(14 x SHATTER_DAMAGE_MULT x 0.75 resist) = 53.
//
// Recorded HEADFUL (E2E_HEADFUL=1, or E2E_CDP at a real browser's DevTools
// endpoint) — see the acquireBrowser doc in lib.mjs for why.
import { record, releaseBrowser } from './lib.mjs'

const MODE = process.env.E2E_MODE === 'before' ? 'before' : 'after'
const DMG = 14 // the pistol
const MULT = 5 // SHATTER_DAMAGE_MULT
const BOSS_HP = 320
const BOSS_RESIST = 0.75
const EXPECTED_BOSS_LOSS = Math.round(DMG * MULT * BOSS_RESIST) // 53

/** Find a STAGED body by archetype. The scenario pre-freezes exactly the two
 * bodies it stages, and the map's ambient population does not, so `fx.frozen`
 * is what separates the Mireclaw on stage from a thug wandering the floor. */
const idOf = (page, archetype) =>
  page.evaluate(
    (a) => window.__world.entities.find((e) => e.archetype === a && !e.dead && e.fx?.frozen)?.id ?? -1,
    archetype,
  )

/** Land the blow and STASH the outcome on the page. `sweepDead` deletes a dead
 * body at the end of the very tick it dies, so reading the world afterwards
 * would find nothing at all and could not tell "gibbed" from "never there". */
const hit = async (page, archetype) => {
  const id = await idOf(page, archetype)
  if (id < 0) throw new Error(`boss-freeze scenario: no live ${archetype} on stage`)
  const res = await page.evaluate(
    ([i, d, a]) => {
      const e = window.__world.byId.get(i)
      if (e?.health) e.health.iframes = 0
      const max = e?.health?.max ?? null
      const out = { ...window.__debug.hit(i, d), max }
      ;(window.__proof ??= {})[a] = out
      return out
    },
    [id, DMG, archetype],
  )
  console.log(`[boss-shatter] hit ${archetype} (#${id}) for ${DMG}:`, JSON.stringify(res))
}

const main = async () => {
  await record({
    name: `boss-shatter-${MODE}`,
    params: { mode: 'solo', scenario: 'boss-freeze', e2e: '1', seed: '424242' },
    stills: [
      { tick: 20, label: '1-both-frozen' },
      { tick: 45, label: '2-thug-hit', act: (page) => hit(page, 'thug') },
      { tick: 75, label: '3-boss-hit', act: (page) => hit(page, 'boss') },
      { tick: 110, label: '4-aftermath' },
    ],
    readState: () => {
      const p = window.__proof ?? {}
      const live = (a) => window.__world.entities.find((e) => e.archetype === a && !e.dead)
      return {
        bossHp: p.boss?.hp ?? null,
        bossMax: p.boss?.max ?? null,
        bossDead: !!p.boss?.dead,
        bossShattered: !!p.boss?.shattered,
        bossStillStanding: !!live('boss'),
        thugDead: !!p.thug?.dead,
        thugShattered: !!p.thug?.shattered,
      }
    },
    expect: (s) => {
      const f = []
      if (s.bossMax !== BOSS_HP) f.push(`staged boss has ${s.bossMax} max hp, expected ${BOSS_HP}`)
      if (!s.thugDead) f.push('the 40hp thug survived a shatter — the mechanic lost its feel')
      if (!s.thugShattered) f.push('the thug died without ice-gibbing')
      if (MODE === 'before') {
        // Asserting the BUG, so a 'before' recording cannot quietly be of a
        // fixed build and get passed off as the broken one.
        if (!s.bossDead) f.push(`expected the OLD instant-kill: boss should be dead, hp=${s.bossHp}`)
        if (s.bossStillStanding) f.push('boss is still on its feet — this is not the pre-fix build')
      } else {
        if (s.bossDead) f.push(`boss died to two shots — the execute is back (hp ${s.bossHp})`)
        if (!s.bossStillStanding) f.push('boss is gone from the world after two shots')
        if (s.bossHp !== BOSS_HP - EXPECTED_BOSS_LOSS) {
          f.push(`boss hp ${s.bossHp}, expected ${BOSS_HP - EXPECTED_BOSS_LOSS} (a ${EXPECTED_BOSS_LOSS} chunk)`)
        }
      }
      return f
    },
  })
  await releaseBrowser()
}

main().catch(async (e) => {
  console.error(e)
  await releaseBrowser()
  process.exit(1)
})
