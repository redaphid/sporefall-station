// Proves the CLI/MCP → hub → harness path over a REAL WebSocket: start the hub,
// attach a GameHarness backend via startHarnessChannel (registers as `game`),
// then drive a whole session as a `debugger` client — create, join bots, start,
// tick, record, replay — exactly what `tools/debug-cli/cli.ts` sends.
//
//   npx tsx scripts/test/harness-channel-smoke.ts

import { startHarnessChannel } from '../../src/debug/channel'
import { GameHarness } from '../../src/debug/harness'
import { hubUrl, encodeArg } from '../../src/debug/protocol'
import { startHub } from '../../tools/debug-hub/hub'
import { connectDebugger } from '../../tools/debug-client'

const PORT = Number(process.env.SMOKE_PORT ?? 7896)
const URL = hubUrl('127.0.0.1', PORT)

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const main = async (): Promise<void> => {
  const hub = startHub(PORT, () => {})
  const harness = new GameHarness()
  const channel = startHarnessChannel(harness, URL, () => {})
  await sleep(150) // let the backend register with the hub

  const dbg = await connectDebugger(URL)
  const events: Array<{ type?: string }> = []
  dbg.onEvent((e) => events.push(e as { type?: string }))

  check('create returns lobby', JSON.parse(await dbg.raw('create soldier 20260715 Hosty')).phase === 'lobby')
  check('join_bot assigns slot 1', JSON.parse(await dbg.raw('join_bot Bravo soldier')).slot === 1)
  check('join_bot assigns slot 2', JSON.parse(await dbg.raw('join_bot Charlie soldier')).slot === 2)
  check('lobby lists 3 players', (JSON.parse(await dbg.raw('lobby')) as unknown[]).length === 3)
  check('start_run flips to playing', JSON.parse(await dbg.raw('start_run')).phase === 'playing')

  await dbg.raw('record_start')
  await dbg.raw(`input 0 ${encodeArg('{"moveX":-1,"attack":true}')}`)
  await dbg.raw(`input 1 ${encodeArg('{"moveX":-1,"attack":true}')}`)
  check('tick advances the sim', JSON.parse(await dbg.raw('tick 200')).tick === 200)

  const state = JSON.parse(await dbg.raw('state')) as { tick: number; seed: number }
  check('world state visible via fallthrough verb', state.tick === 200 && state.seed === 20260715)

  const recording = await dbg.raw('record_stop')
  const replayResult = JSON.parse(await dbg.raw(`replay ${encodeArg(recording)}`)) as { ok: boolean }
  check('replay of the recorded session is deterministic', replayResult.ok)

  await sleep(50)
  check('sim events streamed to the debugger', events.length > 0, `${events.length} events`)

  channel.stop()
  dbg.close()
  hub.close()
  await sleep(50)
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
