// Play a crafted scene with the scripted bot and print how it goes, to tune a
// save before pinning it in src/scenes/scenes.test.ts.
//
// Run: pnpm exec tsx scripts/test/scene-tune.mts <name> [ticks] [x,y;x,y;…] [idle]
//   idle: the player stands still and never fires (does the scene play itself?)
//   FOCUS=<archetype> shoots that archetype first whenever it is in sight.
//   USE=<archetype> presses use beside that archetype (a generator).
//   SPARE=<a,b> never shoots those archetypes.

import { readFileSync } from 'node:fs'
import { tickWorld } from '../../src/game/world'
import { deserializeWorld, type WorldJson } from '../../src/game/serialize'
import { makeBot } from '../../src/scenes/bot'
import { emptyInput } from '../../src/game/types'

const [name, ticksArg, goalArg, idleArg] = process.argv.slice(2)
const json = JSON.parse(readFileSync(`src/game/__fixtures__/${name}.json`, 'utf8')) as WorldJson
const w = deserializeWorld(json)
const ticks = Number(ticksArg ?? 900)
const route = goalArg && goalArg !== '-' ? goalArg.split(';').map((p) => ({ x: Number(p.split(',')[0]), y: Number(p.split(',')[1]) })) : []
const idle = idleArg === 'idle'
const counts = new Map<string, number>()
const focus = w.entities.filter((e) => e.archetype === process.env.FOCUS).map((e) => e.id)
const use = w.entities.filter((e) => (process.env.USE ?? '').split(',').includes(e.archetype)).map((e) => e.id)
const spare = (process.env.SPARE ?? '').split(',')
const bot = makeBot({ route, focus, use, spare })
const startFloor = w.floor
for (let t = 0; t < ticks; t++) {
  tickWorld(w, new Map([[0, idle ? emptyInput() : bot(w)]]))
  for (const e of w.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  if ((t + 1) % 150 === 0 || w.floor !== startFloor) {
    const p = w.entities.find((e) => e.playerCtl)
    const npcs = w.entities.filter((e) => e.kind === 'npc' && !e.dead)
    const byArch = new Map<string, number>()
    for (const e of npcs) byArch.set(e.archetype, (byArch.get(e.archetype) ?? 0) + 1)
    console.log(
      `t=${w.tick} floor=${w.floor} hp=${p?.health?.hp} dead=${!!p?.dead} downed=${!!p?.playerCtl?.downed} pos=${p?.pos.x.toFixed(1)},${p?.pos.y.toFixed(1)} alarm=${w.alarm} over=${w.gameOver}`,
      `npcs=${[...byArch].map(([a, n]) => `${a}:${n}`).join(' ')}`,
      `fires=${w.entities.filter((e) => e.kind === 'fire' && !e.spore && !e.dead).length} spore=${w.entities.filter((e) => e.spore && !e.dead).length}`,
    )
    if (w.floor !== startFloor) break
  }
}
console.log([...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '))
