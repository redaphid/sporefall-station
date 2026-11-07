import type { Playable } from '../types'

export default {
  id: 'hard-hits',
  title: 'Hard hits',
  subtitle: 'A shotgun, sleeping mutants, nowhere to land',
  tests: 'Death tumble: a big blow throws the body, which tips, spins and lands on its side. Display only; the sim is untouched.',
  lookFor: 'Blast the near mutants point blank: they fly back and skid. Spore mites go further. A light plink (try the pistol scenarios) only topples.',
  section: 'new',
  tags: ['death tumble', 'shotgun', 'mutant', 'sporeling'],
  start: { kind: 'fixture', fixture: 'hard-hits' },
  shot: { tick: 12, zoom: 1.6 },
  demo: { range: 12 },
} satisfies Playable
