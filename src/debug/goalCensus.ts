// Goal-churn census: run a real world for N ticks and measure how often each
// NPC changes its mind. The numbers the AI commitment work is judged against.
//
//   switches per NPC-minute   every change of `ai.goal` code
//   median dwell              seconds spent in a goal before leaving it
//   A→B→A within 2 s          a goal left and re-adopted inside 60 ticks: the
//                             visible flip-flop
//
// Broken down by class: settler (the civ faction), warden (warden), hostile
// (rootcult), and neutral. Pure over the world it is handed, so the CLI
// (scripts/goal-census.mts) and the regression test share one measurement.

import type { Entity } from '../game/entity'
import { isActivityCode } from '../game/systems/activities'
import { emptyInput, SIM_RATE, type InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'

export type CensusClass = 'settler' | 'warden' | 'hostile' | 'neutral'

export const classOf = (e: Entity): CensusClass => {
  switch (e.ai?.faction) {
    case 'civ':
      return 'settler'
    case 'warden':
      return 'warden'
    case 'rootcult':
      return 'hostile'
    default:
      return 'neutral'
  }
}

export interface GoalSegment {
  code: string
  from: number
  to: number
}

export interface GoalTrace {
  id: number
  archetype: string
  cls: CensusClass
  segments: GoalSegment[]
  /** Ticks this NPC was alive and awake inside the window. */
  ticks: number
}

/** A↔B flip-flop window: a goal left and re-adopted inside 2 s. */
export const ABA_WINDOW = 2 * SIM_RATE

/** Tick `w` for `ticks` ticks with idle players, recording every thinking NPC's
 * goal after each tick. Dormant and dead bodies stop accruing time. */
export interface TraceOpts {
  /** Filled with the activity sessions that started, by kind. */
  sessions?: Record<string, number>
  /** Runs before every tick: a stimulus a scene keeps up. */
  before?: (w: World) => void
}

export const traceGoals = (w: World, ticks: number, opts: TraceOpts = {}): GoalTrace[] => {
  const sessions = opts.sessions ?? {}
  const traces = new Map<number, GoalTrace>()
  const players = w.entities.filter((e) => e.playerCtl).map((e) => e.playerCtl!.playerId)
  const inputs = (): Map<number, InputCmd> => new Map(players.map((slot) => [slot, emptyInput()]))
  for (let i = 0; i < ticks; i++) {
    opts.before?.(w)
    tickWorld(w, inputs())
    for (const ev of w.events) if (ev.type === 'activity' && ev.phase === 'start') sessions[ev.kind] = (sessions[ev.kind] ?? 0) + 1
    for (const e of w.entities) {
      if (!e.ai || e.dead || e.ai.dormant || e.playerCtl) continue
      const code = e.ai.goal ?? 'none'
      let t = traces.get(e.id)
      if (!t) {
        t = { id: e.id, archetype: e.archetype, cls: classOf(e), segments: [], ticks: 0 }
        traces.set(e.id, t)
      }
      t.ticks++
      const last = t.segments[t.segments.length - 1]
      if (last && last.code === code && last.to === w.tick - 1) last.to = w.tick
      else t.segments.push({ code, from: w.tick, to: w.tick })
    }
  }
  return [...traces.values()]
}

export interface CensusRow {
  label: string
  npcs: number
  npcMinutes: number
  switches: number
  switchesPerMin: number
  /** Median completed-goal dwell in seconds (the final, still-open goal of
   * each NPC is excluded: it never ended). */
  medianDwellS: number
  aba: number
  abaPerMin: number
  /** Share of NPC time spent in an activity (cards, tinker, rest). */
  activityShare: number
  /** The commonest A→B→A pairs, "A>B" → count. */
  topAba: [string, number][]
  /** The commonest switches, "A>B" → count. */
  topSwitches: [string, number][]
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const top = (m: Map<string, number>, n: number): [string, number][] =>
  [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n)

export const summarize = (label: string, traces: readonly GoalTrace[]): CensusRow => {
  let switches = 0
  let aba = 0
  let ticks = 0
  let busy = 0
  const dwells: number[] = []
  const abaPairs = new Map<string, number>()
  const switchPairs = new Map<string, number>()
  for (const t of traces) {
    ticks += t.ticks
    const s = t.segments
    for (let i = 1; i < s.length; i++) {
      // A gap (the NPC slept or went dormant) is not a decision.
      if (s[i].from !== s[i - 1].to + 1) continue
      switches++
      const k = `${s[i - 1].code}>${s[i].code}`
      switchPairs.set(k, (switchPairs.get(k) ?? 0) + 1)
    }
    for (let i = 0; i < s.length - 1; i++) dwells.push((s[i].to - s[i].from + 1) / SIM_RATE)
    for (const seg of s) if (isActivityCode(seg.code)) busy += seg.to - seg.from + 1
    for (let i = 2; i < s.length; i++) {
      const [a, b, c] = [s[i - 2], s[i - 1], s[i]]
      if (a.code !== c.code || b.to - b.from + 1 > ABA_WINDOW) continue
      if (b.from !== a.to + 1 || c.from !== b.to + 1) continue
      aba++
      const k = `${a.code}>${b.code}`
      abaPairs.set(k, (abaPairs.get(k) ?? 0) + 1)
    }
  }
  const npcMinutes = ticks / SIM_RATE / 60
  const per = (n: number): number => (npcMinutes > 0 ? n / npcMinutes : 0)
  return {
    label,
    npcs: traces.length,
    npcMinutes,
    switches,
    switchesPerMin: per(switches),
    medianDwellS: median(dwells),
    aba,
    abaPerMin: per(aba),
    activityShare: ticks > 0 ? busy / ticks : 0,
    topAba: top(abaPairs, 5),
    topSwitches: top(switchPairs, 6),
  }
}

export const CLASSES: readonly CensusClass[] = ['settler', 'warden', 'hostile', 'neutral']

/** One row for the whole run plus one per class that has members. */
export const censusRows = (label: string, traces: readonly GoalTrace[]): CensusRow[] => [
  summarize(`${label} all`, traces),
  ...CLASSES.map((c) => summarize(`${label} ${c}`, traces.filter((t) => t.cls === c))).filter((r) => r.npcs > 0),
]

const f2 = (n: number): string => n.toFixed(2)

export const renderRows = (rows: readonly CensusRow[]): string => {
  const head = '| run | NPCs | NPC-min | switches/min | median dwell s | A→B→A <2s /min | in activity | top A→B→A |'
  const sep = '|---|---:|---:|---:|---:|---:|---:|---|'
  const body = rows.map(
    (r) =>
      `| ${r.label} | ${r.npcs} | ${f2(r.npcMinutes)} | ${f2(r.switchesPerMin)} | ${f2(r.medianDwellS)} | ${f2(r.abaPerMin)} | ${(r.activityShare * 100).toFixed(0)}% | ${r.topAba.map(([k, n]) => `${k} ${n}`).join(', ')} |`,
  )
  return [head, sep, ...body].join('\n')
}
