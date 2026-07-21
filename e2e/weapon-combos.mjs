// demo/weapon-combos — a labelled mp4 per WEAPON + AMMO/MOD combo, firing into a
// row of stationary dummy targets so the on-hit effect is plainly visible.
//
// Same proven recipe as feature-weapon-mods.mjs: inject the committed
// `combat-stage` snapshot (seed 7, three speed-0 thugs at x=12/15/18 on the lane
// y=11), re-arm the player to a specific base weapon + mod loadout, PRE-POSITION
// the player just west of the row, then replay the tight `comboFire` timeline
// (no walk-in) and mux a real mp4. Each clip carries an on-screen title banner
// (a `text` annotation) naming the combo. Every run is byte-deterministic:
// fixed fixture + fixed per-tick input → identical world + identical video.
//
//   node e2e/weapon-combos.mjs        (server must be up — see run-weapon-combos.sh)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { record } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const LANE_Y = 11
// Stand the player on the lane, just west of the dummy row, facing east (0 rad).
// Distances to the three thugs (x=12/15/18) are ~2.5/5.5/8.5 tiles — inside
// pistol range (10) and machinegun range (9); the shotgun (range 6) reaches the
// first two. facing=0 makes every bullet travel east straight down the row.
const PLAYER_X = 9.5

/** combat-stage, but the player is re-armed to `weaponId` + `mods` (slotted so
 * the fire-site resolver folds them in) and stood on the lane facing the row.
 * Optionally lower player hp (to show lifesteal healing back up). */
const armed = (weaponId, mods, hp) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: PLAYER_X, y: LANE_Y }
  p.prevPos = { x: PLAYER_X, y: LANE_Y }
  p.vel = { x: 0, y: 0 }
  p.facing = 0
  p.combat.weapon = weaponId
  p.playerCtl.inventory = [{ itemId: weaponId, qty: 999, mods }]
  p.playerCtl.activeSlot = 0
  if (hp !== undefined) p.health.hp = hp
  return w
}

const stills = [
  { tick: 90, label: 'firing' },
  { tick: 180, label: 'aftermath' },
]

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  // Dead NPCs are CULLED from the entities array, so a fallen thug simply
  // disappears: kills = 3 (initial) − thugsAlive. Non-lethal effects leave a
  // live thug at hp < 24 (thugsWoundedAlive).
  const thugsAlive = w.entities.filter((e) => e.archetype === 'thug' && !e.dead)
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    thugsAlive: thugsAlive.length,
    thugsKilled: 3 - thugsAlive.length,
    thugsWoundedAlive: thugsAlive.filter((e) => (e.health?.hp ?? 24) < 24).length,
    projectiles: w.entities.filter((e) => e.kind === 'projectile').length,
    playerHp: pl?.health?.hp ?? null,
    playerDowned: !!pl?.playerCtl?.downed,
  }
}

// One entry per clip: a base weapon (baseline) or a weapon + mod loadout, with a
// short on-screen title. `hp` (optional) lets the lifesteal clip start wounded.
const combos = [
  // ── base weapons (no mods) ──────────────────────────────────────────────
  { name: 'base-pistol', title: 'Pistol — plain rounds', weapon: 'pistol', mods: [] },
  { name: 'base-shotgun', title: 'Shotgun — 5-pellet spread', weapon: 'shotgun', mods: [] },
  { name: 'base-machinegun', title: 'Machine Gun — rapid fire', weapon: 'machinegun', mods: [] },

  // ── single mods (the on-hit effect is the star) ─────────────────────────
  { name: 'weapon-explosive', title: 'Explosive — blows up on impact (AoE)', weapon: 'pistol', mods: [{ id: 'explosive', stacks: 2 }] },
  { name: 'weapon-pierce', title: 'Piercing — punches through the whole row', weapon: 'pistol', mods: [{ id: 'pierce', stacks: 3 }] },
  { name: 'weapon-frost', title: 'Cryo Rounds — freeze, then shatter', weapon: 'pistol', mods: [{ id: 'frost', stacks: 1 }] },
  { name: 'weapon-incendiary', title: 'Incendiary — sets them on fire', weapon: 'pistol', mods: [{ id: 'incendiary', stacks: 1 }] },
  { name: 'weapon-splinter', title: 'Splinter Shot — shrapnel burst on hit', weapon: 'pistol', mods: [{ id: 'splinterShot', stacks: 3 }] },
  { name: 'weapon-bounce', title: 'Bouncy — bullets ricochet', weapon: 'pistol', mods: [{ id: 'bounce', stacks: 2 }] },
  { name: 'weapon-velocity', title: 'Hot Loads — bullets scream downrange', weapon: 'pistol', mods: [{ id: 'velocity', stacks: 3 }] },
  { name: 'weapon-shock', title: 'Tesla Rounds — zap & stun', weapon: 'pistol', mods: [{ id: 'shock', stacks: 1 }] },
  { name: 'weapon-lifesteal', title: 'Vampiric — heal on every hit', weapon: 'machinegun', mods: [{ id: 'lifesteal', stacks: 3 }, { id: 'rapid', stacks: 1 }], hp: 40 },

  // ── combos (mods stack) ─────────────────────────────────────────────────
  { name: 'combo-pierce-explosive', title: 'Pierce + Explosive — pass through & boom', weapon: 'pistol', mods: [{ id: 'pierce', stacks: 2 }, { id: 'explosive', stacks: 2 }] },
  { name: 'combo-frost-shock', title: 'Cryo + Tesla — freeze and zap', weapon: 'pistol', mods: [{ id: 'frost', stacks: 1 }, { id: 'shock', stacks: 1 }] },
]

// Optional `COMBO_FILTER=weapon-frost` to record a single clip (for iteration).
const filter = process.env.COMBO_FILTER
const selected = filter ? combos.filter((c) => c.name.includes(filter)) : combos

let ok = true
for (const c of selected) {
  const world = armed(c.weapon, c.mods, c.hp)
  const pass = await record({
    name: c.name,
    params: { mode: 'solo', e2e: '1', world: '@inline', script: 'comboFire', zoom: '1.7' },
    beforeTicks: async (page) => {
      // Boot BLOCKS on __loadWorld being CALLED before it defines __annotate, so
      // the order matters: wait for + call __loadWorld first, THEN wait for the
      // now-defined __annotate and push the on-screen title banner.
      await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
      await page.evaluate((j) => window.__loadWorld(j), world)
      await page.waitForFunction(() => typeof window.__annotate === 'function', { timeout: 20000 })
      // On-screen title banner: a persistent `text` annotation placed at explicit
      // SCREEN px (bottom-centre, clear of the top HUD and the mid-screen action).
      await page.evaluate(
        (title) => window.__annotate(JSON.stringify({ kind: 'text', text: title, x: 640, y: 672 })),
        c.title,
      )
    },
    stills,
    readState,
    // Media task: keep asserts to sanity (real clip, no crash, effect landed).
    expect: (s) => [
      s.gameOver && 'unexpected game over',
      s.playerDowned && 'player went down (dummies should not reach us)',
      s.thugsKilled === 0 && s.thugsWoundedAlive === 0 && 'no dummy was hit — nothing to show',
    ].filter(Boolean),
  })
  ok = ok && pass
}
if (!ok) process.exitCode = 1
