import type { Playable } from '../types'

export default {
  id: 'grenade-cluster',
  title: 'Grenade cluster',
  subtitle: 'Four sleepers in a huddle, six grenades',
  tests: 'One explosion kills a tight group and throws every body outward from the blast, all on the same tick.',
  lookFor: 'Throw (Use) into the huddle: the bodies should fan out radially like a flower, not all fall the same way.',
  section: 'new',
  tags: ['grenade', 'death tumble', 'explosion'],
  start: { kind: 'fixture', fixture: 'grenade-cluster' },
  shot: { tick: 53, zoom: 1.6 },
  demo: { throwAt: [30], fireFrom: 100000 },
} satisfies Playable
