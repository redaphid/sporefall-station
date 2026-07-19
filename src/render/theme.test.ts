import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_ID,
  DIRS5,
  emptyManifest,
  FX_KEYS,
  isValidThemeId,
  parseColor,
  prettyArchetype,
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

  it('rejects a frame array on a non-fx key', () => {
    const { manifest, warnings } = validateManifest({ sprites: { 'tile.floor': ['a.png', 'b.png'] } })
    expect(manifest.sprites['tile.floor']).toBeUndefined()
    expect(warnings.join('\n')).toContain('fx.*')
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
    const raw = JSON.parse('{"names": {"__proto__": "Hacked", "constructor": "X", "cop": "Warden"}}') as unknown
    const { manifest, warnings } = validateManifest(raw)
    expect(manifest.names).toEqual({ cop: 'Warden' })
    expect(({} as Record<string, unknown>).cop).toBeUndefined()
    expect(warnings.length).toBe(2)
  })

  it('drops non-string, empty, and over-long names', () => {
    const { manifest, warnings } = validateManifest({
      names: { cop: 42, thug: '', boss: 'x'.repeat(65), civilian: 'Villager' },
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
        tiles: { street: '#010203', lava: '#010203', wall: 'nope' },
        entities: { cop: '#4a7a5a', thug: 12345 },
      },
    })
    expect(manifest.palette.background).toBe(0x0b0b12)
    expect(manifest.palette.uiAccent).toBeUndefined()
    expect(manifest.palette.floorTint).toBe(0xff00ff)
    expect(manifest.palette.tiles).toEqual({ street: 0x010203 })
    expect(manifest.palette.entities).toEqual({ cop: 0x4a7a5a })
    expect(warnings.length).toBe(4) // uiAccent, lava, wall, thug
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
  const base = theme('city', {
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
    theme('swamp', { names: { cop: 'Bog Warden' } }),
    theme('city', { names: { cop: 'Cop', thug: 'Thug' } }),
  ]
  it('active theme name wins', () => expect(themedName('cop', chain)).toBe('Bog Warden'))
  it('falls back to the default theme', () => expect(themedName('thug', chain)).toBe('Thug'))
  it('falls back to title-cased archetype', () => expect(themedName('door.open', chain)).toBe('Door Open'))
  it('empty chain title-cases', () => expect(themedName('vending-machine', [])).toBe('Vending Machine'))
})

describe('prettyArchetype', () => {
  it.each([
    ['cop', 'Cop'],
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
      theme('a', { palette: { background: 1, tiles: { street: 2 }, entities: {} } }),
      theme('b', { palette: { background: 3, uiAccent: 4, tiles: { street: 5, wall: 6 }, entities: { cop: 7 } } }),
    ]
    expect(resolvePalette(chain)).toEqual({
      background: 1,
      uiAccent: 4,
      tiles: { street: 2, wall: 6 },
      entities: { cop: 7 },
    })
  })
  it('empty chain yields an empty palette', () => {
    expect(resolvePalette([])).toEqual({ tiles: {}, entities: {} })
  })
})

