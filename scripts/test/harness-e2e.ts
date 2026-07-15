// Full headless, deterministic e2e for the debug harness (issue #44). No phone,
// no render loop, no browser — just the real session/verb/record code driven in
// Node. Two flows:
//
//   A) Co-op through the GameHarness: create a host, join 3 bot players driven by
//      programmatic InputCmds, start, run a scenario to completion, RECORD the
//      run, then REPLAY it and assert the final state + event stream match
//      bit-for-bit. Also proves save/load fixtures.
//
//   B) Real net handshake over the loopback transport: a NetHostSession + 2
//      NetClientSession "bot joiners" complete the join → start → input↔snapshot
//      sync loop, exactly as two phones would over BLE.
//
//   npx tsx scripts/test/harness-e2e.ts

import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'
import { GameHarness } from '../../src/debug/harness'
import { flush, LoopbackHub } from '../../src/debug/loopback'
import { replay } from '../../src/debug/record'
import { emptyInput, type InputCmd } from '../../src/game/types'
import type { InputSource } from '../../src/input/input'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

// ---- A) co-op flow through the harness ----------------------------------
const harnessFlow = (): void => {
  console.log('\n== A) co-op flow through GameHarness ==')
  const h = new GameHarness()
  h.create({ seed: 20260715, classId: 'soldier', name: 'Hosty' })
  const s1 = h.addBot({ name: 'Bravo', classId: 'thief' })
  const s2 = h.addBot({ name: 'Charlie', classId: 'soldier' })
  const s3 = h.addBot({ name: 'Delta', classId: 'thief' })
  check('lobby holds host + 3 bots', h.lobby().length === 4, h.lobby().map((p) => p.name).join(','))
  check('bot slots are 1..3', s1 === 1 && s2 === 2 && s3 === 3)

  h.start()
  check('start spawns every player avatar', h.world.entities.filter((e) => e.playerCtl).length === 4)

  // Record from genesis; drive everyone into the city with weapons up.
  h.startRecording()
  h.setInput(0, { moveX: -1, attack: true })
  h.setInput(1, { moveX: -1, attack: true })
  h.setInput(2, { moveX: -1, moveY: 1, attack: true })
  h.setInput(3, { moveX: 1, attack: true })
  h.stepTicks(300)
  const rec = h.stopRecording()
  const events = rec.ticks.flatMap((t) => t.events)
  check('scenario ran 300 ticks', rec.ticks.length === 300, `tick=${h.world.tick}`)
  check('recorded a real event stream', events.length > 0, `${events.length} events (${events.filter((e) => e.type === 'death').length} deaths)`)

  // Replay determinism: same inputs ⇒ same world + events, twice.
  const r1 = replay(rec)
  const r2 = replay(rec)
  check('replay reproduces final state', r1.finalStateMatch, `mismatch at ${r1.eventMismatches.length} ticks`)
  check('replay event stream matches', r1.eventMismatches.length === 0)
  check('replay is deterministic (twice identical)', JSON.stringify(r1) === JSON.stringify(r2))
  check('replay reports ok', r1.ok)

  // Two independent recordings of the same script are byte-identical.
  const rec2 = (() => {
    const g = new GameHarness()
    g.create({ seed: 20260715, classId: 'soldier', name: 'Hosty' })
    g.addBot({ name: 'Bravo', classId: 'thief' })
    g.addBot({ name: 'Charlie', classId: 'soldier' })
    g.addBot({ name: 'Delta', classId: 'thief' })
    g.start()
    g.startRecording()
    g.setInput(0, { moveX: -1, attack: true })
    g.setInput(1, { moveX: -1, attack: true })
    g.setInput(2, { moveX: -1, moveY: 1, attack: true })
    g.setInput(3, { moveX: 1, attack: true })
    g.stepTicks(300)
    return g.stopRecording()
  })()
  check('inputs are the only entropy (recordings identical)', JSON.stringify(rec) === JSON.stringify(rec2))

  // save/load fixture round-trip.
  const fixture = h.save()
  const before = JSON.stringify(h.world.entities.map((e) => e.id).sort((a, b) => a - b))
  h.stepTicks(30)
  h.load(fixture)
  const after = JSON.stringify(h.world.entities.map((e) => e.id).sort((a, b) => a - b))
  check('save/load restores world state', before === after && h.world.tick === fixture.tick)
}

// ---- B) real net joiners over the loopback transport --------------------
const loopbackNetFlow = async (): Promise<void> => {
  console.log('\n== B) net joiners over the loopback transport ==')
  const hub = new LoopbackHub()
  const host = new NetHostSession(4242, 'soldier', 'Alice', stubInput(), hub.hostTransport)
  await host.start()

  const bots: NetClientSession[] = []
  for (const [name, cls, dir] of [
    ['Bravo', 'thief', 1],
    ['Charlie', 'soldier', -1],
  ] as const) {
    const client = hub.addCentral()
    const session = new NetClientSession(name, cls, stubInput({ moveX: dir }), client.transport)
    await session.start()
    client.connect()
    bots.push(session)
  }
  await flush()
  check('both bots joined the lobby', host.lobbyPlayers().length === 3, host.lobbyPlayers().map((p) => p.name).join(','))

  host.beginGame()
  await flush()
  check('bots dropped into the game', bots.every((b) => b.phase === 'playing'))

  for (let i = 0; i < 60; i++) {
    host.tick()
    for (const b of bots) b.tick()
    await flush()
  }
  check('host received bot inputs over the wire', (host.peersBySlot.get(1)?.lastInputSeq ?? 0) > 0)
  check('bots render their own avatar + peers', bots.every((b) => b.renderView().self !== undefined))
}

const main = async (): Promise<void> => {
  harnessFlow()
  await loopbackNetFlow()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
