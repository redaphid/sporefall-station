import { HostSession } from '../app/hostSession'
import { ARENAS, arenaRoom, stageArena } from '../game/arenas'
import type { Entity } from '../game/entity'
import { isSolidTile, rectContains } from '../game/levelgen/level'
import type { Rect } from '../game/levelgen/rooms'
import { PLAYER_HP } from '../game/player'
import { spawnNpc } from '../game/populate'
import { applyScenario } from '../game/scenarios'
import { vlen } from '../game/simMath'
import { emptyInput, SIM_RATE } from '../game/types'
import type { World } from '../game/world'
import { runVerb } from './verbs'

export interface CensusBuild {
  readonly name: string
  readonly mods: readonly string[]
  readonly sequenced: boolean
}

const fold = (name: string, mods: string[]): CensusBuild => ({ name, mods, sequenced: false })
const seq = (name: string, mods: string[]): CensusBuild => ({ name: `seq ${name}`, mods, sequenced: true })

const HAND = ['shock', 'incendiary', 'frost', 'pierce']

export const CENSUS_BUILDS: readonly CensusBuild[] = [
  fold('none', []),
  fold('shock', ['shock']),
  fold('incendiary', ['incendiary']),
  fold('frost', ['frost']),
  fold('hand', HAND),
  fold('shock+pierce', ['shock', 'pierce']),
  fold('incendiary+pierce', ['incendiary', 'pierce']),
  fold('frost+pierce', ['frost', 'pierce']),
  seq('none', []),
  seq('shock', ['shock']),
  seq('incendiary', ['incendiary']),
  seq('frost', ['frost']),
  seq('pierce>shock', ['pierce', 'shock']),
  seq('pierce>incendiary', ['pierce', 'incendiary']),
  seq('pierce>frost', ['pierce', 'frost']),
  seq('pierce>incendiary>frost', ['pierce', 'incendiary', 'frost']),
  seq('pierce>shock>incendiary', ['pierce', 'shock', 'incendiary']),
  seq('pierce>frost>shock', ['pierce', 'frost', 'shock']),
  seq('shock>frost', ['shock', 'frost']),
  seq('shock>incendiary', ['shock', 'incendiary']),
  seq('hand shock-lead', ['pierce', 'shock', 'incendiary', 'frost']),
  seq('hand fire-lead', ['pierce', 'incendiary', 'frost', 'shock']),
  seq('hand frost-lead', ['pierce', 'frost', 'shock', 'incendiary']),
]

/** One seed per arena-room shape, from 7x7 to 11x8, so no two seeds stage the same geometry. */
export const CENSUS_SEEDS: readonly number[] = [303, 5, 4, 2, 44, 18, 51, 10]

export const FIGHT_TICKS = 60 * SIM_RATE

const BACK_OFF_HP_FRAC = 0.5
const BACK_OFF_DIST = 1.5

export type Policy = 'bot' | 'passive'
export type Outcome = 'won' | 'downed' | 'timeout'

export interface FightResult {
  arena: string
  build: string
  seed: number
  policy: Policy
  outcome: Outcome
  ticks: number
  damageTaken: number
  foeHpLeft: number
  foeHpMax: number
  hpTraceHash: string
}

export const livingFoes = (w: World): Entity[] => w.entities.filter((e) => e.ai && !e.dead && (e.health?.hp ?? 0) > 0)

const firstPlayer = (w: World): Entity => {
  const me = w.entities.find((e) => e.playerCtl)
  if (!me?.health) throw new Error('census: the run has no player')
  return me
}

export interface BotStep {
  aimAt: number
  attack: true
  moveX?: number
  moveY?: number
}

export const botInput = (w: World, me: Entity): BotStep | undefined => {
  let target: Entity | undefined
  let best = Infinity
  for (const e of livingFoes(w)) {
    const d = vlen(e.pos.x - me.pos.x, e.pos.y - me.pos.y)
    if (d < best) {
      best = d
      target = e
    }
  }
  if (!target) return undefined
  const input: BotStep = { aimAt: target.id, attack: true }
  const hurt = me.health!.hp < me.health!.max * BACK_OFF_HP_FRAC
  if ((hurt || best < BACK_OFF_DIST) && best > 0) {
    input.moveX = (me.pos.x - target.pos.x) / best
    input.moveY = (me.pos.y - target.pos.y) / best
  }
  return input
}

export const newRun = (seed: number, sequenced: boolean): World =>
  new HostSession(seed, { sample: emptyInput }, undefined, 'normal', sequenced ? 'sequence' : undefined).world

const fnv = (h: number, n: number): number => {
  let x = h
  for (let i = 0; i < 4; i++) {
    x ^= (n >>> (i * 8)) & 0xff
    x = Math.imul(x, 0x01000193) >>> 0
  }
  return x
}

