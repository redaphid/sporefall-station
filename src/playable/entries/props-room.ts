import type { Playable } from '../types'

export default {
  id: 'props-room',
  title: 'Props room',
  subtitle: 'The new colony plumbing kit, furnished',
  tests: 'The eight regenerated props: hydro recycler, cryo terminal, nutrient dispenser, weapons locker, mess bench, work desk, wall screen and supply cabinet.',
  lookFor: 'Walk among them at game zoom. Each should read as what it is beside the crate, barrel and chair, with no moss slab or halo.',
  section: 'new',
  tags: ['props', 'art', 'peaceful'],
  start: { kind: 'fixture', fixture: 'props-room' },
  shot: { tick: 10, zoom: 1.5 },
} satisfies Playable
