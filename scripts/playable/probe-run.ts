// Run one playable headless with its demo bot and print the beats: deaths,
// hits, shots, hive buds, aggro flips, player hp. For tuning a scenario and
// picking its `shot.tick`.
//   node scripts/playable/probe.mjs <id> [ticks]
import { findPlayable } from '../../src/playable/registry'
import { buildPlayWorld } from '../../src/playable/start'
import { makeBot } from '../../src/scenes/bot'
import { tickWorld } from '../../src/game/world'

const id = process.env.PROBE_ID ?? ''
const n = Number(process.env.PROBE_TICKS ?? 300)
const p = findPlayable(id)
if (!p) throw new Error(`no playable ${id}`)
const w = buildPlayWorld(p.start)
const bot = makeBot(p.demo ?? { range: 0 })
const modes = new Map<number, string | undefined>()
for (let i = 0; i < n; i++) {
  const t = w.tick
  const cmd = bot(w)
  tickWorld(w, new Map([[0, cmd]]))
  const me = w.entities.find((e) => e.playerCtl)
  const out: string[] = []
  for (const ev of w.events) {
    if (['death', 'hit', 'explosion', 'hiveSpawn', 'hiveSpread', 'floorChange', 'packClose', 'woke', 'alerted'].includes(ev.type)) {
      const eid = 'entityId' in ev ? ev.entityId : 'targetId' in ev ? ev.targetId : undefined
      const e = eid !== undefined ? w.byId.get(eid as number) : undefined
      out.push(`${ev.type}${e ? `:${e.archetype}#${e.id}` : ''}${'amount' in ev ? ` ${(ev as { amount: number }).amount}` : ''}`)
    }
  }
  for (const e of w.entities) {
    if (!e.ai) continue
    const m = e.ai.mode
    if (modes.get(e.id) !== m) {
      if (modes.has(e.id)) out.push(`${e.archetype}#${e.id} ${modes.get(e.id)}->${m}`)
      modes.set(e.id, m)
    }
  }
  if (cmd.attack && i % 10 === 0) out.push('firing')
  if (cmd.throwItem) out.push('THROW')
  if (out.length) console.log(`t${t} hp${me?.health?.hp} @${me?.pos.x.toFixed(1)},${me?.pos.y.toFixed(1)}: ${out.join(' | ')}`)
}
const alive = w.entities.filter((e) => e.kind === 'npc' && !e.dead).map((e) => `${e.archetype}@${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)}`)
console.log(`end t${w.tick} alive: ${alive.join(' ')}`)