export const runFight = (arena: string, build: CensusBuild, seed: number, policy: Policy = 'bot'): FightResult => {
  const spec = ARENAS[arena]
  if (!spec) throw new Error(`census: unknown arena "${arena}"`)
  const w = newRun(seed, build.sequenced)
  applyScenario(w, arena)
  const me = firstPlayer(w)
  for (const mod of build.mods) runVerb(w, `addMod ${me.id} ${mod}`)
  const staged = livingFoes(w)
  const want = spec.foes.reduce((n, f) => n + f.count, 0)
  if (staged.length !== want) throw new Error(`census: ${arena} on seed ${seed} staged ${staged.length} of ${want} foes`)
  const floor = w.floor
  const foeHpMax = staged.reduce((s, e) => s + e.health!.max, 0)
  let prevHp = me.health!.hp
  let damageTaken = 0
  let hpTrace = 0x811c9dc5
  for (let t = 0; ; t++) {
    if (w.floor !== floor) throw new Error(`census: ${arena} on seed ${seed} left floor ${floor} at tick ${t}`)
    const alive = staged.filter((e) => !e.dead && e.health!.hp > 0)
    const foeHpLeft = alive.reduce((s, e) => s + e.health!.hp, 0)
    hpTrace = fnv(fnv(hpTrace, me.health!.hp), foeHpLeft)
    const outcome: Outcome | undefined =
      alive.length === 0 ? 'won' : me.dead || me.playerCtl!.downed ? 'downed' : t >= FIGHT_TICKS ? 'timeout' : undefined
    if (outcome) {
      return { arena, build: build.name, seed, policy, outcome, ticks: t, damageTaken, foeHpLeft, foeHpMax, hpTraceHash: hpTrace.toString(16).padStart(8, '0') }
    }
    const step = policy === 'bot' ? botInput(w, me) : undefined
    runVerb(w, step ? `step 1 ${JSON.stringify(step)}` : 'step 1')
    const hp = Math.max(me.health!.hp, 0)
    if (hp < prevHp) damageTaken += prevHp - hp
    prevHp = hp
  }
}

export interface ReachResult {
  distance: number
  playerFires: boolean
  firstShot?: number
  shots: number
  closest: number
  damageTaken: number
  foeDamage: number
}

const REACH_FOE_HP = 5000
const REACH_TICKS = 10 * SIM_RATE

export const openStreetRow = (w: World, n: number): Rect => {
  const { level } = w
  const indoors = (x: number, y: number): boolean => level.buildings.some((b) => rectContains(b.rect, x, y))
  const standing = w.entities.filter((e) => e.kind === 'interactable' || e.kind === 'door')
  const occupied = new Set(standing.map((e) => Math.floor(e.pos.y) * level.w + Math.floor(e.pos.x)))
  const clear = (x: number, y: number): boolean => !isSolidTile(level, x, y) && !indoors(x, y) && !occupied.has(y * level.w + x)
  let best: Rect | undefined
  let bestD = Infinity
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x + n < level.w; x++) {
      let ok = true
      for (let i = 0; i < n && ok; i++) ok = clear(x + i, y - 1) && clear(x + i, y) && clear(x + i, y + 1)
      const d = Math.abs(x + n / 2 - level.w / 2) + Math.abs(y - level.h / 2)
      if (ok && d < bestD) {
        best = { x, y, w: n, h: 1 }
        bestD = d
      }
    }
  }
  if (!best) throw new Error(`census: seed ${w.seed} has no ${n}-cell open street row`)
  return best
}

export const reachProbe = (archetype: string, seed: number, distance: number, playerFires: boolean): ReachResult => {
  const w = newRun(seed, false)
  stageArena(w, { question: 'reach probe', foes: [] }, openStreetRow(w, distance + 2))
  const me = firstPlayer(w)
  const foe = spawnNpc(w, archetype, me.pos.x + distance, me.pos.y)
  foe.health = { hp: REACH_FOE_HP, max: REACH_FOE_HP, iframes: 0 }
  const seen = new Set<number>()
  let firstShot: number | undefined
  let closest = vlen(foe.pos.x - me.pos.x, foe.pos.y - me.pos.y)
  let prevHp = me.health!.hp
  let damageTaken = 0
  for (let t = 0; t < REACH_TICKS && !me.playerCtl!.downed; t++) {
    runVerb(w, playerFires ? `step 1 {"aimAt":${foe.id},"attack":true}` : 'step 1')
    for (const e of w.entities) {
      if (e.projectile?.ownerId !== foe.id || seen.has(e.id)) continue
      seen.add(e.id)
      firstShot ??= t
    }
    closest = Math.min(closest, vlen(foe.pos.x - me.pos.x, foe.pos.y - me.pos.y))
    const hp = Math.max(me.health!.hp, 0)
    if (hp < prevHp) damageTaken += prevHp - hp
    prevHp = hp
  }
  return { distance, playerFires, firstShot, shots: seen.size, closest: Math.round(closest * 10) / 10, damageTaken, foeDamage: REACH_FOE_HP - foe.health.hp }
}

