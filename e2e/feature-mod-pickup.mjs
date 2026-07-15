// feat/mod-pickups — HEADLINE video: a player walks up to weapon-mod PICKUPS
// scattered in the world and grabs them, and the equipped gun gains the mods
// (hotbar badge + inspect card update). Exact world state (combat-stage re-armed
// with a slotted pistol + two lane gems) + the real systems via the `modGrab`
// scripted timeline, then a still per beat and an asserted mp4.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

// combat-stage, but: player armed with a SLOTTED pistol (so the mod has a mod-list
// to land on), the thug crowd cleared to a calm plaza, and two mod-gems on the lane
// at x≈5.5 (Cryo Rounds) and x≈8.5 (Overload) right where `modGrab` walks.
const world = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = 'pistol'
  p.playerCtl.inventory = [{ itemId: 'pistol', qty: 99 }]
  p.playerCtl.activeSlot = 0
  w.entities = w.entities.filter((e) => e.archetype !== 'thug')
  let id = w.nextId
  const gem = (modId, x) => {
    w.entities.push({
      id: id++, kind: 'pickup', archetype: `mod.${modId}`,
      pos: { x, y: 11.5 }, prevPos: { x, y: 11.5 }, vel: { x: 0, y: 0 }, intent: { x: 0, y: 0 },
      speed: 0, radius: 0.3, facing: 0, pickup: { itemId: modId, qty: 1 },
    })
  }
  gem('frost', 5.5)
  gem('overload', 8.5)
  w.nextId = id
  return w
}

const stills = [
  { tick: 20, label: '01-injected' },
  { tick: 130, label: '02-on-the-lane' },
  { tick: 165, label: '03-approaching-gem' },
  { tick: 200, label: '04-first-mod-grabbed' },
  { tick: 300, label: '05-twice-modded-gun' },
]

const readState = () => {
  const w = window.__world
  const p = w.entities.find((e) => e.playerCtl)
  const slot = p?.playerCtl?.inventory?.[p.playerCtl.activeSlot]
  const gems = w.entities.filter((e) => !e.dead && String(e.archetype).startsWith('mod.')).length
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    weapon: p?.combat?.weapon ?? null,
    mods: (slot?.mods ?? []).map((m) => `${m.id}×${m.stacks}`).sort(),
    gemsLeft: gems,
    playerHp: p?.health?.hp ?? null,
  }
}

const ok = await recordFeature({
  name: 'feature-mod-pickup',
  world: world(),
  script: 'modGrab',
  stills,
  readState,
  // Adversarial post-run asserts: both gems consumed, both mods now ride the pistol.
  expect: (s) => [
    s.gameOver && 'unexpected game over',
    s.weapon !== 'pistol' && `weapon changed: ${s.weapon}`,
    s.gemsLeft !== 0 && `gems not all grabbed: ${s.gemsLeft} left`,
    !s.mods.includes('frost×1') && `frost not applied (mods: ${s.mods.join(',')})`,
    !s.mods.includes('overload×1') && `overload not applied (mods: ${s.mods.join(',')})`,
  ],
})
if (!ok) process.exitCode = 1
