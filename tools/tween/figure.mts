/**
 * Renders the tween behaviour to a PNG so it can be judged by eye, not only by
 * metric. Three panels, all for the SAME scenario: a remote player walking in a
 * straight line at a CONSTANT 4.5 tiles/s, 10 Hz snapshots, one snapshot dropped.
 *
 *   A. Drawn speed over time      — true speed is a flat line; what is drawn is not.
 *   B. Strobe                     — one dot per rendered frame at 60 fps. Even
 *                                   spacing is smooth motion; bunching and gaps
 *                                   are the stutter, exactly as the eye sees it.
 *   C. Lag over time              — how far behind the truth the sprite is drawn.
 */
import { run, constantWalk, SIM_RATE, type Strategy } from './model.mts'
import { writeFileSync } from 'node:fs'

const SPEED = 4.5
const TICKS = 75
const DROP = [12] // snapshot #12 is lost -> a 200 ms gap, the common case

interface Variant { name: string; sub: string; colour: string; strategy: Strategy }
const VARIANTS: Variant[] = [
  { name: 'TODAY', sub: 'ease 0.45 / tick toward last position', colour: '#e5484d', strategy: { kind: 'current' } },
  { name: 'INTERPOLATE', sub: 'render 200 ms behind, between two known states', colour: '#0090ff', strategy: { kind: 'interp', delayMs: 200 } },
  { name: 'VELOCITY-MATCHED', sub: 'infer velocity from 2 snapshots, cap 150 ms', colour: '#30a46c', strategy: { kind: 'hybrid', capMs: 150, smooth: 0.3 } },
]

const series = VARIANTS.map((v) => ({
  v,
  s: run({ ticks: TICKS, traj: constantWalk(SPEED), snapLoss: 0, seed: 1, strategy: v.strategy, latencyMs: 25, forcedDrops: DROP }).samples,
}))

/** Rendered frames at 60 fps: the renderer draws prevPos + (pos-prevPos)*alpha,
 * so each sim tick contributes 2 frames (alpha 0 and 0.5). */
const frames = (s: { renderX: number }[]): number[] => {
  const out: number[] = []
  for (let i = 1; i < s.length; i++) {
    out.push(s[i - 1].renderX)
    out.push(s[i - 1].renderX + (s[i].renderX - s[i - 1].renderX) * 0.5)
  }
  return out
}

const W = 1280
const PAD = 70
const T0 = 20 // skip warm-up
const x = (t: number) => PAD + ((t - T0) / (TICKS - T0)) * (W - PAD * 2)

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="1180" font-family="Segoe UI, Arial, sans-serif">
<rect width="100%" height="100%" fill="#0f1115"/>
<text x="${PAD}" y="44" fill="#fff" font-size="26" font-weight="700">A remote player walking at a constant 4.5 tiles/s</text>
<text x="${PAD}" y="72" fill="#9aa4b2" font-size="16">30 Hz sim, 10 Hz snapshots, 25 ms link. One snapshot dropped at the marked tick (a 200 ms gap) — everything else delivered perfectly.</text>`

// ---------------------------------------------------------------- A. speed
const AY = 110
const AH = 300
const smax = 14
const sy = (v: number) => AY + AH - (v / smax) * AH
svg += `<text x="${PAD}" y="${AY - 10}" fill="#fff" font-size="18" font-weight="600">A. Speed the sprite is DRAWN at (tiles/s). The player's real speed never changes.</text>`
svg += `<rect x="${PAD}" y="${AY}" width="${W - PAD * 2}" height="${AH}" fill="#161a21" stroke="#2a3039"/>`
for (let g = 0; g <= smax; g += 2) {
  svg += `<line x1="${PAD}" y1="${sy(g)}" x2="${W - PAD}" y2="${sy(g)}" stroke="#232932"/>`
  svg += `<text x="${PAD - 10}" y="${sy(g) + 5}" fill="#6b7280" font-size="13" text-anchor="end">${g}</text>`
}
// snapshot arrival ticks
for (let t = T0; t <= TICKS; t++) {
  if (t % 3 === 0) {
    const idx = t / 3
    const lost = DROP.includes(idx)
    svg += `<line x1="${x(t)}" y1="${AY}" x2="${x(t)}" y2="${AY + AH}" stroke="${lost ? '#e5484d' : '#2f3742'}" stroke-width="${lost ? 2 : 1}" stroke-dasharray="${lost ? '5,3' : ''}"/>`
    if (lost) svg += `<text x="${x(t)}" y="${AY - 26}" fill="#e5484d" font-size="14" font-weight="700" text-anchor="middle">snapshot DROPPED</text>`
  }
}
svg += `<line x1="${PAD}" y1="${sy(SPEED)}" x2="${W - PAD}" y2="${sy(SPEED)}" stroke="#fff" stroke-width="2" stroke-dasharray="6,4"/>`
svg += `<text x="${W - PAD + 6}" y="${sy(SPEED) + 5}" fill="#fff" font-size="13">truth 4.5</text>`
for (const { v, s } of series) {
  const pts = s.filter((p) => p.tick >= T0).map((p) => `${x(p.tick)},${sy(Math.min(smax, p.speed))}`).join(' ')
  svg += `<polyline points="${pts}" fill="none" stroke="${v.colour}" stroke-width="2.5"/>`
}
let ly = AY + 22
for (const { v } of series) {
  svg += `<rect x="${W - PAD - 300}" y="${ly - 11}" width="26" height="4" fill="${v.colour}"/><text x="${W - PAD - 266}" y="${ly - 3}" fill="#c7cdd6" font-size="14">${v.name}</text>`
  ly += 24
}