export const describeArenaRoom = (seed: number): string => {
  const w = newRun(seed, false)
  const room = arenaRoom(w)
  const b = w.level.buildings.find((x) => room && x.rooms.includes(room))
  if (!room || !b) return `seed ${seed}: no room`
  return `seed ${seed}: ${b.role} ${b.roomTypes?.[b.rooms.indexOf(room)] ?? 'room'} ${room.w}x${room.h}`
}

export interface BuildSummary {
  build: string
  fights: number
  wins: number
  downs: number
  timeouts: number
  /** How many of the fights differ from each other: seeds that replay one fight count once. */
  distinctFights: number
  medianTtk?: number
  meanDamage: number
  meanFoeHpLeftWhenNotWon?: number
}

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export const summarize = (build: string, fights: readonly FightResult[]): BuildSummary => {
  const lost = fights.filter((f) => f.outcome !== 'won')
  return {
    build,
    fights: fights.length,
    wins: fights.length - lost.length,
    downs: fights.filter((f) => f.outcome === 'downed').length,
    timeouts: fights.filter((f) => f.outcome === 'timeout').length,
    distinctFights: new Set(fights.map((f) => f.hpTraceHash)).size,
    medianTtk: median(fights.filter((f) => f.outcome === 'won').map((f) => f.ticks)),
    meanDamage: mean(fights.map((f) => f.damageTaken)),
    meanFoeHpLeftWhenNotWon: lost.length ? mean(lost.map((f) => f.foeHpLeft)) : undefined,
  }
}

const byTtk = (a: number | undefined, b: number | undefined): number => (a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b)

export const byStrength = (a: BuildSummary, b: BuildSummary): number =>
  b.wins - a.wins ||
  a.downs - b.downs ||
  (a.meanFoeHpLeftWhenNotWon ?? 0) - (b.meanFoeHpLeftWhenNotWon ?? 0) ||
  a.meanDamage - b.meanDamage ||
  byTtk(a.medianTtk, b.medianTtk)

const secs = (ticks: number | undefined): string => (ticks === undefined ? 'n/a' : (ticks / SIM_RATE).toFixed(1))

const brief = (s: BuildSummary): string => `${s.wins}/${s.fights} won, ${secs(s.medianTtk)} s, ${Math.round(s.meanDamage)} dmg`

/** The first row of `rows` and every row that ties it, as one label. */
const tiedWith = (rows: readonly BuildSummary[], first: BuildSummary): string =>
  rows.filter((s) => byStrength(s, first) === 0).map((s) => s.build).join(' = ')

export interface CensusReport {
  arenas: readonly string[]
  seeds: readonly number[]
  rooms: readonly string[]
  fights: readonly FightResult[]
  reach: readonly ReachResult[]
  reachArchetype: string
}

