/**
 * Visual proof for feat/splinter-and-combinatorial-fx. Renders TWO things to a
 * single self-contained SVG, both from the REAL code (no mock-ups):
 *
 *  (a) Combinatorial bullet FX — swatches drawn straight from `composeBulletTraits`
 *      (the actual render grammar). Single mods next to their STACKED combos, so
 *      you can see the core tint is a genuine weighted blend of each mod's canonical
 *      pickup colour (modColors), glow/trail/flecks layering rather than last-wins.
 *
 *  (b) Splinter shatter — drives the ACTUAL sim (createWorld → fire a splinterShot
 *      round → projectileSystem) and plots the parent's path plus every deterministic
 *      fragment's spawn point and velocity vector. Same seed ⇒ same picture.
 *
 * Run: pnpm exec tsx scripts/test/splinter-visual-proof.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { composeBulletTraits, type BulletTraits } from '../../src/render/bulletVisuals'
import type { WeaponMod } from '../../src/game/entity'
import { makeEntity, type Entity } from '../../src/game/entity'
import { emptyInput } from '../../src/game/types'
import { createWorld, addEntity, type World } from '../../src/game/world'
import { spawnPlayer } from '../../src/game/player'
import { combatSystem } from '../../src/game/systems/combat'
import { projectileSystem } from '../../src/game/systems/projectiles'
import { equipSlot } from '../../src/game/systems/inventory'

const hexColor = (c: number): string => `#${(c >>> 0).toString(16).padStart(6, '0')}`
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

// ---- (a) combinatorial swatches ------------------------------------------
const BUILDS: { label: string; mods: WeaponMod[] }[] = [
  { label: 'vanilla', mods: [] },
  { label: 'frost', mods: [{ id: 'frost', stacks: 1 }] },
  { label: 'incendiary', mods: [{ id: 'incendiary', stacks: 1 }] },
  { label: 'frost + incendiary', mods: [{ id: 'frost', stacks: 1 }, { id: 'incendiary', stacks: 1 }] },
  { label: 'frost + incendiary + shock', mods: [{ id: 'frost', stacks: 1 }, { id: 'incendiary', stacks: 1 }, { id: 'shock', stacks: 1 }] },
  { label: 'splinterShot', mods: [{ id: 'splinterShot', stacks: 2 }] },
  { label: 'splinterShot + frost + overload', mods: [{ id: 'splinterShot', stacks: 2 }, { id: 'frost', stacks: 1 }, { id: 'overload', stacks: 3 }] },
  { label: 'glassCannon + explosive + homing', mods: [{ id: 'glassCannon', stacks: 2 }, { id: 'explosive', stacks: 2 }, { id: 'homing', stacks: 2 }] },
]

const swatch = (x: number, y: number, w: number, t: BulletTraits, label: string): string => {
  const cx = x + w / 2
  const cy = y + 46
  const rad = 10 * t.size
  const len = rad * t.length
  const parts: string[] = []
  // trail ghosts behind the round
  for (let i = t.trail; i >= 1; i--) {
    const gx = cx - (i + 1) * (6 + len * 0.25)
    parts.push(`<ellipse cx="${gx.toFixed(1)}" cy="${cy}" rx="${(len * 0.7).toFixed(1)}" ry="${(rad * 0.55).toFixed(1)}" fill="${hexColor(t.trailColor)}" opacity="${(0.12 * i).toFixed(2)}"/>`)
  }
  // glow halo
  if (t.glow > 0) parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${(len + 10 * t.glow).toFixed(1)}" ry="${(rad + 10 * t.glow).toFixed(1)}" fill="${hexColor(t.glowColor)}" opacity="${(0.5 * t.glow).toFixed(2)}"/>`)
  // core (elongated along heading)
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${len.toFixed(1)}" ry="${rad.toFixed(1)}" fill="${hexColor(t.color)}"/>`)
  // orbiting shard flecks (splinter tell)
  if (t.flecks > 0) {
    const n = Math.round(3 + t.flecks * 5)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const fx = cx + Math.cos(a) * (len + 6)
      const fy = cy + Math.sin(a) * (rad + 6)
      parts.push(`<rect x="${(fx - 1.6).toFixed(1)}" y="${(fy - 1.6).toFixed(1)}" width="3.2" height="3.2" transform="rotate(45 ${fx.toFixed(1)} ${fy.toFixed(1)})" fill="${hexColor(t.color)}" opacity="0.9"/>`)
    }
  }
  const meta = `size ${t.size.toFixed(2)} · len ${t.length.toFixed(2)} · glow ${t.glow.toFixed(2)} · trail ${t.trail} · flecks ${t.flecks.toFixed(2)} · chroma ${t.chroma.toFixed(2)} · distort ${t.distort.toFixed(2)}`
  return `
    <g>
      <text x="${cx}" y="${y + 14}" text-anchor="middle" fill="#e8e8f0" font-size="13" font-weight="600">${esc(label)}</text>
      <text x="${cx}" y="${y + 92}" text-anchor="middle" fill="#8890a8" font-size="9">${esc(hexColor(t.color))}</text>
      ${parts.join('\n      ')}
      <text x="${cx}" y="${y + 108}" text-anchor="middle" fill="#6b7290" font-size="7.5">${esc(meta)}</text>
    </g>`
}

// ---- (b) real-sim splinter scatter ---------------------------------------
const armed = (w: World, x: number, y: number, mods: WeaponMod[]): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.playerCtl!.inventory = [{ itemId: 'pistol', qty: 99, mods }]
  equipSlot(p, 0)
  p.facing = 0
  return p
}

const runSplinter = (): { path: { x: number; y: number }[]; frags: { x: number; y: number; vx: number; vy: number }[]; origin: { x: number; y: number } } => {
  const w = createWorld(7, 1)
  const p = armed(w, 20, 20, [{ id: 'splinterShot', stacks: 3 }])
  const t = addEntity(w, makeEntity('npc', 'civilian', 24, 20))
  t.health = { hp: 40, max: 40, iframes: 0 }
  t.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[p.playerCtl!.playerId, { ...emptyInput(), attack: true }]]))
  const parent = w.entities.find((e) => e.kind === 'projectile')!
  const path: { x: number; y: number }[] = []
  let frags: { x: number; y: number; vx: number; vy: number }[] = []
  for (let i = 0; i < 30; i++) {
    if (!parent.dead) path.push({ x: parent.pos.x, y: parent.pos.y })
    const before = new Set(w.entities.filter((e) => e.kind === 'projectile').map((e) => e.id))
    projectileSystem(w)
    w.tick++
    const born = w.entities.filter((e) => e.kind === 'projectile' && !before.has(e.id))
    if (born.length) {
      frags = born.map((e) => ({ x: e.pos.x - e.vel.x / 30, y: e.pos.y - e.vel.y / 30, vx: e.vel.x, vy: e.vel.y }))
      break
    }
  }
  return { path, frags, origin: { x: 20, y: 20 } }
}

// ---- compose the SVG ------------------------------------------------------
const W = 1180
const swatchW = 280
const rows = Math.ceil(BUILDS.length / 4)
const swatchesSvg = BUILDS.map((b, i) => {
  const col = i % 4
  const row = Math.floor(i / 4)
  return swatch(20 + col * swatchW, 60 + row * 130, swatchW - 20, composeBulletTraits(b.mods), b.label)
}).join('\n')

const sim = runSplinter()
// map sim tiles → svg coords for the scatter panel
const panelY = 60 + rows * 130 + 60
const scale = 26
const ox = 120
const oy = panelY + 150
const toSvg = (x: number, y: number): [number, number] => [ox + (x - 20) * scale, oy + (y - 20) * scale]
const scatterParts: string[] = []
const [px0, py0] = toSvg(sim.origin.x, sim.origin.y)
scatterParts.push(`<circle cx="${px0}" cy="${py0}" r="5" fill="#6b7290"/><text x="${px0}" y="${py0 - 10}" text-anchor="middle" fill="#8890a8" font-size="9">muzzle</text>`)
for (const pt of sim.path) {
  const [sx, sy] = toSvg(pt.x, pt.y)
  scatterParts.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2" fill="#ffd8b1" opacity="0.5"/>`)
}
const shatter = sim.frags.length ? toSvg(sim.frags[0].x, sim.frags[0].y) : [0, 0]
scatterParts.push(`<circle cx="${shatter[0].toFixed(1)}" cy="${shatter[1].toFixed(1)}" r="7" fill="none" stroke="#ff5fa2" stroke-width="1.5" opacity="0.7"/>`)
for (const f of sim.frags) {
  const [fx, fy] = toSvg(f.x, f.y)
  const [ex, ey] = toSvg(f.x + f.vx * 0.18, f.y + f.vy * 0.18)
  scatterParts.push(`<line x1="${fx.toFixed(1)}" y1="${fy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#ff5fa2" stroke-width="2" opacity="0.85"/>`)
  scatterParts.push(`<rect x="${(ex - 2).toFixed(1)}" y="${(ey - 2).toFixed(1)}" width="4" height="4" transform="rotate(45 ${ex.toFixed(1)} ${ey.toFixed(1)})" fill="#ff9ec9"/>`)
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${panelY + 340}" viewBox="0 0 ${W} ${panelY + 340}" font-family="ui-sans-serif, system-ui, sans-serif">
  <rect width="100%" height="100%" fill="#12141c"/>
  <text x="20" y="34" fill="#f0f2ff" font-size="18" font-weight="700">Combinatorial bullet FX — composeBulletTraits() blends each mod's pickup colour</text>
  ${swatchesSvg}
  <line x1="20" y1="${panelY - 26}" x2="${W - 20}" y2="${panelY - 26}" stroke="#2a2e3c"/>
  <text x="20" y="${panelY - 2}" fill="#f0f2ff" font-size="18" font-weight="700">Splinter shot — real sim: ${sim.frags.length} fragments scatter radially on impact (seed 7, deterministic)</text>
  ${scatterParts.join('\n  ')}
  <text x="${ox}" y="${oy + 200}" fill="#8890a8" font-size="11">muzzle → parent round travels +x → strikes the target → shatters into a radial shrapnel ring (pink vectors = fragment headings)</text>
</svg>`

mkdirSync('docs/assets', { recursive: true })
const path = 'docs/assets/splinter-and-combinatorial-fx.svg'
writeFileSync(path, svg)
console.log(`wrote ${path} — ${BUILDS.length} FX swatches + ${sim.frags.length} sim fragments`)
