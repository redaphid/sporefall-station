import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NPCS } from '../game/data/npcs'
import {
  DEFAULT_THEME_ID,
  CHAR_NAMES,
  DIRS5,
  emptyManifest,
  FX_KEYS,
  isValidThemeId,
  parseColor,
  prettyArchetype,
  resolveMacroTiles,
  resolvePalette,
  resolveSpritePaths,
  resolveThemeId,
  SPRITE_KEYS,
  themedName,
  validateManifest,
  type LoadedTheme,
  type ThemeChain,
} from './theme'

const theme = (id: string, manifest: Partial<ReturnType<typeof emptyManifest>>): LoadedTheme => ({
  id,
  dir: `themes/${id}/`,
  manifest: { ...emptyManifest(), ...manifest },
})

// ---------------------------------------------------------------------------
describe('validateManifest', () => {
  it('accepts an empty manifest with no warnings (a zero-asset theme is valid)', () => {
    const { manifest, warnings } = validateManifest({})
    expect(warnings).toEqual([])
    expect(manifest.sprites).toEqual({})
    expect(manifest.names).toEqual({})
  })

  it.each([null, undefined, 42, 'nope', [], true])('degrades non-object input %j to an empty manifest', (raw) => {
    const { manifest, warnings } = validateManifest(raw)
    expect(manifest).toEqual(emptyManifest())
    expect(warnings.length).toBe(1)
  })

  it('warns on and drops unknown top-level keys', () => {
    const { warnings } = validateManifest({ spritez: {}, extra: 1 })
    expect(warnings.join('\n')).toContain('spritez')
    expect(warnings.join('\n')).toContain('extra')
  })

  it('drops unknown sprite keys with a warning but keeps known ones', () => {
    const { manifest, warnings } = validateManifest({
      sprites: { 'tile.floor': 'a.png', 'tile.lava': 'b.png' },
    })
    expect(manifest.sprites['tile.floor']).toEqual(['a.png'])
    expect(manifest.sprites['tile.lava']).toBeUndefined()
    expect(warnings.join('\n')).toContain('tile.lava')
  })

  it('normalizes single sprites to 1-element arrays and keeps fx arrays', () => {
    const { manifest, warnings } = validateManifest({
      sprites: { 'fx.flame': ['f1.png', 'f2.png'], 'fx.hit': 'h.png', projectile: 'p.png' },
    })
    expect(warnings).toEqual([])
    expect(manifest.sprites['fx.flame']).toEqual(['f1.png', 'f2.png'])
    expect(manifest.sprites['fx.hit']).toEqual(['h.png']) // string coerced for fx
    expect(manifest.sprites.projectile).toEqual(['p.png'])
  })

  it('rejects a frame array on a key that is neither fx.* nor tile.*', () => {
    const { manifest, warnings } = validateManifest({ sprites: { 'unit.player': ['a.png', 'b.png'] } })
    expect(manifest.sprites['unit.player']).toBeUndefined()
    expect(warnings.join('\n')).toContain('fx.*')
  })

  it('accepts variant arrays on tile.* keys (and accent pools)', () => {
    const { manifest, warnings } = validateManifest({
      sprites: {
        'tile.floor': ['a.png', 'b.png'],
        'tile.grass.accent': ['roots.png', 'spores.png'],
        'tile.causeway': 's.png', // single path still coerces to a 1-variant pool
      },
    })
    expect(warnings).toEqual([])
    expect(manifest.sprites['tile.floor']).toEqual(['a.png', 'b.png'])
    expect(manifest.sprites['tile.grass.accent']).toEqual(['roots.png', 'spores.png'])
    expect(manifest.sprites['tile.causeway']).toEqual(['s.png'])
  })

  it('accepts overlay decal pools on tile.* keys', () => {
    const { manifest, warnings } = validateManifest({
      sprites: { 'tile.floor.overlay': ['moss-0.png', 'moss-1.png'], 'tile.grass.overlay': 'clump.png' },
    })
    expect(warnings).toEqual([])
    expect(manifest.sprites['tile.floor.overlay']).toEqual(['moss-0.png', 'moss-1.png'])
    expect(manifest.sprites['tile.grass.overlay']).toEqual(['clump.png'])
  })

  it('accepts a macroTiles section and drops bad entries with warnings', () => {
    const { manifest, warnings } = validateManifest({
      macroTiles: { floor: 2, causeway: 4, lava: 2, wall: 5, grass: 2.5, exit: '2' },
    })
    expect(manifest.macroTiles).toEqual({ floor: 2, causeway: 4 })
    expect(warnings.join('\n')).toContain('lava')
    expect(warnings.join('\n')).toContain('macroTiles.wall')
    expect(warnings.join('\n')).toContain('macroTiles.grass')
    expect(warnings.join('\n')).toContain('macroTiles.exit')
  })

  it('macroTiles tolerates garbage without dying and defaults empty', () => {
    expect(validateManifest({ macroTiles: [] }).manifest.macroTiles).toEqual({})
    expect(validateManifest({ macroTiles: 'x' }).manifest.macroTiles).toEqual({})
    expect(validateManifest({}).manifest.macroTiles).toEqual({})
  })

  it('accepts an integer artScale 1..4 and defaults/rejects everything else', () => {
    expect(validateManifest({ artScale: 2 }).manifest.artScale).toBe(2)
    expect(validateManifest({ artScale: 1 }).manifest.artScale).toBe(1)
    expect(validateManifest({ artScale: 4 }).manifest.artScale).toBe(4)
    expect(validateManifest({}).manifest.artScale).toBe(1) // default
    // adversarial: out of range, non-integer, wrong type all fall back to 1 + warn
    for (const bad of [0, 5, -2, 2.5, '2', null, true, [2]]) {
      const { manifest, warnings } = validateManifest({ artScale: bad })
      expect(manifest.artScale).toBe(1)
      expect(warnings.join('\n')).toContain('artScale')
    }
  })

  it('keeps null as an explicit procedural opt-out', () => {
    const { manifest, warnings } = validateManifest({ sprites: { 'item.default': null } })
    expect(warnings).toEqual([])
    expect(manifest.sprites['item.default']).toBeNull()
  })

  it.each([
    '../../../etc/passwd', // traversal
    'http://evil.example/x.png', // scheme
    'data:image/png;base64,xxxx', // scheme
    'a\\b.png', // backslash
    '', // empty
    42, // number
    {}, // object
  ])('drops unsafe sprite path %j', (path) => {
    const { manifest, warnings } = validateManifest({ sprites: { 'tile.floor': path } })
    expect(manifest.sprites['tile.floor']).toBeUndefined()
    expect(warnings.length).toBe(1)
  })

  it('drops proto-polluting keys in names and never pollutes prototypes', () => {
    const raw = JSON.parse('{"names": {"__proto__": "Hacked", "constructor": "X", "warden": "Warden"}}') as unknown
    const { manifest, warnings } = validateManifest(raw)
    expect(manifest.names).toEqual({ warden: 'Warden' })
    expect(({} as Record<string, unknown>).warden).toBeUndefined()
    expect(warnings.length).toBe(2)
  })

  it('drops non-string, empty, and over-long names', () => {
    const { manifest, warnings } = validateManifest({
      names: { warden: 42, mutant: '', boss: 'x'.repeat(65), civilian: 'Villager' },
    })
    expect(manifest.names).toEqual({ civilian: 'Villager' })
    expect(warnings.length).toBe(3)
  })

  it('parses palette colors and drops malformed ones', () => {
    const { manifest, warnings } = validateManifest({
      palette: {
        background: '#0b0b12',
        uiAccent: 'red',
        floorTint: '#ff00ff',
        tiles: { causeway: '#010203', lava: '#010203', wall: 'nope' },
        entities: { warden: '#4a7a5a', mutant: 12345 },
      },
    })
    expect(manifest.palette.background).toBe(0x0b0b12)
    expect(manifest.palette.uiAccent).toBeUndefined()
    expect(manifest.palette.floorTint).toBe(0xff00ff)
    expect(manifest.palette.tiles).toEqual({ causeway: 0x010203 })
    expect(manifest.palette.entities).toEqual({ warden: 0x4a7a5a })
    expect(warnings.length).toBe(4) // uiAccent, lava, wall, mutant
  })

  it('tolerates garbage sub-sections without dying', () => {
    const { manifest, warnings } = validateManifest({ palette: [], names: 'x', sprites: 7, name: {}, version: '2' })
    expect(manifest).toEqual(emptyManifest())
    expect(warnings.length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
describe('parseColor', () => {
  it.each([
    ['#000000', 0],
    ['#ffffff', 0xffffff],
    ['#FF00ff', 0xff00ff],
  ])('parses %s', (s, n) => expect(parseColor(s)).toBe(n))
  it.each(['#fff', 'ffffff', '#ggg000', '#1234567', 42, null, undefined])('rejects %j', (s) =>
    expect(parseColor(s)).toBeUndefined(),
  )
})

// ---------------------------------------------------------------------------
describe('resolveSpritePaths (fallback order)', () => {
  const base = theme('settlement', {
    sprites: { 'tile.floor': ['/sprites/concrete-floor.png'], 'tile.wall': ['/sprites/brick-wall.png'] },
  })
  const active = theme('swamp', {
    sprites: { 'tile.floor': ['tiles/moss.png'], 'item.default': null },
  })
  const chain: ThemeChain = [active, base]

  it('active theme wins and resolves relative to its own folder', () => {
    expect(resolveSpritePaths('tile.floor', chain)).toEqual(['themes/swamp/tiles/moss.png'])
  })

  it('a key the active theme omits falls back to the default theme', () => {
    expect(resolveSpritePaths('tile.wall', chain)).toEqual(['sprites/brick-wall.png'])
  })

  it('null stops the walk: procedural even though the base maps the key', () => {
    const withBase = [theme('x', { sprites: { 'tile.floor': null } }), base]
    expect(resolveSpritePaths('tile.floor', withBase)).toBeUndefined()
  })

  it('a key nobody maps is procedural', () => {
    expect(resolveSpritePaths('projectile', chain)).toBeUndefined()
  })

  it('an empty chain (all manifest fetches failed) is procedural everywhere', () => {
    for (const key of SPRITE_KEYS) expect(resolveSpritePaths(key, [])).toBeUndefined()
  })

  it('root-absolute paths (leading /) resolve against the app root, any theme', () => {
    expect(resolveSpritePaths('tile.wall', [base])).toEqual(['sprites/brick-wall.png'])
  })
})

// ---------------------------------------------------------------------------
describe('themedName', () => {
  const chain: ThemeChain = [
    theme('swamp', { names: { warden: 'Bog Warden' } }),
    theme('settlement', { names: { warden: 'Warden', mutant: 'Mutant' } }),
  ]
  it('active theme name wins', () => expect(themedName('warden', chain)).toBe('Bog Warden'))
  it('falls back to the default theme', () => expect(themedName('mutant', chain)).toBe('Mutant'))
  it('falls back to title-cased archetype', () => expect(themedName('door.open', chain)).toBe('Door Open'))
  it('empty chain title-cases', () => expect(themedName('vending-machine', [])).toBe('Vending Machine'))
})

describe('prettyArchetype', () => {
  it.each([
    ['warden', 'Warden'],
    ['door.open', 'Door Open'],
    ['grenade-item', 'Grenade Item'],
    ['', ''],
    ['..', ''],
  ])('%s → %s', (input, out) => expect(prettyArchetype(input)).toBe(out))
})

// ---------------------------------------------------------------------------
describe('resolvePalette', () => {
  it('merges with the active theme winning per key', () => {
    const chain: ThemeChain = [
      theme('a', { palette: { background: 1, tiles: { causeway: 2 }, entities: {} } }),
      theme('b', { palette: { background: 3, uiAccent: 4, tiles: { causeway: 5, wall: 6 }, entities: { warden: 7 } } }),
    ]
    expect(resolvePalette(chain)).toEqual({
      background: 1,
      uiAccent: 4,
      tiles: { causeway: 2, wall: 6 },
      entities: { warden: 7 },
    })
  })
  it('empty chain yields an empty palette', () => {
    expect(resolvePalette([])).toEqual({ tiles: {}, entities: {} })
  })
})

// ---------------------------------------------------------------------------
describe('resolveMacroTiles', () => {
  it('active theme wins per tile name; undeclared names fall through', () => {
    const chain: ThemeChain = [
      theme('swamp', { macroTiles: { floor: 2 } }),
      theme('settlement', { macroTiles: { floor: 3, causeway: 2 } }),
    ]
    expect(resolveMacroTiles(chain)).toEqual({ floor: 2, causeway: 2 })
  })
  it('empty chain declares nothing', () => expect(resolveMacroTiles([])).toEqual({}))
})

describe('theme id selection', () => {
  it('URL param beats setting', () => expect(resolveThemeId('swamp', 'settlement')).toBe('swamp'))
  it('invalid param falls to setting', () => expect(resolveThemeId('../x', 'swamp')).toBe('swamp'))
  it('invalid both falls to default', () => expect(resolveThemeId('__proto__', 'NOPE!')).toBe(DEFAULT_THEME_ID))
  it('missing param uses setting', () => expect(resolveThemeId(null, 'test')).toBe('test'))
  it.each(['settlement', 'swamp-2', 'a'])('accepts id %s', (id) => expect(isValidThemeId(id)).toBe(true))
  it.each(['', 'Swamp', '-x', 'a b', 'a/b', 'a'.repeat(65), 42, null])('rejects id %j', (id) =>
    expect(isValidThemeId(id)).toBe(false),
  )
})

// ---------------------------------------------------------------------------
// The shipped theme packs must themselves be valid — this is the contract the
// asset-generation pipeline is graded against.
describe('shipped theme packs', () => {
  const load = (id: string): unknown =>
    JSON.parse(readFileSync(join(process.cwd(), 'public', 'themes', id, 'manifest.json'), 'utf8'))

  it('settlement manifest validates with zero warnings', () => {
    const { warnings } = validateManifest(load('settlement'))
    expect(warnings).toEqual([])
  })

  it('settlement maps every character direction it has art for (s/e/n × idle/step)', () => {
    const { manifest } = validateManifest(load('settlement'))
    for (const c of ['player', 'warden', 'mutant', 'civilian', 'scientist', 'acolyte', 'robot'])
      for (const d of ['s', 'e', 'n'])
        for (const f of ['idle', 'step']) expect(manifest.sprites[`char.${c}.${d}-${f}`], `char.${c}.${d}-${f}`).toBeDefined()
  })

  it('every file the settlement manifest references exists on disk', () => {
    const { manifest } = validateManifest(load('settlement'))
    const chain: ThemeChain = [{ id: 'settlement', dir: 'themes/settlement/', manifest }]
    for (const key of Object.keys(manifest.sprites)) {
      for (const p of resolveSpritePaths(key, chain) ?? [])
        expect(existsSync(join(process.cwd(), 'public', p)), `${key} → ${p}`).toBe(true)
    }
  })

  // Regression: `brute`, `cinder`, `sporeling`, `stalker`, `lurker` and `pod`
  // shipped with NO manifest entry, so `themedName` fell through to
  // `prettyArchetype` and a derelict swamp station labelled its bio-horrors
  // "Brute", "Cinder", "Pod". Both packs are checked because the hi-res pack
  // does not `extend` the base — it carries its own full `names` table.
  it.each(['swampspace', 'swampspace-hires'])('%s gives every spawnable NPC a themed name', (id) => {
    const { manifest } = validateManifest(load(id))
    const unnamed = Object.keys(NPCS).filter((a) => manifest.names[a] === undefined)
    expect(unnamed, `archetypes with no themed name in ${id}`).toEqual([])
  })

  it.each(['swampspace', 'swampspace-hires'])('%s never names an NPC with its bare archetype id', (id) => {
    const { manifest } = validateManifest(load(id))
    // e.g. `"pod": "Pod"` would satisfy the check above while still reading as
    // placeholder text in game — the name has to actually be lore.
    const bare = Object.keys(NPCS).filter((a) => manifest.names[a] === prettyArchetype(a))
    expect(bare, `archetypes named after themselves in ${id}`).toEqual([])
  })

  it('the two resolution packs agree on every NPC name', () => {
    const base = validateManifest(load('swampspace')).manifest
    const hires = validateManifest(load('swampspace-hires')).manifest
    for (const a of Object.keys(NPCS)) expect(hires.names[a], a).toBe(base.names[a])
  })

  it('swampspace manifest validates with zero warnings and every referenced file exists on disk', () => {
    const { manifest, warnings } = validateManifest(load('swampspace'))
    expect(warnings).toEqual([])
    expect(manifest.name).toBe('Sporefall Station')
    expect(manifest.names.mutant).toBe('Bog Mutant') // flavor-names section present
    const chain: ThemeChain = [{ id: 'swampspace', dir: 'themes/swampspace/', manifest }]
    for (const key of Object.keys(manifest.sprites)) {
      for (const p of resolveSpritePaths(key, chain) ?? [])
        expect(existsSync(join(process.cwd(), 'public', p)), `${key} → ${p}`).toBe(true)
    }
  })

  it('test theme validates with zero warnings and its floor.png exists (its broken wall ref is intentional)', () => {
    const { manifest, warnings } = validateManifest(load('test'))
    expect(warnings).toEqual([])
    expect(existsSync(join(process.cwd(), 'public', 'themes', 'test', 'floor.png'))).toBe(true)
    expect(manifest.sprites['tile.wall']).toEqual(['does-not-exist.png']) // graceful-degradation fixture
    expect(manifest.names.warden).toBe('Test Warden')
  })

  it('themes index lists only the Sporefall Station packs (base + hi-res)', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'public', 'themes', 'index.json'), 'utf8')) as Array<{
      id: string
    }>
    // Only Sporefall Station is shipped now (settlement/test are gone), advertised as
    // two packs — the base art and the hi-res art — so the settings picker
    // offers exactly that one toggle.
    expect(raw.map((t) => t.id).sort()).toEqual(['swampspace', 'swampspace-hires'])
    for (const t of raw) expect(isValidThemeId(t.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('canonical key set sanity', () => {
  it('contains the projectile/grenade base keys (mod-visual-trait composition)', () => {
    expect(SPRITE_KEYS.has('projectile')).toBe(true)
    expect(SPRITE_KEYS.has('grenade')).toBe(true)
  })
  it('contains the legacy char keys (dirs × 2 frames × characters) plus the state-frame grammar', () => {
    // Derived from CHAR_NAMES rather than hardcoded, so adding a character to
    // the canonical set (e.g. `boss`, ahead of its art landing) does not fail a
    // test that was only ever counting.
    const chars = CHAR_NAMES.length
    const charKeys = [...SPRITE_KEYS].filter((k) => k.startsWith('char.'))
    const legacy = charKeys.filter((k) => /-(idle|step)$/.test(k))
    expect(legacy.length).toBe(chars * DIRS5.length * 2)
    // chars × 5 dirs × 6 states × 8 frames of char.<c>.<d>-<state>-<n>.
    expect(charKeys.length).toBe(legacy.length + chars * DIRS5.length * ANIM_STATES.length * MAX_ANIM_FRAMES)
    expect(DIRS5.length).toBe(5)
  })
  it('fx keys are a subset of the sprite keys', () => {
    for (const k of FX_KEYS) expect(SPRITE_KEYS.has(k)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Animation-state schema extension (docs/themes.md "Animation states").
import { ANIM_STATES, DEFAULT_TPF, MAX_ANIM_FRAMES } from './animState'
import { resolveAnimTpf, resolveAnimTpfs } from './theme'

describe('animation-state sprite keys', () => {
  it('accepts every char.<kind>.<dir>-<state>-<n> key in the grammar', () => {
    const sprites: Record<string, string> = {}
    for (const s of ANIM_STATES) sprites[`char.player.s-${s}-0`] = `${s}.png`
    sprites['char.mutant.ne-attack-7'] = 'a7.png'
    const { manifest, warnings } = validateManifest({ sprites })
    expect(warnings).toEqual([])
    for (const s of ANIM_STATES) expect(manifest.sprites[`char.player.s-${s}-0`]).toEqual([`${s}.png`])
    expect(manifest.sprites['char.mutant.ne-attack-7']).toEqual(['a7.png'])
  })

  it('rejects frame indices beyond MAX_ANIM_FRAMES-1, unknown states, and unknown dirs', () => {
    const { manifest, warnings } = validateManifest({
      sprites: {
        [`char.player.s-attack-${MAX_ANIM_FRAMES}`]: 'x.png', // n out of range
        'char.player.s-dance-0': 'x.png', // not a state
        'char.player.sw-attack-0': 'x.png', // west half is mirrored, never drawn
        'char.dragon.s-attack-0': 'x.png', // not a character
      },
    })
    expect(Object.keys(manifest.sprites)).toEqual([])
    expect(warnings.length).toBe(4)
  })

  it('legacy idle/step keys coexist with new-grammar keys for the same direction', () => {
    const { manifest, warnings } = validateManifest({
      sprites: { 'char.warden.e-idle': 'i.png', 'char.warden.e-step': 's.png', 'char.warden.e-hurt-0': 'h.png' },
    })
    expect(warnings).toEqual([])
    expect(Object.keys(manifest.sprites).length).toBe(3)
  })
})

describe('manifest anim section (per-state ticks-per-frame)', () => {
  it('keeps valid integer tpf overrides per state', () => {
    const { manifest, warnings } = validateManifest({ anim: { walk: 4, attack: 1, idle: 30 } })
    expect(warnings).toEqual([])
    expect(manifest.anim).toEqual({ walk: 4, attack: 1, idle: 30 })
  })

  it('drops unknown states and out-of-range/non-integer values with warnings', () => {
    const { manifest, warnings } = validateManifest({
      anim: { walk: 0, hurt: 31, idle: 2.5, death: '5', sprint: 6 },
    })
    expect(manifest.anim).toEqual({})
    expect(warnings.length).toBe(5)
  })

  it('degrades a non-object anim section to empty with one warning', () => {
    const { manifest, warnings } = validateManifest({ anim: [6] })
    expect(manifest.anim).toEqual({})
    expect(warnings.length).toBe(1)
  })

  it('a manifest with no anim section resolves every state to the engine default', () => {
    const chain: ThemeChain = [theme('settlement', {})]
    for (const s of ANIM_STATES) expect(resolveAnimTpf(s, chain)).toBe(DEFAULT_TPF[s])
  })

  it('resolves through the chain: active theme wins, settlement fills, default backstops', () => {
    const chain: ThemeChain = [theme('swamp', { anim: { walk: 3 } }), theme('settlement', { anim: { walk: 9, attack: 4 } })]
    expect(resolveAnimTpf('walk', chain)).toBe(3) // active wins
    expect(resolveAnimTpf('attack', chain)).toBe(4) // settlement fills
    expect(resolveAnimTpf('hurt', chain)).toBe(DEFAULT_TPF.hurt) // default backstops
    expect(resolveAnimTpfs(chain)).toMatchObject({ walk: 3, attack: 4, hurt: DEFAULT_TPF.hurt })
  })

  it('an empty chain resolves everything to defaults (procedural-only boot)', () => {
    expect(resolveAnimTpfs([])).toEqual(DEFAULT_TPF)
  })
})