export const renderCensus = (r: CensusReport): string => {
  const out: string[] = []
  const bot = r.fights.filter((f) => f.policy === 'bot')
  const builds = [...new Set(bot.map((f) => f.build))]
  const fightsOf = (arena: string, build: string): FightResult[] => bot.filter((f) => f.arena === arena && f.build === build)
  const cellOf = (arena: string, build: string): BuildSummary => summarize(build, fightsOf(arena, build))
  const ranked = new Map(r.arenas.map((a) => [a, builds.map((b) => cellOf(a, b)).sort(byStrength)]))

  out.push('| arena | foes | question | control |', '|---|---|---|---|')
  for (const arena of r.arenas) {
    const spec = ARENAS[arena]
    const foes = spec.foes.map((f) => `${f.count} ${f.archetype}${f.resist ? ` ${JSON.stringify(f.resist)}` : ''}${f.wet ? ' wet' : ''}`).join(', ')
    out.push(`| \`${arena}\` | ${foes} | ${spec.question} | ${spec.control ? `\`${spec.control}\`` : ''} |`)
  }
  out.push('', `Arena rooms (the room with the most open floor on each seed): ${r.rooms.join('; ')}.`, '')

  out.push('### Build x arena', '')
  out.push(`Each cell is fights won out of seeds, then mean damage taken. The player has ${PLAYER_HP} hp, and passive regen can push damage taken past it. Bold marks the best build in the column.`, '')
  out.push(`| build | ${r.arenas.join(' | ')} |`, `|---|${r.arenas.map(() => '---').join('|')}|`)
  for (const b of builds) {
    const cells = r.arenas.map((a) => {
      const s = cellOf(a, b)
      const text = `${s.wins}/${s.fights} · ${Math.round(s.meanDamage)}`
      return byStrength(s, ranked.get(a)![0]) === 0 ? `**${text}**` : text
    })
    out.push(`| ${b} | ${cells.join(' | ')} |`)
  }
  out.push('')

  out.push('### Best and worst build per arena', '')
  out.push('Builds joined by `=` tie on every ranking key.', '')
  out.push('| arena | best | worst | generic hand (fold) | builds that failed to win at least once |', '|---|---|---|---|---|')
  for (const arena of r.arenas) {
    const rows = ranked.get(arena)!
    const hand = rows.find((s) => s.build === 'hand')
    const failed = rows.filter((s) => s.wins < s.fights).length
    const best = rows[0]
    const worst = rows[rows.length - 1]
    out.push(`| ${arena} | ${tiedWith(rows, best)}: ${brief(best)} | ${tiedWith(rows, worst)}: ${brief(worst)} | ${hand ? brief(hand) : 'n/a'} | ${failed}/${rows.length} |`)
  }
  out.push('')

  out.push('### Builds that fought identically', '')
  out.push('Builds with the same hp trace on every seed of an arena. The worlds may still differ in ways hp does not show, such as a status that deals no damage.', '')
  for (const arena of r.arenas) {
    const groups = new Map<string, string[]>()
    for (const b of builds) {
      const key = r.seeds.map((seed) => bot.find((f) => f.arena === arena && f.build === b && f.seed === seed)?.hpTraceHash).join(',')
      groups.set(key, [...(groups.get(key) ?? []), b])
    }
    const same = [...groups.values()].filter((g) => g.length > 1).map((g) => g.join(' = '))
    out.push(`- ${arena}: ${same.length ? same.join('; ') : 'none'}.`)
  }
  out.push('')

  for (const arena of r.arenas) {
    const spec = ARENAS[arena]
    const passive = r.fights.filter((f) => f.arena === arena && f.policy === 'passive')
    const downed = passive.filter((f) => f.outcome === 'downed')
    out.push(`### ${arena}`, '', spec.question, '')
    out.push(`A passive player (no fire, no movement) is downed on ${downed.length}/${passive.length} seeds, after a median ${secs(median(downed.map((f) => f.ticks)))} s.`, '')
    out.push('| build | won | downed | timed out | distinct fights | median TTK (s) | mean dmg taken | mean foe HP left when not won |', '|---|---|---|---|---|---|---|---|')
    for (const s of ranked.get(arena)!) {
      out.push(`| ${s.build} | ${s.wins} | ${s.downs} | ${s.timeouts} | ${s.distinctFights} | ${secs(s.medianTtk)} | ${Math.round(s.meanDamage)} | ${s.meanFoeHpLeftWhenNotWon === undefined ? '' : Math.round(s.meanFoeHpLeftWhenNotWon)} |`)
    }
    out.push('')
  }

  for (const arena of r.arenas) {
    const control = ARENAS[arena].control
    if (!control || !r.arenas.includes(control)) continue
    out.push(`### ${control} vs ${arena}`, '')
    out.push(`| build | ${control} | ${arena} | seeds with an identical hp trace |`, '|---|---|---|---|')
    for (const b of builds) {
      const same = r.seeds.filter((seed) => {
        const x = bot.find((f) => f.arena === control && f.build === b && f.seed === seed)
        const y = bot.find((f) => f.arena === arena && f.build === b && f.seed === seed)
        return x !== undefined && y !== undefined && x.hpTraceHash === y.hpTraceHash
      }).length
      out.push(`| ${b} | ${brief(cellOf(control, b))} | ${brief(cellOf(arena, b))} | ${same}/${r.seeds.length} |`)
    }
    out.push('')
  }

  if (r.reach.length) {
    out.push(`### Reach probe: does a ${r.reachArchetype} fight back?`, '')
    out.push(`The ${r.reachArchetype} stands on an open street row with ${REACH_FOE_HP} hp. The player holds still for ${secs(REACH_TICKS)} s.`, '')
    out.push('| distance (tiles) | player fires | foe first shot (s) | foe shots | closest approach | dmg taken | dmg dealt to foe |', '|---|---|---|---|---|---|---|')
    for (const p of r.reach) {
      out.push(`| ${p.distance} | ${p.playerFires ? 'yes' : 'no'} | ${p.firstShot === undefined ? 'never' : secs(p.firstShot)} | ${p.shots} | ${p.closest} | ${p.damageTaken} | ${p.foeDamage} |`)
    }
    out.push('')
  }
  return out.join('\n')
}