// ---------------------------------------------------------------------------
describe('theme id selection', () => {
  it('URL param beats setting', () => expect(resolveThemeId('swamp', 'city')).toBe('swamp'))
  it('invalid param falls to setting', () => expect(resolveThemeId('../x', 'swamp')).toBe('swamp'))
  it('invalid both falls to default', () => expect(resolveThemeId('__proto__', 'NOPE!')).toBe(DEFAULT_THEME_ID))
  it('missing param uses setting', () => expect(resolveThemeId(null, 'test')).toBe('test'))
  it.each(['city', 'swamp-2', 'a'])('accepts id %s', (id) => expect(isValidThemeId(id)).toBe(true))
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

  it('city manifest validates with zero warnings', () => {
    const { warnings } = validateManifest(load('city'))
    expect(warnings).toEqual([])
  })

  it('city maps every character direction it has art for (s/e/n × idle/step)', () => {
    const { manifest } = validateManifest(load('city'))
    for (const c of ['player', 'cop', 'thug', 'civilian', 'scientist', 'gangster', 'robot'])
      for (const d of ['s', 'e', 'n'])
        for (const f of ['idle', 'step']) expect(manifest.sprites[`char.${c}.${d}-${f}`], `char.${c}.${d}-${f}`).toBeDefined()
  })

  it('every file the city manifest references exists on disk', () => {
    const { manifest } = validateManifest(load('city'))
    const chain: ThemeChain = [{ id: 'city', dir: 'themes/city/', manifest }]
    for (const key of Object.keys(manifest.sprites)) {
      for (const p of resolveSpritePaths(key, chain) ?? [])
        expect(existsSync(join(process.cwd(), 'public', p)), `${key} → ${p}`).toBe(true)
    }
  })

  it('swampspace manifest validates with zero warnings and every referenced file exists on disk', () => {
    const { manifest, warnings } = validateManifest(load('swampspace'))
    expect(warnings).toEqual([])
    expect(manifest.name).toBe('Sporefall Station')
    expect(manifest.names.thug).toBe('Bog Mutant') // flavor-names section present
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
    expect(manifest.names.cop).toBe('Test Warden')
  })

  it('themes index lists valid ids including city', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'public', 'themes', 'index.json'), 'utf8')) as Array<{
      id: string
    }>
    expect(raw.some((t) => t.id === 'city')).toBe(true)
    for (const t of raw) expect(isValidThemeId(t.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('canonical key set sanity', () => {
  it('contains the projectile/grenade base keys (mod-visual-trait composition)', () => {
    expect(SPRITE_KEYS.has('projectile')).toBe(true)
    expect(SPRITE_KEYS.has('grenade')).toBe(true)
  })
  it('contains all 70 legacy char keys (5 dirs × 2 frames × 7 characters) plus the state-frame grammar', () => {
    const charKeys = [...SPRITE_KEYS].filter((k) => k.startsWith('char.'))
    const legacy = charKeys.filter((k) => /-(idle|step)$/.test(k))
    expect(legacy.length).toBe(70)
    // 7 chars × 5 dirs × 6 states × 8 frames of char.<c>.<d>-<state>-<n>.
    expect(charKeys.length).toBe(70 + 7 * 5 * ANIM_STATES.length * MAX_ANIM_FRAMES)
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
    sprites['char.thug.ne-attack-7'] = 'a7.png'
    const { manifest, warnings } = validateManifest({ sprites })
    expect(warnings).toEqual([])
    for (const s of ANIM_STATES) expect(manifest.sprites[`char.player.s-${s}-0`]).toEqual([`${s}.png`])
    expect(manifest.sprites['char.thug.ne-attack-7']).toEqual(['a7.png'])
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
      sprites: { 'char.cop.e-idle': 'i.png', 'char.cop.e-step': 's.png', 'char.cop.e-hurt-0': 'h.png' },
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
    const chain: ThemeChain = [theme('city', {})]
    for (const s of ANIM_STATES) expect(resolveAnimTpf(s, chain)).toBe(DEFAULT_TPF[s])
  })

  it('resolves through the chain: active theme wins, city fills, default backstops', () => {
    const chain: ThemeChain = [theme('swamp', { anim: { walk: 3 } }), theme('city', { anim: { walk: 9, attack: 4 } })]
    expect(resolveAnimTpf('walk', chain)).toBe(3) // active wins
    expect(resolveAnimTpf('attack', chain)).toBe(4) // city fills
    expect(resolveAnimTpf('hurt', chain)).toBe(DEFAULT_TPF.hurt) // default backstops
    expect(resolveAnimTpfs(chain)).toMatchObject({ walk: 3, attack: 4, hurt: DEFAULT_TPF.hurt })
  })

  it('an empty chain resolves everything to defaults (procedural-only boot)', () => {
    expect(resolveAnimTpfs([])).toEqual(DEFAULT_TPF)
  })
})
