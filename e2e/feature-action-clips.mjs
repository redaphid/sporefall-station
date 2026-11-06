// The first drawn action clips, in the engine, on swampspace-hires (the pack the game loads).
//   1. drowner-draw: three drowners at 2.2 tiles from the player (west, north-west, north) see
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
          const r = (log[e.id] ??= { archetype: e.archetype, engage: null, readyAt: null, shot: null, cd: 0 })
          if (r.engage === null && e.ai?.mode === 'aggro') r.engage = w.tick
          if (r.readyAt === null && e.ai?.draw?.readyAt !== undefined) r.readyAt = e.ai.draw.readyAt
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
  params: { zoom: 4, theme: 'swampspace-hires' },
  stills: [
    { tick: 1, label: '00-start', act: watch },
    { tick: 40, label: '01-patrol' },
    ...[47, 50, 53, 56, 59].map((t, i) => ({ tick: t, label: `0${i + 2}-draw` })),
    { tick: 63, label: '07-fire' },
    { tick: 90, label: '08-firefight' },
  ],
  readState,
  expect: (s) => {
    const rows = Object.values(s.log).filter((r) => r.archetype === 'drowner')
    console.log('drowners', JSON.stringify(rows))
    return [
      rows.length !== 3 && `expected 3 drowners, got ${rows.length}`,
      ...rows.map((r) => r.engage === null && 'a drowner never engaged'),
      // the sim's own engage tick is readyAt - 16 (drawWindup); sampling the page can see aggro late
      ...rows.map((r) => r.readyAt === null && 'no draw wind-up recorded (ai.draw.readyAt)'),
      // the shot fires in the step of tick readyAt; the page reads the world after it (tick readyAt + 1)
      ...rows.map((r) => r.readyAt !== null && r.shot !== r.readyAt + 1 &&
        `first shot seen at tick ${r.shot}, wind-up ready at ${r.readyAt}`),
    ]
  },
})

const fidget = await recordFeature({
  name: 'action-hound-fidget',
  world: world('hound-fidget'),
  params: { zoom: 4, theme: 'swampspace-hires' },
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
