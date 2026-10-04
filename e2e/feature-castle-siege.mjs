// Authored worlds: the crafted `castle-siege` save, a hand-drawn castle whose
// level comes from the save itself rather than seed+floor. Boots it via
// `?world=castle-siege` and plays the `castle-siege` input timeline through the
// real systems. Assertions: the level on screen is the drawn 44x32 castle, the
// player still carries all four mods, the garrison took damage, and the keep's
// exit stayed shut while the castle lord lives.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const save = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/castle-siege.json'), 'utf8'))
const hpAtStart = Object.fromEntries(save.entities.filter((e) => !e.playerCtl).map((e) => [e.id, e.health.hp]))

await recordFeature({
  name: 'feature-castle-siege',
  world: 'castle-siege',
  script: 'castle-siege',
  params: { zoom: 1.2 },
  stills: [
    { tick: 15, label: '01-at-the-drawbridge' },
    { tick: 75, label: '02-through-the-gate' },
    { tick: 150, label: '03-courtyard-fight' },
    { tick: 250, label: '04-toward-the-keep' },
  ],
  readState: () => {
    const w = window.__world
    const pl = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      floor: w.floor,
      levelW: w.level.w,
      levelH: w.level.h,
      gameOver: w.gameOver,
      exitUnlocked: w.mission.exitUnlocked,
      mods: pl?.loadout?.inventory?.[0]?.mods?.map((m) => `${m.id}x${m.stacks}`) ?? [],
      npcHp: Object.fromEntries(w.entities.filter((e) => !e.playerCtl).map((e) => [e.id, e.health?.hp ?? 0])),
    }
  },
  expect: (s) => {
    const hurt = Object.entries(hpAtStart).filter(([id, hp]) => (s.npcHp[id] ?? 0) < hp)
    return [
      (s.levelW !== 44 || s.levelH !== 32) && `level is ${s.levelW}x${s.levelH}, not the drawn 44x32 castle`,
      s.floor !== 1 && `left the castle (floor ${s.floor}) with its lord alive`,
      s.exitUnlocked && 'the keep exit unlocked before the castle lord fell',
      s.mods.join(',') !== 'splitx1,frostx1,piercex2,homingx1' && `mods changed: ${s.mods.join(',')}`,
      hurt.length === 0 && 'no garrison member took damage',
    ]
  },
})
