// @ts-check
// The BOSS HEALTH BAR, recorded in a real headed browser.
//
// What this PR claims, and therefore what this clip has to show:
//   1. the bar arrives on the REAL entrance — `mireclawSystem.maybeReveal`
//      pushes the genuine `bossReveal`, `latchBossId` latches it, the HUD
//      paints (no synthetic event is injected);
//   2. it DRAINS as the Alpha takes real damage through `applyDamage`,
//      including the #79 shatter, and crosses the phase copy on the way down;
//   3. it is GONE the instant the player goes down — the bug this PR fixes,
//      where a z-index:66 HUD painted over a YOU DIED overlay that carries no
//      z-index at all.
//
// Point 2 only exists because of #79. Under the old instant-kill shatter the
// 320hp Alpha died on the second frost shot, so the bar never drew an
// intermediate width and point 3 was nearly unreachable against a boss: it
// was dead before it could kill you. A bar that drains is a post-#79 bar.
//
// STAGING. `scenario=boss-freeze` stages a real 320hp Alpha, but like every
// staged body it is parked with `ai = undefined`, and `mireclawSystem` skips a
// body with no mireclaw brain — so it would never announce itself. We hand the
// brain back exactly as `populate.spawnNpc` builds it, which makes the entrance
// this clip opens on the shipping one rather than a fixture. Damage is dealt
// through `__debug.hit` → `applyDamage`, the same seam the merged
// `boss-shatter` proof uses.
//
// Recorded HEADFUL (E2E_HEADFUL=1, or E2E_CDP at a real browser's DevTools
// endpoint) — see the acquireBrowser doc in lib.mjs for why.
import { record, releaseBrowser } from './lib.mjs'

const PISTOL = 14
const SHATTER_MULT = 5 // SHATTER_DAMAGE_MULT
const BOSS_RESIST = 0.75 // NPCS.boss.resist.physical
/** What a shatter must take off a 320hp Alpha: the same figure the merged
 * boss-shatter proof pins, re-derived here rather than copied as a magic 53. */
const EXPECTED_SHATTER_BITE = Math.round(PISTOL * SHATTER_MULT * BOSS_RESIST)

/** Read the bar straight off the shipping DOM that screens.ts builds. */
const readBar = (page) =>
  page.evaluate(() => {
    const hp = document.querySelector('#bossHp')
    const hud = hp?.parentElement?.parentElement
    return {
      shown: !!hud && getComputedStyle(hud).display !== 'none',
      width: hp ? hp.style.width : null,
      name: document.querySelector('#bossName')?.textContent ?? null,
      phase: document.querySelector('#bossPhase')?.textContent ?? null,
      zIndex: hud ? hud.style.zIndex : null,
    }
  })

/** Stash a bar reading under `label` so `readState` can assert the SEQUENCE,
 * not just the last frame. */
const sample = async (page, label) => {
  const bar = await readBar(page)
  await page.evaluate(([l, b]) => ((window.__bar ??= {})[l] = b), [label, bar])
  console.log(`[boss-bar] ${label}: ${JSON.stringify(bar)}`)
  return bar
}

const bossId = (page) =>
  page.evaluate(() => window.__world.entities.find((e) => e.archetype === 'boss' && !e.dead)?.id ?? -1)

/** Land pistol rounds on the Alpha until the bar is at or under `frac`, or the
 * cap runs out. Driven by the boss's ACTUAL hp rather than a guessed shot count,
 * because the per-hit figure is the sim's business (resist, rally, phase) and
 * this clip should not go stale the next time any of that is tuned. */
const chipTo = async (page, frac, cap = 60) => {
  const id = await bossId(page)
  if (id < 0) throw new Error('boss-bar: no live boss on stage')
  return page.evaluate(
    ([i, target, n, d]) => {
      let out = null
      for (let k = 0; k < n; k++) {
        const e = window.__world.byId.get(i)
        if (!e || e.dead || !e.health) break
        if (e.health.hp / e.health.max <= target) break
        e.health.iframes = 0
        out = window.__debug.hit(i, d)
      }
      return out
    },
    [id, frac, cap, PISTOL],
  )
}

/**
 * A real #79 shatter, taken on the freeze the SCENARIO staged.
 *
 * Deliberately not `__debug.freeze` + hit: `frozen` is an immobilize, so
 * `applyImmobilize`'s anti-chain-lock hands back a post-lock immunity window
 * after the staged freeze expires, and a re-freeze inside it is silently
 * refused. The first attempt at this clip did exactly that and recorded an
 * ORDINARY 11-point hit while calling it a shatter — the assertion below is
 * what caught it, and it stays as the thing that keeps it caught.
 */
const shatter = async (page) => {
  const id = await bossId(page)
  const res = await page.evaluate(
    ([i, d]) => {
      const e = window.__world.byId.get(i)
      if (!e?.fx?.frozen) throw new Error('boss-bar: the Alpha thawed before the shatter still')
      const before = e.health.hp
      e.health.iframes = 0
      return { before, ...window.__debug.hit(i, d) }
    },
    [id, PISTOL],
  )
  console.log(`[boss-bar] shatter: ${JSON.stringify(res)}`)
  await page.evaluate((r) => ((window.__bar ??= {}).shatterHit = r), res)
  return res
}

/** Put the local player down for real, through the damage path. */
const downPlayer = (page) =>
  page.evaluate(() => {
    const p = window.__world.entities.find((e) => e.playerCtl && !e.dead)
    if (!p) throw new Error('boss-bar: no live player')
    if (p.health) p.health.iframes = 0
    return window.__debug.hit(p.id, 9999)
  })

