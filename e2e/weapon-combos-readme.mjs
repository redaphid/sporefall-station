// Write a README.txt + a printable HTML contact sheet into the weapon-combos
// output dir, describing every mp4 that was actually produced. Run AFTER
// weapon-combos.mjs. Deterministic: it just reads the dir and a static blurb map.
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.E2E_OUT ?? join(process.env.HOME, 'Videos/backseat/weapon-combos')

// name → one-line description of what the clip demonstrates.
const BLURB = {
  'base-pistol': 'Plain pistol — baseline single-shot rounds into the dummy row.',
  'base-shotgun': 'Shotgun — a 5-pellet spread hits several dummies at once.',
  'base-machinegun': 'Machine gun — a rapid stream of bullets mows the row down.',
  'weapon-explosive': 'Explosive mod — each bullet bursts into an AoE blast on impact.',
  'weapon-pierce': 'Piercing mod — one bullet punches clean through the whole row.',
  'weapon-frost': 'Cryo Rounds — the hit freezes a target, and the next shot shatters the ice.',
  'weapon-incendiary': 'Incendiary — struck dummies catch fire and keep burning.',
  'weapon-splinter': 'Splinter Shot — the round shatters into a shrapnel burst where it lands.',
  'weapon-bounce': 'Bouncy — bullets ricochet off the walls.',
  'weapon-velocity': 'Hot Loads — bullets fly downrange noticeably faster.',
  'weapon-shock': 'Tesla Rounds — the hit zaps and stuns (arcs through anything wet).',
  'weapon-lifesteal': 'Vampiric — the player starts at 40 HP and heals back up off every hit.',
  'combo-pierce-explosive': 'Pierce + Explosive — the bullet passes through targets AND explodes.',
  'combo-frost-shock': 'Cryo + Tesla — freeze and electrify stacked on one shot.',
}

// Presentation order (base weapons, then single mods, then combos).
const ORDER = [
  'base-pistol', 'base-shotgun', 'base-machinegun',
  'weapon-explosive', 'weapon-pierce', 'weapon-frost', 'weapon-incendiary',
  'weapon-splinter', 'weapon-bounce', 'weapon-velocity', 'weapon-shock', 'weapon-lifesteal',
  'combo-pierce-explosive', 'combo-frost-shock',
]

const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.mp4')).map((f) => f.replace(/\.mp4$/, '')))
const rows = ORDER.filter((n) => present.has(n))

const kb = (n) => `${Math.round(statSync(join(dir, `${n}.mp4`)).size / 1024)} KB`

const lines = [
  'SPOREFALL STATION — WEAPON + AMMO/MOD SHOWCASE CLIPS',
  '===================================================',
  '',
  'Short (~10s; ~6s of firing plus a brief lead-in/aftermath) deterministic gameplay',
  'clips, one per weapon/ammo combo. In each, the player stands on the lane and',
  'fires the given loadout into a row of three',
  'stationary dummy targets so the on-hit effect is plainly visible. An on-screen',
  'title (bottom-centre) names the combo in every clip.',
  '',
  'CLIPS',
  '-----',
]
for (const n of rows) lines.push(`  ${n}.mp4  (${kb(n)}) — ${BLURB[n] ?? ''}`)
lines.push('')
lines.push('Each clip also has two stills: <name>-firing.png and <name>-aftermath.png')
lines.push('(they double as a contact sheet). See contact-sheet.html for a grid view.')
lines.push('')
lines.push('All clips are byte-deterministic: fixed fixture (combat-stage, seed 7) +')
lines.push('fixed per-tick input (the comboFire script) → identical world & video every run.')
lines.push('Regenerate: ./e2e/run-weapon-combos.sh then node e2e/weapon-combos-readme.mjs')
lines.push('')
writeFileSync(join(dir, 'README.txt'), lines.join('\n'))

// Printable HTML contact sheet: each clip's two stills side by side with a caption.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cards = rows
  .map(
    (n) => `  <figure>
    <figcaption><b>${esc(n)}.mp4</b> — ${esc(BLURB[n] ?? '')}</figcaption>
    <div class="shots"><img src="${n}-firing.png" alt="${n} firing"><img src="${n}-aftermath.png" alt="${n} aftermath"></div>
  </figure>`,
  )
  .join('\n')
const html = `<!doctype html><meta charset="utf-8"><title>Weapon combo showcase</title>
<style>
  body{font:15px/1.4 system-ui,sans-serif;background:#111;color:#eee;margin:24px}
  h1{font-size:20px}
  figure{margin:0 0 22px;border:1px solid #333;border-radius:8px;padding:12px;background:#1a1a1a}
  figcaption{margin-bottom:8px}
  .shots{display:flex;gap:8px}
  .shots img{width:calc(50% - 4px);border-radius:4px;border:1px solid #000}
</style>
<h1>Sporefall Station — weapon + ammo/mod showcase</h1>
<p>${rows.length} clips. Left = mid-fire, right = aftermath. The mp4s are next to this file.</p>
${cards}
`
writeFileSync(join(dir, 'contact-sheet.html'), html)

console.log(`wrote README.txt + contact-sheet.html for ${rows.length} clips to ${dir}`)
