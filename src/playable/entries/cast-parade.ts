import type { Playable } from '../types'

export default {
  id: 'cast-parade',
  title: 'Cast parade',
  subtitle: 'Twelve of the cast pacing their own lanes, all friendly',
  tests: 'The new walk cycles: derelict bot, pod-carrier bog mutant, gloom lurker, carapace brute, bellwether, cinder husk, spore mite and more, in every facing.',
  lookFor: 'Walk up and down beside them. Feet should plant without sliding, and each turn should pick the right facing. Nobody attacks.',
  section: 'new',
  tags: ['walk cycles', 'cast', 'peaceful'],
  start: { kind: 'fixture', fixture: 'cast-parade' },
  shot: { tick: 90, zoom: 0.8 },
  demo: { range: 0 },
} satisfies Playable
