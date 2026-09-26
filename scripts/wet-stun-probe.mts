// Prints the wet stun-lock probe table (src/debug/wetStunProbe.ts): one NPC
// stun gunner against players on a dry or flooded street, over #122's 8 seeds.
//
//   npx tsx scripts/wet-stun-probe.mts
import { PROBE_SEEDS, probeTable, STUN_GUNNER_DIST, STUN_PROBE_TICKS } from '../src/debug/wetStunProbe'
import { SIM_RATE } from '../src/game/types'

const each = <T>(xs: T[], f: (x: T) => string): string => xs.map(f).join(' / ')
const rows = probeTable()
console.log(`Stun gunner ${STUN_GUNNER_DIST} tiles off, ${STUN_PROBE_TICKS / SIM_RATE} s, seeds ${PROBE_SEEDS.join(', ')}. Per-player cells read P1 / P2.\n`)
console.log('| ground | policy | players | gunner killed | downed | median time to down (s) | dmg/s | dmg taken while locked | arc hits (while locked) | time locked | longest lock (s) |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(
    `| ${r.ground} | ${r.policy} | ${r.team} | ${r.gunnerDowned}/${PROBE_SEEDS.length} | ${each(r.downed, (d) => `${d}/${PROBE_SEEDS.length}`)} | ${each(r.medianDownS, (m) => (m === undefined ? 'n/a' : m.toFixed(1)))} | ${each(r.dps, (d) => d.toFixed(1))} | ${each(r.lockedDamageShare, (s) => `${Math.round(s * 100)}%`)} | ${each(r.arcHits, String)} (${each(r.lockedArcHits, String)}) | ${each(r.lockedShare, (s) => `${Math.round(s * 100)}%`)} | ${each(r.longestLockS, (s) => s.toFixed(1))} |`,
  )
}
