import type { Playable } from '../types'

export default {
  id: 'drowner-reel',
  title: 'Drowner reel',
  subtitle: 'Three tough divers across the lock',
  tests: 'The drowned diver hurt clip: each hit snaps the body back with arms flung, then it sways and settles.',
  lookFor: 'Shoot from range and watch every hit land. They shoot back, so keep moving; you have plenty of health.',
  section: 'new',
  tags: ['hurt clip', 'drowner', 'pistol'],
  start: { kind: 'fixture', fixture: 'drowner-reel' },
  shot: { tick: 22, zoom: 1.6 },
  demo: { range: 12 },
} satisfies Playable
