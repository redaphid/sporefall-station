// Procedural bullet visuals — asserted feature videos. Injects the committed
// combat-stage world with the player re-armed to specific MOD LOADOUTS, replays
// the proven `shooting` timeline, and records an mp4 per loadout: a vanilla
// control (bullets must stay the classic gold tracer — NPC/enemy fire always
// looks like this), a 3-mod signature build, and a max-stack monster build.
// A page-side sampler proves the bullets IN FLIGHT carried the exact expected
// mod provenance (the substrate the renderer composes the look from).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { record } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const armed = (weaponId, mods) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = weaponId
  p.playerCtl.inventory = [{ itemId: weaponId, qty: 99, ...(mods ? { mods } : {}) }]
  p.playerCtl.activeSlot = 0
  return w
}

const ALL_MODS = [
  'overload', 'bulk', 'rapid', 'heavy', 'choke', 'velocity', 'glassCannon',
  'frost', 'incendiary', 'shock', 'bounce', 'pierce', 'homing', 'explosive',
  'split', 'lifesteal', 'detonator',
]

const stills = [
  { tick: 240, label: '01-opening-fire' },
  { tick: 280, label: '02-stream' },
  { tick: 330, label: '03-sustained' },
  { tick: 400, label: '04-aftermath' },
]

const readState = () => {
  const w = window.__world
  const thugs = w.entities.filter((e) => e.archetype === 'thug')
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    thugsAlive: thugs.filter((e) => !e.dead).length,
    seenMods: [...(window.__seenModIds ?? [])].sort(),
    moddedBulletsSeen: window.__moddedBullets ?? 0,
    vanillaBulletsSeen: window.__vanillaBullets ?? 0,
  }
}

/** Inject the inline world AND install the in-flight provenance sampler. */
const before = (world) => async (page) => {
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate((j) => {
    window.__seenModIds = new Set()
    window.__moddedBullets = 0
    window.__vanillaBullets = 0
    const seen = new Set()
    setInterval(() => {
      for (const e of window.__world?.entities ?? []) {
        if (e.kind !== 'projectile' || e.archetype !== 'projectile' || e.dead || seen.has(e.id)) continue
        seen.add(e.id)
        if (e.projectile?.mods?.length) {
          window.__moddedBullets++
          for (const m of e.projectile.mods) window.__seenModIds.add(m.id)
        } else {
          window.__vanillaBullets++
        }
      }
    }, 30)
    window.__loadWorld(j)
  }, world)
}

const runs = [
  {
    name: 'bullets-vanilla-control',
    mods: undefined,
    weapon: 'machinegun',
    // The control: bullets flew, and every one of them was UNMODDED gold —
    // exactly what enemy fire always looks like (never confusable).
    expect: (s) => [
      s.vanillaBulletsSeen < 5 && `only ${s.vanillaBulletsSeen} vanilla bullets seen`,
      s.moddedBulletsSeen !== 0 && 'vanilla run produced modded bullets',
      s.gameOver && 'unexpected game over',
    ],
  },
  {
    name: 'bullets-signature-cryo-lance',
    mods: [
      { id: 'frost', stacks: 1 },
      { id: 'pierce', stacks: 3 },
      { id: 'velocity', stacks: 2 },
    ],
    weapon: 'machinegun',
    // Ice-blue elongated darts with a cold trail, punching through the line.
    expect: (s) => [
      s.moddedBulletsSeen < 5 && `only ${s.moddedBulletsSeen} modded bullets seen`,
      JSON.stringify(s.seenMods) !== JSON.stringify(['frost', 'pierce', 'velocity']) &&
        `wrong provenance in flight: ${s.seenMods}`,
      s.thugsAlive === 3 && 'cryo lance hit nothing',
      s.gameOver && 'unexpected game over',
    ],
  },
  {
    name: 'bullets-monster-maxstack',
    mods: ALL_MODS.map((id) => ({ id, stacks: 5 })),
    weapon: 'machinegun',
    // Every mod at the cap: the chromatic, throbbing, arcing monster build.
    expect: (s) => [
      s.moddedBulletsSeen < 3 && `only ${s.moddedBulletsSeen} modded bullets seen`,
      s.seenMods.length !== ALL_MODS.length && `provenance lost mods: ${s.seenMods.length}/${ALL_MODS.length}`,
      s.thugsAlive === 3 && 'monster build hit nothing',
    ],
  },
]

let ok = true
for (const r of runs) {
  const world = armed(r.weapon, r.mods)
  const pass = await record({
    name: r.name,
    params: { mode: 'solo', e2e: '1', world: '@inline', script: 'shooting', zoom: 2 },
    stills,
    beforeTicks: before(world),
    readState,
    expect: (s) => r.expect(s).filter(Boolean),
  })
  ok = ok && pass
}
if (!ok) process.exitCode = 1
