import { describe, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { ARENAS } from '../game/arenas'
import { applyScenario } from '../game/scenarios'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { expectWorldEqual } from '../game/testkit'
import { emptyInput } from '../game/types'
import type { World } from '../game/world'
import { CENSUS_BUILDS, CENSUS_SEEDS, botInput } from './census'
import { runVerb } from './verbs'

const botStep = (w: World): void => {
  const me = w.entities.find((e) => e.playerCtl)!
  const s = botInput(w, me)
  runVerb(w, s ? `step 1 ${JSON.stringify(s)}` : 'step 1')
}

// The review test reloads each arena at tick 0. This one reloads mid-fight, with
// statuses, projectiles and a mod sequence in flight. Four seeds keep it near 6 s.
describe('arenas reload mid-fight with a modded bot', () => {
  const cases = Object.keys(ARENAS).flatMap((a) => CENSUS_SEEDS.slice(0, 4).flatMap((s) => [37, 91].map((at) => [a, s, at] as const)))
  it.each(cases)('%s seed %i reload at tick %i', (arena, seed, at) => {
    const w = new HostSession(seed, { sample: emptyInput }).world
    applyScenario(w, arena)
    const me = w.entities.find((e) => e.playerCtl)!
    for (const m of CENSUS_BUILDS.find((b) => b.name === 'hand fire-lead')!.mods) runVerb(w, `addMod ${me.id} ${m}`)
    for (let i = 0; i < at; i++) botStep(w)
    const re = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))) as WorldJson)
    for (let i = 0; i < 120; i++) {
      botStep(w)
      botStep(re)
    }
    expectWorldEqual(re, w)
  })
})
