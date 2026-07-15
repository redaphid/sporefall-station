// Playtest fix #1 HEADLINE video: the class STARTER weapon is now a real slotted
// ItemStack (a 40-round pistol that can hold mods), so a default player walks over
// a weapon-mod gem and the gun actually gains the mod — then fires the modded
// (frost) rounds into the thug line, freezing then shattering them. Proves the
// "walk over a diamond, nothing happens" bug is fixed end-to-end.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

// combat-stage, but the player carries EXACTLY what spawnPlayer now produces: a
// slotted, equipped pistol loaded with 40 rounds (STARTER_AMMO). A frost gem sits
// on the lane at x≈5.5 where `modFrostFire` walks; the thug line stays as targets.
const world = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = 'pistol'
  p.playerCtl.inventory = [{ itemId: 'pistol', qty: 40 }] // the new slotted starter
  p.playerCtl.activeSlot = 0
  let id = w.nextId
  w.entities.push({
    id: id++, kind: 'pickup', archetype: 'mod.frost',
    pos: { x: 5.5, y: 11.5 }, prevPos: { x: 5.5, y: 11.5 }, vel: { x: 0, y: 0 }, intent: { x: 0, y: 0 },
    speed: 0, radius: 0.3, facing: 0, pickup: { itemId: 'frost', qty: 1 },
  })
  w.nextId = id
  return w
}

const stills = [
  { tick: 20, label: '01-spawn-slotted-pistol' },
  { tick: 120, label: '02-on-the-lane' },
  { tick: 150, label: '03-frost-gem-grabbed' },
  { tick: 240, label: '04-firing-frozen-rounds' },
  { tick: 300, label: '05-shattered-line' },
]

const readState = () => {
  const w = window.__world
  const p = w.entities.find((e) => e.playerCtl)
  const slot = p?.playerCtl?.inventory?.[p.playerCtl.activeSlot]
  const gems = w.entities.filter((e) => !e.dead && String(e.archetype).startsWith('mod.')).length
  const frozen = w.entities.filter((e) => e.fx && e.fx.frozen).length
  const thugsAlive = w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    weapon: p?.combat?.weapon ?? null,
    ammo: slot?.qty ?? null,
    mods: (slot?.mods ?? []).map((m) => `${m.id}×${m.stacks}`).sort(),
    gemsLeft: gems,
    frozenNow: frozen,
    thugsAlive,
    playerHp: p?.health?.hp ?? null,
  }
}

const ok = await recordFeature({
  name: 'feature-starter-mod-fire',
  world: world(),
  script: 'modFrostFire',
  stills,
  readState,
  expect: (s) => [
    s.gameOver && 'unexpected game over',
    s.weapon !== 'pistol' && `weapon changed: ${s.weapon}`,
    s.gemsLeft !== 0 && `frost gem not grabbed: ${s.gemsLeft} left`,
    !s.mods.includes('frost×1') && `frost not applied to the starter (mods: ${s.mods.join(',')})`,
    s.ammo === 40 && 'pistol never fired (still 40 rounds) — finite ammo not spent',
    s.thugsAlive === 3 && 'no thug was killed by the frozen rounds',
  ],
})
if (!ok) process.exitCode = 1
