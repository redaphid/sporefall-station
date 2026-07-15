// Headless session/lobby driver for the debug harness. Wraps a HostSession (the
// authoritative sim) with a lobby lifecycle (create → join bots → start → run)
// and a Recorder, so a whole co-op session can be created, populated with bot
// players driven by programmatic/scripted InputCmds, stepped tick-by-tick, and
// recorded — all in Node, no phone, no render loop.
//
// Bots are extra player slots whose per-tick command comes from a programmable
// input source (overridable live via the `input` verb, or a named SCRIPT). Each
// tick their command is deposited into HostSession.remoteInputs, exactly where
// the real net layer puts remote players — so the sim path is identical.
//
// `runHarnessVerb` exposes all of this as the same one-line verb grammar the CLI
// and MCP already speak; unknown verbs fall through to the world verb surface
// (`runVerb`), so `entities`/`get`/`set`/… keep working against the live world.

import { HostSession } from '../app/hostSession'
import { spawnPlayer } from '../game/player'
import { emptyInput, type InputCmd, type SimEvent } from '../game/types'
import type { World } from '../game/world'
import type { InputSource } from '../input/input'
import { createScriptedInput, SCRIPTS } from '../input/scripted'
import { decodeArg } from './protocol'
import { applyFixture, playerSeeds, Recorder, replay, saveWorld, type Recording, type WorldFixture } from './record'
import { runVerb, type VerbCtx } from './verbs'

export type HarnessPhase = 'idle' | 'lobby' | 'playing'

export interface HarnessPlayer {
  slot: number
  name: string
  classId: string
  bot: boolean
}

/** An input source whose command can be overridden live, else falls back to a
 * script (or neutral input). Latest-write-wins, like a remote player's channel. */
interface Programmable extends InputSource {
  set(cmd: Partial<InputCmd>): void
}

const programmable = (script?: InputSource): Programmable => {
  let override: InputCmd | null = null
  return {
    sample: () => override ?? (script ? script.sample() : emptyInput()),
    set: (cmd) => {
      override = { ...emptyInput(), ...cmd }
    },
  }
}

interface Bot {
  slot: number
  name: string
  classId: string
  input: Programmable
  entityId?: number
}

interface Game {
  host: HostSession
  localInput: Programmable
  hostName: string
  hostClassId: string
}

export class GameHarness {
  phase: HarnessPhase = 'idle'
  private game?: Game
  private bots = new Map<number, Bot>()
  private recorder?: Recorder
  private lastInputs?: Map<number, InputCmd>
  private lastTick = 0
  /** Events accumulated since the last drain — the harness channel streams these. */
  private stream: Array<Record<string, unknown>> = []

  get world(): World {
    if (!this.game) throw new Error('no game — call create first')
    return this.game.host.world
  }

  /** Build a fresh session in the lobby phase (nothing ticks until start). */
  create(opts: { seed: number; classId: string; name?: string }): void {
    const localInput = programmable()
    const host = new HostSession(opts.seed, opts.classId, localInput)
    host.onTickInputs = (inputs) => {
      this.lastInputs = new Map([...inputs].map(([slot, cmd]) => [slot, { ...cmd }]))
      this.lastTick = host.world.tick
    }
    this.game = { host, localInput, hostName: opts.name ?? 'Host', hostClassId: opts.classId }
    this.bots.clear()
    this.recorder = undefined
    this.stream = []
    this.phase = 'lobby'
  }

  private nextSlot(): number {
    let max = 0
    for (const s of this.bots.keys()) if (s > max) max = s
    return max + 1
  }

  /** Add a bot player. Pre-start it just reserves a lobby slot; mid-run it spawns
   * straight into the live world (late-join). */
  addBot(opts: { name: string; classId: string; script?: string }): number {
    if (!this.game) throw new Error('no game — call create first')
    const script = opts.script ? SCRIPTS[opts.script] : undefined
    if (opts.script && !script) throw new Error(`unknown script: ${opts.script}`)
    const slot = this.nextSlot()
    const bot: Bot = {
      slot,
      name: opts.name,
      classId: opts.classId,
      input: programmable(script ? createScriptedInput(script) : undefined),
    }
    this.bots.set(slot, bot)
    if (this.phase === 'playing') this.spawnBot(bot)
    return slot
  }

  removeBot(slot: number): void {
    const bot = this.bots.get(slot)
    if (!bot) throw new Error(`no bot in slot ${slot}`)
    this.bots.delete(slot)
    this.game!.host.remoteInputs.delete(slot)
    if (bot.entityId !== undefined) {
      const avatar = this.world.byId.get(bot.entityId)
      if (avatar) avatar.dead = true
    }
  }

  private spawnBot(bot: Bot): void {
    const spawn = this.world.level.spawn
    const e = spawnPlayer(this.world, bot.slot, bot.classId, spawn.x + bot.slot * 0.6, spawn.y)
    bot.entityId = e.id
  }

  /** Leave the lobby: spawn every bot's avatar and allow ticking. */
  start(): void {
    if (!this.game) throw new Error('no game — call create first')
    if (this.phase === 'playing') return
    for (const bot of this.bots.values()) this.spawnBot(bot)
    this.phase = 'playing'
  }

  lobby(): HarnessPlayer[] {
    if (!this.game) return []
    const players: HarnessPlayer[] = [{ slot: 0, name: this.game.hostName, classId: this.game.hostClassId, bot: false }]
    for (const b of this.bots.values()) players.push({ slot: b.slot, name: b.name, classId: b.classId, bot: true })
    return players.sort((a, b) => a.slot - b.slot)
  }

