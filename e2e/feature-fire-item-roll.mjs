// FIRE/USE arbitration headline (feat/fire-use-roll): FIRE uses a usable active
// item or fires the weapon; the dodge-roll fallback lives on the USE button.
//   • fire-uses-item : a wounded player holding a bandage presses FIRE → the
//                      bandage is USED (heals) and spent; NO bullet is fired.
//   • use-rolls      : hands hold nothing usable (an empty gun), so pressing USE
//                      dodge-rolls through an inbound bullet — hp UNCHANGED.
// Both effects are asserted on the post-run world. Built on the committed
// `combat-stage` snapshot (thugs cleared) + the `?world=@inline` boot path.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const clearedStage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 6, y: 11 }
  p.prevPos = { x: 6, y: 11 }
  p.facing = 0
  w.entities = [p] // just the player on the open lane
  return { w, p }
}

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    playerHp: pl?.health?.hp ?? null,
    playerMax: pl?.health?.max ?? null,
    rolling: !!pl?.playerCtl?.roll,
    downed: !!pl?.playerCtl?.downed,
    bullets: w.entities.filter((e) => e.kind === 'projectile' && e.archetype === 'projectile' && !e.dead).length,
    hasBandage: (pl?.playerCtl?.inventory ?? []).some((s) => s.itemId === 'bandage'),
  }
}

let ok = true

// 1) Fire a bandage → heal, no shot. Wounded (hp 40/120), bandage active.
{
  const { w, p } = clearedStage()
  p.health = { hp: 40, max: p.health.max, iframes: 0 }
  p.playerCtl.inventory = [{ itemId: 'bandage', qty: 1 }]
  p.playerCtl.activeSlot = 0
  ok =
    (await recordFeature({
      name: 'fire-uses-item',
      world: w,
      script: 'fireUseItem',
      stills: [
        { tick: 10, label: '01-wounded-bandage-in-hand' },
        { tick: 25, label: '02-fired-bandage-healed' },
        { tick: 55, label: '03-standing-healed' },
      ],
      readState,
      expect: (s) => [
        s.playerHp <= 40 && `bandage did not heal (hp ${s.playerHp}/${s.playerMax})`,
        s.hasBandage && 'bandage was not consumed',
        s.bullets > 0 && `a bullet was fired (${s.bullets}) — fire should have used the item`,
      ],
    })) && ok
}

// 2) Fire an empty gun → dodge-roll through the bullet. Full hp, pistol at 0 ammo.
{
  const { w, p } = clearedStage()
  p.health = { hp: p.health.max, max: p.health.max, iframes: 0 }
  p.playerCtl.inventory = [{ itemId: 'pistol', qty: 0 }] // empty mag
  p.playerCtl.activeSlot = 0
  const bullet = {
    id: w.nextId,
    kind: 'projectile',
    archetype: 'projectile',
    pos: { x: 14, y: 11 },
    prevPos: { x: 14, y: 11 },
    vel: { x: -11, y: 0 },
    intent: { x: 0, y: 0 },
    speed: 0,
    radius: 0.15,
    facing: Math.PI,
    projectile: { ownerId: 999, damage: 40, ttl: 90 },
  }
  w.nextId += 1
  w.entities.push(bullet)
  ok =
    (await recordFeature({
      name: 'use-rolls-when-nothing-usable',
      world: w,
      script: 'useFallbackRoll',
      stills: [
        { tick: 5, label: '01-empty-gun-bullet-inbound' },
        { tick: 17, label: '02-use-triggered-roll' },
        { tick: 24, label: '03-rolled-through' },
        { tick: 45, label: '04-unharmed' },
      ],
      readState,
      expect: (s) => [
        s.playerHp !== s.playerMax && `took damage — the use→roll fallback did not save it (hp ${s.playerHp}/${s.playerMax})`,
        s.downed && 'player went down',
        s.bullets > 0 && `a bullet was fired (${s.bullets}) — USE should only roll`,
      ],
    })) && ok
}

if (!ok) process.exitCode = 1