// ---------------------------------------------------------------- B. strobe
let BY = AH + 190
svg += `<text x="${PAD}" y="${BY - 14}" fill="#fff" font-size="18" font-weight="600">B. Where the sprite is actually DRAWN — one dot per rendered frame at 60 fps.</text>`
svg += `<text x="${PAD}" y="${BY + 6}" fill="#9aa4b2" font-size="15">Evenly spaced dots = smooth motion. Dots bunching up then leaving a gap = the stutter, exactly as the eye receives it.</text>`
BY += 34
const allF = frames(series[0].s)
const fx0 = allF[Math.floor((T0 / TICKS) * allF.length)]
const fx1 = allF[allF.length - 1]
const px = (v: number) => PAD + ((v - fx0) / (fx1 - fx0)) * (W - PAD * 2)
const truthFrames: number[] = []
for (let i = 1; i < TICKS; i++) {
  truthFrames.push(((i - 1) * SPEED) / SIM_RATE)
  truthFrames.push(((i - 0.5) * SPEED) / SIM_RATE)
}
const rows: { label: string; sub: string; colour: string; f: number[] }[] = [
  { label: 'TRUTH', sub: 'what the host actually did', colour: '#ffffff', f: truthFrames },
  ...series.map(({ v, s }) => ({ label: v.name, sub: v.sub, colour: v.colour, f: frames(s) })),
]
let ry = BY
for (const r of rows) {
  svg += `<text x="${PAD}" y="${ry + 4}" fill="${r.colour}" font-size="15" font-weight="700">${r.label}</text>`
  svg += `<text x="${PAD}" y="${ry + 22}" fill="#6b7280" font-size="12.5">${r.sub}</text>`
  svg += `<line x1="${PAD + 210}" y1="${ry + 12}" x2="${W - PAD}" y2="${ry + 12}" stroke="#232932"/>`
  const start = Math.floor((T0 / TICKS) * r.f.length)
  for (let i = start; i < r.f.length; i++) {
    const cx = PAD + 210 + ((r.f[i] - fx0) / (fx1 - fx0)) * (W - PAD - (PAD + 210))
    if (cx < PAD + 205 || cx > W - PAD + 2) continue
    svg += `<circle cx="${cx.toFixed(1)}" cy="${ry + 12}" r="4" fill="${r.colour}" opacity="0.42"/>`
  }
  ry += 62
}

// ---------------------------------------------------------------- C. lag
const CY = ry + 46
const CH = 210
const lmax = 1.6
const ly2 = (v: number) => CY + CH - (Math.max(0, v) / lmax) * CH
svg += `<text x="${PAD}" y="${CY - 12}" fill="#fff" font-size="18" font-weight="600">C. How far BEHIND the truth the sprite is drawn (tiles). Lower is more responsive.</text>`
svg += `<rect x="${PAD}" y="${CY}" width="${W - PAD * 2}" height="${CH}" fill="#161a21" stroke="#2a3039"/>`
for (let g = 0; g <= 1.5; g += 0.5) {
  svg += `<line x1="${PAD}" y1="${ly2(g)}" x2="${W - PAD}" y2="${ly2(g)}" stroke="#232932"/>`
  svg += `<text x="${PAD - 10}" y="${ly2(g) + 5}" fill="#6b7280" font-size="13" text-anchor="end">${g.toFixed(1)}</text>`
}
for (const { v, s } of series) {
  const pts = s.filter((p) => p.tick >= T0).map((p) => `${x(p.tick)},${ly2(Math.min(lmax, -p.err))}`).join(' ')
  svg += `<polyline points="${pts}" fill="none" stroke="${v.colour}" stroke-width="2.5"/>`
}
svg += `<text x="${PAD}" y="${CY + CH + 34}" fill="#9aa4b2" font-size="14">TODAY already renders ~0.5 tiles (=110 ms) behind. A 200 ms interpolation buffer costs ~0.65 tiles MORE; velocity-matching costs LESS than today.</text>`
svg += `</svg>`

writeFileSync('tools/tween/figure.svg', svg)
console.log('wrote tools/tween/figure.svg')

const png = async () => {
  const { chromium } = await import('playwright')
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: W, height: 1180 }, deviceScaleFactor: 2 })
  await p.setContent(`<body style="margin:0">${svg}</body>`)
  await p.screenshot({ path: 'docs/assets/tweening-dropped-states.png' })
  await b.close()
  console.log('wrote docs/assets/tweening-dropped-states.png')
}
void png()
