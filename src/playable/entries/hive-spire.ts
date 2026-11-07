import type { Playable } from '../types'

export default {
  id: 'hive-spire',
  title: 'Hive spire',
  subtitle: 'A spire in a mossy cave, and a Phosphor Hose',
  tests: 'The hive spire: its idle loop, and the drawn attack clip it plays each time it buds spore mites at you. Left alone it plants new spires.',
  lookFor: 'Stand close and watch the bud swell, drop and burst at the roots. Back off to see the idle. Fire burns it best.',
  section: 'new',
  tags: ['hive', 'spire', 'sporeling', 'fire'],
  start: { kind: 'fixture', fixture: 'hive-spire' },
  shot: { tick: 64, zoom: 1.2 },
  demo: { route: [{ x: 13.5, y: 8.5 }], range: 0 },
} satisfies Playable
