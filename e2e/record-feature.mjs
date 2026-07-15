import { record } from './lib.mjs'

/**
 * Reusable exact-world-state feature-video recipe (#50). A feature test declares
 * WHAT world to start from, HOW to drive it, WHAT stills to snap, and WHAT must
 * hold afterwards — and gets post-run world-state assertions plus a real mp4.
 *
 * It bridges three existing pieces: the `?world=` boot injection (main.ts), the
 * `?script=` deterministic input timeline (src/input/scripted.ts), and the
 * `record()` harness (e2e/lib.mjs). The whole run is reproducible: the fixture
 * pins seed + entities, the script pins per-tick input.
 *
 * @param {{
 *   name: string,                                  // artifact + still basename
 *   world: string | object,                        // committed fixture NAME, or an inline WorldJson
 *   script?: string,                               // SCRIPTS[...] input timeline (drives the real systems)
 *   klass?: string,                                // player class (default 'soldier')
 *   params?: Record<string,string|number>,         // extra URL params (seed/zoom/…)
 *   stills: {tick:number,label:string}[],          // screenshots at fixed SIM ticks
 *   readState?: () => any,                          // runs in-page; defaults to a generic world summary
 *   expect: (state:any) => (string|false)[],        // adversarial post-run assertions; truthy = failure
 * }} spec
 */
export const recordFeature = (spec) => {
  const isInline = typeof spec.world === 'object' && spec.world !== null
  const params = {
    mode: 'solo',
    class: spec.klass ?? 'soldier',
    e2e: '1',
    // Fixture name → `?world=<name>` (loaded from the bundle at boot). Inline
    // WorldJson → `?world=@inline`, pushed in via window.__loadWorld before ticking.
    world: isInline ? '@inline' : spec.world,
    ...(spec.script ? { script: spec.script } : {}),
    ...(spec.params ?? {}),
  }

  return record({
    name: spec.name,
    params,
    stills: spec.stills,
    // For the inline path, hand the WorldJson to the page before it starts
    // ticking. `record()` awaits this right after navigation (networkidle),
    // and boot blocks on window.__loadWorld until it lands — so injection always
    // precedes tick 0. Fixture-name runs need no beforeTicks hook.
    beforeTicks: isInline
      ? async (page) => {
          await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
          await page.evaluate((j) => window.__loadWorld(j), spec.world)
        }
      : undefined,
    readState:
      spec.readState ??
      (() => {
        const w = window.__world
        const pl = w.entities.find((e) => e.playerCtl)
        return {
          tick: w.tick,
          gameOver: w.gameOver,
          entities: w.entities.length,
          playerHp: pl?.health?.hp ?? null,
        }
      }),
    expect: (s) => spec.expect(s).filter(Boolean),
  })
}
