// throwaway probe — why so few shots?
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld, spawnNpc } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { isSolidTile } from '../../src/game/levelgen/level'
import { hasLineOfSight } from '../../src/game/los'
import type { InputCmd } from '../../src/game/types'

const NEUTRAL: InputCmd = {
  seq: 0, moveX: 0, moveY: 0, attack: false, interact: false,
  special: false, aimX: 1, aimY: 0, hotbar: -1, throwItem: false, roll: false,
}
const COHORT = ['thug', 'thug', 'thug', 'gangster', 'sporeling', 'sporeling']
const seed = Number(process.argv[2] ?? 42)
const w = createWorld(seed, 1)
populateWorld(w)
setupFloor(w)
const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
const clearance = (tx: number, ty: number): number => {
  for (let r = 1; r <= 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        if (isSolidTile(w.level, tx + dx, ty + dy)) return r - 1
      }
  return 8
}
let best = { x: w.level.spawn.x, y: w.level.spawn.y }; let bestR = -1
for (let ty = 1; ty < w.level.h - 1; ty++) for (let tx = 1; tx < w.level.w - 1; tx++) {
  if (isSolidTile(w.level, tx, ty)) continue
  const r = clearance(tx, ty); if (r > bestR) { bestR = r; best = { x: tx + 0.5, y: ty + 0.5 } }
}
for (const e of w.entities) if (e.kind === 'npc' || e.kind === 'pickup') e.dead = true
w.entities = w.entities.filter((e) => !e.dead || e.kind === 'player')
w.byId.clear(); for (const e of w.entities) w.byId.set(e.id, e)
p.pos.x = best.x; p.pos.y = best.y
const ids: number[] = []
for (let i = 0; i < COHORT.length; i++) {
  const a = (Math.PI * 2 * i) / COHORT.length
  const n = spawnNpc(w, COHORT[i], best.x + Math.cos(a) * 5, best.y + Math.sin(a) * 5)
  if (n.dormant) n.dormant = false
  if (n.ai) n.ai.mode = 'aggro'
  ids.push(n.id)
}
console.log('centre', best, 'clearance', bestR, 'cohortHP', ids.map((i) => w.byId.get(i)!.health?.hp).join('+'))
let firedTicks = 0, losTicks = 0, inRangeTicks = 0, noTargetTicks = 0, shots = 0, hits = 0
const seen = new Set<number>()
const pid = p.id
for (let t = 0; t < 1800; t++) {
  for (const id of ids) { const e = w.byId.get(id); if (e && !e.dead && e.ai) { e.ai.mode = 'aggro'; e.ai.targetId = pid } }
  const cmd: InputCmd = { ...NEUTRAL }
  let tgt: any = null, bd = Infinity, anyAlive = 0, nearestAny = Infinity
  for (const e of w.entities) {
    if (e.kind !== 'npc' || e.dead) continue
    anyAlive++
    const d = Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y)
    if (d < nearestAny) nearestAny = d
    if (!hasLineOfSight(w.level, p.pos.x, p.pos.y, e.pos.x, e.pos.y)) continue
    if (d < bd) { bd = d; tgt = e }
  }
  if (anyAlive === 0) { console.log(`ALL DEAD at t=${t}`); break }
  if (!tgt) noTargetTicks++
  else {
    losTicks++
    if (bd <= 9) inRangeTicks++
    const ax = tgt.pos.x - p.pos.x, ay = tgt.pos.y - p.pos.y, al = Math.hypot(ax, ay) || 1
    cmd.aimX = ax / al; cmd.aimY = ay / al
    cmd.attack = bd <= 9
    if (cmd.attack) firedTicks++
    if (bd < 3) { cmd.moveX = -ax / al; cmd.moveY = -ay / al }
    else if (bd > 6) { cmd.moveX = ax / al; cmd.moveY = ay / al }
  }
  tickWorld(w, new Map([[0, cmd]]))
  for (const e of w.entities) if (e.kind === 'projectile' && !e.dead && e.projectile?.ownerId === pid && !seen.has(e.id)) { seen.add(e.id); shots++ }
  for (const ev of w.events) if (ev.type === 'hit' && w.byId.get(ev.targetId)?.kind === 'npc') hits++
  if (t % 200 === 0) console.log(`t=${t} alive=${anyAlive} nearest=${nearestAny.toFixed(1)} losD=${bd === Infinity ? '-' : bd.toFixed(1)} shots=${shots} hits=${hits} cd=${(p as any).combat?.cooldownUntil ?? '-'}`)
}
console.log({ firedTicks, losTicks, inRangeTicks, noTargetTicks, shots, hits })
console.log('combat', JSON.stringify((p as any).combat))
