import type { Playable } from '../types'

export default {
  id: 'beasts-bite',
  title: 'Beasts bite',
  subtitle: 'A hound pack, two stalkers and a brute',
  tests: 'Beasts fight with natural weapons (fangs, claws, horns), never knives or wrenches, and hounds circle before they close.',
  lookFor: 'Let them reach you. Bites and swipes come from the mouth and claws; nothing should be holding a blade.',
  section: 'new',
  tags: ['beasts', 'melee', 'hounds', 'brute'],
  start: { kind: 'fixture', fixture: 'beasts-bite' },
  shot: { tick: 96, zoom: 1.6 },
  demo: { range: 0 },
} satisfies Playable