  /** Override a slot's next command (slot 0 = host). Latest-write-wins. */
  setInput(slot: number, cmd: Partial<InputCmd>): void {
    if (!this.game) throw new Error('no game — call create first')
    if (slot === 0) return this.game.localInput.set(cmd)
    const bot = this.bots.get(slot)
    if (!bot) throw new Error(`no bot in slot ${slot}`)
    bot.input.set(cmd)
  }

  stepTick(): void {
    if (this.phase !== 'playing') throw new Error('start the run before ticking')
    const host = this.game!.host
    for (const bot of this.bots.values()) host.remoteInputs.set(bot.slot, bot.input.sample())
    host.tick() // fires onTickInputs (captures the composed map), runs the sim
    if (this.recorder && this.lastInputs) this.recorder.frame(this.lastTick, this.lastInputs, this.world.events)
    for (const e of this.world.events) this.stream.push({ tick: this.lastTick, ...e })
  }

  stepTicks(n: number): void {
    for (let i = 0; i < n; i++) this.stepTick()
  }

  /** Step until `pred(world)` holds or `maxTicks` elapse; returns ticks stepped. */
  runUntil(pred: (w: World) => boolean, maxTicks: number): number {
    let n = 0
    while (n < maxTicks && !pred(this.world)) {
      this.stepTick()
      n++
    }
    return n
  }

  /** Begin recording. Must be at genesis (tick 0) so replay can rebuild the world
   * from seed + player seeds and re-feed the whole input history. */
  startRecording(): void {
    if (this.phase !== 'playing') throw new Error('start the run before recording')
    if (this.world.tick !== 0) throw new Error('recording must start at tick 0 (before any step)')
    this.recorder = new Recorder({ seed: this.world.seed, floor: this.world.floor, players: playerSeeds(this.world) })
  }

  stopRecording(): Recording {
    if (!this.recorder) throw new Error('not recording')
    const rec = this.recorder.finish(this.world)
    this.recorder = undefined
    return rec
  }

  save(): WorldFixture {
    return saveWorld(this.world)
  }

  load(fx: WorldFixture): void {
    applyFixture(this.world, fx)
  }

  /** Pull (and clear) events accumulated since the last call — for the channel. */
  drainStreamEvents(): Array<Record<string, unknown>> {
    return this.stream.splice(0)
  }

  events(): SimEvent[] {
    return [...this.world.events]
  }
}

// ---- verb router --------------------------------------------------------

const num = (s: string | undefined, what: string): number => {
  const n = Number(s)
  if (!Number.isFinite(n)) throw new Error(`expected a number for ${what}, got "${s}"`)
  return n
}

/** The session/lobby/record verbs, in addition to the world verbs. */
export const SESSION_VERBS = new Set([
  'create',
  'join_bot',
  'remove_bot',
  'start_run',
  'lobby',
  'phase',
  'input',
  'tick',
  'record_start',
  'record_stop',
  'save',
  'load',
  'replay',
])

/**
 * Route one verb line against a harness. Session verbs are handled here; any
 * other verb falls through to the world surface so `entities`/`get`/`set`/… keep
 * working. Returns a text reply (usually JSON), like `runVerb`.
 */
export const runHarnessVerb = (h: GameHarness, line: string, ctx: VerbCtx = {}): string => {
  const trimmed = line.trim()
  const sp = trimmed.indexOf(' ')
  const verb = sp < 0 ? trimmed : trimmed.slice(0, sp)
  const rest = sp < 0 ? '' : trimmed.slice(sp + 1).trim()

  switch (verb) {
    case 'create': {
      const [classId, seedStr, ...nameParts] = rest.split(/\s+/)
      if (!classId || !seedStr) throw new Error('usage: create <classId> <seed> [name]')
      h.create({ classId, seed: num(seedStr, 'seed'), name: nameParts.join(' ') || undefined })
      return JSON.stringify({ ok: true, phase: h.phase, players: h.lobby() })
    }

    case 'join_bot': {
      const [name, classId, script] = rest.split(/\s+/)
      if (!name || !classId) throw new Error('usage: join_bot <name> <classId> [scriptName]')
      const slot = h.addBot({ name, classId, script })
      return JSON.stringify({ slot, players: h.lobby() })
    }

    case 'remove_bot':
      h.removeBot(num(rest, 'slot'))
      return JSON.stringify({ ok: true, players: h.lobby() })

    case 'start_run':
      h.start()
      return JSON.stringify({ ok: true, phase: h.phase, players: h.lobby() })

    case 'lobby':
      return JSON.stringify(h.lobby())

    case 'phase':
      return JSON.stringify({ phase: h.phase, tick: h.world.tick, floor: h.world.floor, gameOver: h.world.gameOver })

    case 'input': {
      const idSp = rest.indexOf(' ')
      if (idSp < 0) throw new Error('usage: input <slot> <jsonCmd>')
      const slot = num(rest.slice(0, idSp), 'slot')
      const cmd = JSON.parse(decodeArg(rest.slice(idSp + 1).trim())) as Partial<InputCmd>
      h.setInput(slot, cmd)
      return JSON.stringify({ ok: true })
    }

    case 'tick': {
      const n = rest ? num(rest, 'ticks') : 1
      h.stepTicks(n)
      return JSON.stringify({ tick: h.world.tick })
    }

    case 'record_start':
      h.startRecording()
      return JSON.stringify({ ok: true })

    case 'record_stop':
      return JSON.stringify(h.stopRecording())

    case 'save':
      return JSON.stringify(h.save())

    case 'load':
      h.load(JSON.parse(decodeArg(rest)) as WorldFixture)
      return JSON.stringify({ ok: true, tick: h.world.tick })

    case 'replay':
      return JSON.stringify(replay(JSON.parse(decodeArg(rest)) as Recording))

    default:
      return runVerb(h.world, line, ctx)
  }
}
