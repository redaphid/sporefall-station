// The crafted scenes players can open from /scenes.html. One entry per save:
// `name` is both the fixture (src/game/__fixtures__/<name>.json) and its
// generator (scripts/saves/<name>.mts), and the link is /?world=<name>.
// src/scenes/scenes.test.ts fails if an entry, a fixture and a generator do
// not line up, so add all three together.
//
// Plain data on purpose: the gallery page imports this and nothing else from
// the game, so it stays a few KB.

export interface Scene {
  readonly name: string
  readonly title: string
  /** One line: why this one is worth opening. */
  readonly hook: string
  /** What to try once it loads. */
  readonly tryThis: string
  /** Short labels for the threat and the tools, shown as chips. */
  readonly tags: readonly string[]
}

export const SCENES: readonly Scene[] = [
  {
    name: 'castle-siege',
    title: 'Castle Siege',
    hook: 'A moated castle, four towers, a garrison, and a lord in the keep.',
    tryThis: 'Cross the drawbridge with split, frost, pierce and homing. Mortars flank the keep; its door opens when the lord falls.',
    tags: ['assassinate', 'garrison', 'frost'],
  },
  {
    name: 'pillared-hall',
    title: 'The Pillared Hall',
    hook: 'Eight pillars, gunmen behind every one, and a pistol that bounces.',
    tryThis: 'Bank shots off the pillars. Gangsters hunt your last known spot, so break their sight and come round the other side.',
    tags: ['cover', 'bounce', 'homing'],
  },
  {
    name: 'cut-the-head',
    title: 'Cut the Head',
    hook: 'A raid gathers around its Bellwether. Kill the bell and the rest run.',
    tryThis: 'Find the Bellwether and drop it first. Leave it alive and its Mender keeps patching the rest.',
    tags: ['raid', 'leader', 'rout'],
  },
  {
    name: 'blackout-run',
    title: 'Blackout Run',
    hook: 'Sneak past sleeping barracks, cut the power, and run for the door it opens.',
    tryThis: 'The generator is up the side passage. Cutting it wakes every sleeper and turns the robots by the exit hostile.',
    tags: ['stealth', 'power cut', 'brownout'],
  },
  {
    name: 'mireclaw-den',
    title: "The Mireclaw's Den",
    hook: 'The Mireclaw Alpha in its bog, brooding sporelings around it.',
    tryThis: 'Incendiary rounds burn it harder than bullets. Kite round the pillars as it broods, and keep moving when it enrages.',
    tags: ['boss', 'spore', 'incendiary'],
  },
  {
    name: 'tide-and-thunder',
    title: 'Tide and Thunder',
    hook: 'Three hound packs in a flooding street grid, and a shock pistol.',
    tryThis: 'Hold the dry island and wait for the tide. Shock a wet hound and the arc jumps through the pack.',
    tags: ['hound packs', 'bog tide', 'shock'],
  },
  {
    name: 'crossfire',
    title: 'Crossfire',
    hook: 'Cops and gang meet in a crowded plaza. Nobody is after you yet.',
    tryThis: 'Watch them fight, or pick a side. Shoot a bystander and the police turn on you too.',
    tags: ['factions', 'neutral', 'shotgun'],
  },
  {
    name: 'barracks-blaze',
    title: 'Barracks Blaze',
    hook: 'A gang asleep in rows of bunks, fuel barrels at the back.',
    tryThis: 'Put one incendiary round into a bunk row, then back off. Fire walks bunk to bunk and the burning run.',
    tags: ['fire', 'sleepers', 'barrels'],
  },
  {
    name: 'hive-cavern',
    title: 'The Hive Cavern',
    hook: 'Three hive spires, a sporeling swarm, and a detonator shotgun.',
    tryThis: 'Every kill bursts into the ones beside it. Burn the spires or they keep budding more.',
    tags: ['horde', 'hive', 'detonator'],
  },
]

/** The link that opens a scene in play. Relative, so a beta build served under
 * /betas/<slug>/ opens its own game rather than production's. */
export const sceneHref = (name: string): string => `./?world=${encodeURIComponent(name)}`
