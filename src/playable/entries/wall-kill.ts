import type { Playable } from '../types'

export default {
  id: 'wall-kill',
  title: 'Wall kill',
  subtitle: 'Three sleepers with their backs to a bulkhead',
  tests: 'A body thrown into a wall stops at the wall and settles at its foot instead of passing through.',
  lookFor: 'Shoot each one into the east wall. Known issue #182: the body can still look stuck upright against the wall for a moment.',
  section: 'new',
  tags: ['death tumble', 'walls', '#182'],
  start: { kind: 'fixture', fixture: 'wall-kill' },
  shot: { tick: 72, zoom: 1.6 },
  demo: { route: [{ x: 16.5, y: 5.5 }], fireFrom: 30 },
} satisfies Playable
