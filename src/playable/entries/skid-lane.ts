import type { Playable } from '../types'

export default {
  id: 'skid-lane',
  title: 'Skid lane',
  subtitle: 'A big empty deck to sprint and stop on',
  tests: 'The skid stop: let go mid-run and the body leans back against the run, slides a hair past the stop and kicks up dust.',
  lookFor: 'Run flat out and release in all eight directions. The gun should follow the lean, and walking slowly should not skid.',
  section: 'new',
  tags: ['skid', 'movement', 'peaceful'],
  start: { kind: 'fixture', fixture: 'skid-lane' },
  shot: { tick: 73, zoom: 2 },
  demo: {
    range: 0,
    dwell: 30,
    route: [
      { x: 31.5, y: 12.5 },
      { x: 31.5, y: 5.5 },
      { x: 9.5, y: 5.5 },
      { x: 9.5, y: 18.5 },
    ],
  },
} satisfies Playable