const main = async () => {
  await record({
    name: 'boss-bar',
    params: { mode: 'solo', scenario: 'boss-freeze', e2e: '1', seed: '424242' },
    // Hand the staged Alpha its real brain back BEFORE tick 0, so the entrance
    // that opens this clip is fired by mireclawSystem itself.
    beforeTicks: async (page) => {
      // `__world` is published by main.ts once boot finishes, which is after
      // navigation returns — so wait for it rather than racing it. The Alpha is
      // still unrevealed at this point (a brainless body never announces
      // itself), so nothing about the entrance has been missed.
      await page.waitForFunction(() => !!window.__world?.entities?.length, null, { timeout: 30000 })
      await page.evaluate(() => {
        const b = window.__world.entities.find((e) => e.archetype === 'boss' && !e.dead)
        if (!b) throw new Error('boss-bar: scenario staged no boss')
        b.ai = {
          mode: 'idle',
          faction: 'gang',
          home: { x: b.pos.x, y: b.pos.y },
          thinkAt: 0,
          sightRange: 10,
          behavior: 'mireclaw',
        }
      })
      // WAIT FOR THE REAL ENTRANCE. `maybeReveal` needs a live player inside
      // REVEAL_RANGE with line of sight, and how many ticks that takes is the
      // sim's business, not this script's — an earlier cut assumed "by tick 25"
      // and recorded a run where the bar had not come up yet. Latch on
      // `mission.bossRevealed`, which is the flag the reveal itself sets.
      await page.waitForFunction(() => window.__world?.mission?.bossRevealed === true, null, { timeout: 30000 })
      console.log('[boss-bar] the Alpha announced itself (mission.bossRevealed)')
    },
    stills: [
      // The Alpha is still inside the freeze the scenario staged, so the
      // shatter that follows is taken on a genuine frozen body.
      { tick: 25, label: '1-entrance-bar-full', act: (p) => sample(p, 'full') },
      { tick: 45, label: '2-shatter-bite', act: async (p) => (await shatter(p), sample(p, 'shatter')) },
      { tick: 85, label: '3-chipped-down', act: async (p) => (await chipTo(p, 0.45), sample(p, 'chipped')) },
      { tick: 125, label: '4-enraged', act: async (p) => (await chipTo(p, 0.15), sample(p, 'enraged')) },
      { tick: 160, label: '5-player-down-bar-gone', act: async (p) => (await downPlayer(p), sample(p, 'down')) },
      { tick: 195, label: '6-death-screen-clean', act: (p) => sample(p, 'settled') },
    ],
    readState: () => {
      const b = window.__bar ?? {}
      const boss = window.__world.entities.find((e) => e.archetype === 'boss')
      return {
        shatterHit: b.shatterHit ?? null,
        full: b.full ?? null,
        chipped: b.chipped ?? null,
        shatter: b.shatter ?? null,
        enraged: b.enraged ?? null,
        down: b.down ?? null,
        settled: b.settled ?? null,
        bossAliveAtEnd: !!boss && !boss.dead,
        bossHp: boss?.health?.hp ?? null,
      }
    },
    expect: (s) => {
      const f = []
      const pct = (r) => (r && typeof r.width === 'string' ? parseFloat(r.width) : NaN)

      if (!s.full?.shown) f.push('the entrance never raised the bar')
      if (s.full?.zIndex !== '66') f.push(`bar z-index ${s.full?.zIndex}, expected 66 (the premise of this PR)`)
      if (pct(s.full) !== 100) f.push(`bar opened at ${s.full?.width}, expected 100%`)

      // #79: the shatter is a HIT the Alpha survives, and a big one — the whole
      // reason this bar has anything to draw between full and gone.
      // NB the evidence is the BITE, not a `shattered` flag: combat.ts stamps
      // `shattered` only when the shattering blow is the one that kills, since
      // it is the cue to leave ice instead of a corpse. A boss that walks away
      // from a shatter is the whole point of #79, so it never carries the flag
      // — an earlier cut of this clip asserted on it and failed a passing run.
      const h = s.shatterHit
      if (h?.dead) f.push('the shatter KILLED the Alpha — that is the pre-#79 execute, not the fix')
      const bite = h ? h.before - h.hp : 0
      if (bite !== EXPECTED_SHATTER_BITE) {
        f.push(`shatter took ${bite}, expected ${EXPECTED_SHATTER_BITE} (${PISTOL} x${SHATTER_MULT} x${BOSS_RESIST})`)
      }

      // It DRAINS, monotonically, while the boss stays alive.
      const steps = [pct(s.full), pct(s.shatter), pct(s.chipped), pct(s.enraged)]
      for (let i = 1; i < steps.length; i++) {
        if (!(steps[i] < steps[i - 1])) f.push(`bar did not drain at step ${i}: ${steps[i - 1]}% -> ${steps[i]}%`)
      }
      if (!s.enraged?.shown) f.push('the bar vanished before the player went down')
      // Phase copy tracks the sim's own thresholds (ENRAGE_FRAC 0.2).
      if (!/ENRAGED/.test(s.enraged?.phase ?? '')) f.push(`phase copy read "${s.enraged?.phase}", expected ENRAGED`)
      if (!/SUMMONING/.test(s.full?.phase ?? '')) f.push(`opening phase copy read "${s.full?.phase}"`)

      // THE FIX: down the player and the bar goes, off a boss that is still up.
      if (!s.bossAliveAtEnd) f.push('the Alpha died — this clip must end with a LIVING boss, or it proves nothing')
      if (s.down?.shown) f.push('BUG: the bar is still painted after the player went down')
      if (s.settled?.shown) f.push('BUG: the bar came back on the death screen')
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
