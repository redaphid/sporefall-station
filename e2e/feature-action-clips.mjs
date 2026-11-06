// The first drawn action clips, in the engine, on swampspace-hires (the pack the game loads).
//   1. drowner-draw: three drowners at 3 tiles from the player (west, north-west, north) see
//      him and engage. Each plays the 8-frame `draw` (pistol out, aim held) and fires its first
//      shot NpcDef.drawTicks (16) after the engage; the held-weapon sprite is hidden while draw plays.
//   2. hound-fidget: three calm gloam-hounds (facing e, ne, w) stand idle until their fidget grid
//      comes round, then scratch behind the head with a hind leg (ids 74/73/72 at ticks 93/171/192).
// Worlds: src/game/__fixtures__/action-*.json (scripts/test/gen-action-clips-worlds.mts).
//
//   BASE_URL=http://127.0.0.1:4917 E2E_CDP=<own-chrome cdpUrl> node e2e/feature-action-clips.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const world = (name) => JSON.parse(readFileSync(join(__dirname, `../src/game/__fixtures__/action-${name}.json`), 'utf8'))

/** Per tick, per NPC: first tick in aggro (the engage) and first tick its cooldown rises (the shot). */
const watch = (page) =>
  page.evaluate(() => {
    const log = (window.__actionLog = {})
    let last = -1
    const step = () => {
      const w = window.__world
      if (w.tick !== last) {
        last = w.tick
        for (const e of w.entities) {
          if (e.kind !== 'npc') continue
          const r = (log[e.id] ??= { archetype: e.archetype, engage: null, shot: null, cd: 0 })
          if (r.engage === null && e.ai?.mode === 'aggro') r.engage = w.tick
          const cd = e.combat?.cooldown ?? 0
          if (r.shot === null && cd > r.cd) r.shot = w.tick
          r.cd = cd
        }
      }
      requestAnimationFrame(step)
    }
    step()
  })

const readState = () => ({ tick: window.__world.tick, log: window.__actionLog ?? {} })

const draw = await recordFeature({
  name: 'action-drowner-draw',
  world: world('drowner-draw'),
  params: { zoom: 2.5, theme: 'swampspace-hires' },
  stills: [
    { tick: 1, label: '00-patrol', act: watch },
    ...[4, 7, 10, 13, 16, 19, 22].map((t, i) => ({ tick: t, label: `0${i + 1}-draw` })),
    { tick: 30, label: '08-fire' },
    { tick: 60, label: '09-firefight' },
  ],
  readState,
  expect: (s) => {
    const rows = Object.values(s.log).filter((r) => r.archetype === 'drowner')
    console.log('drowners', JSON.stringify(rows))
    return [
      rows.length !== 3 && `expected 3 drowners, got ${rows.length}`,
      ...rows.map((r) => r.engage === null && 'a drowner never engaged'),
      ...rows.map((r) => r.engage !== null && r.shot !== null && r.shot - r.engage !== 16 &&
        `first shot ${r.shot - r.engage} ticks after the engage, want 16`),
    ]
  },
})

const fidget = await recordFeature({
  name: 'action-hound-fidget',
  world: world('hound-fidget'),
  params: { zoom: 2.5, theme: 'swampspace-hires' },
  stills: [
    { tick: 1, label: '00-start', act: watch },
    { tick: 60, label: '00-idle' },
    { tick: 99, label: '01-w-scratch' },
    { tick: 105, label: '02-w-scratch' },
    { tick: 180, label: '03-ne-scratch' },
    { tick: 186, label: '04-ne-scratch' },
    { tick: 201, label: '05-e-scratch' },
    { tick: 207, label: '06-e-scratch' },
    { tick: 230, label: '07-idle-again' },
  ],
  readState,
  expect: (s) => {
    const rows = Object.values(s.log)
    return [
      rows.length !== 3 && `expected 3 hounds, got ${rows.length}`,
      rows.some((r) => r.engage !== null) && 'a hound left calm (engaged)',
    ]
  },
})

process.exit(draw && fidget ? 0 : 1)
