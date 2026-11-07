import type { Playable } from '../types'

export default {
  id: 'quickdraw',
  title: 'Quickdraw standoff',
  subtitle: 'Three drowned divers, one long flooded hall',
  tests: 'The engage wind-up: a gunman who spots you draws first and holds his first shot for about half a second (16 ticks).',
  lookFor: 'Walk east. Each diver turns, plays the draw, and only then fires. You can drop one before he clears leather.',
  section: 'new',
  tags: ['draw wind-up', 'drowner', 'Rivet Driver'],
  start: { kind: 'fixture', fixture: 'quickdraw' },
  shot: { tick: 76, zoom: 1 },
  demo: { route: [{ x: 19.5, y: 6.5 }] },
} satisfies Playable
