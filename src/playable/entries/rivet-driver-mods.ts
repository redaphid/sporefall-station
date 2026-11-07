import type { Playable } from '../types'

export default {
  id: 'rivet-driver-mods',
  title: 'Rivet Driver + mods',
  subtitle: 'The new sidearm wearing five mods',
  tests: 'The Rivet Driver held in the hand, with an attachment drawn on the gun for each mod (frost, incendiary, shock, homing, heavy) and the rounds they make.',
  lookFor: 'Zoom in on the gun as you turn: every attachment should sit on it in every facing. Then shoot the sleepers and watch them freeze, burn and arc.',
  section: 'new',
  tags: ['Rivet Driver', 'weapon mods', 'frost', 'shock', 'fire'],
  start: { kind: 'fixture', fixture: 'rivet-driver-mods' },
  shot: { tick: 16, zoom: 2.4 },
  demo: { range: 12 },
} satisfies Playable
