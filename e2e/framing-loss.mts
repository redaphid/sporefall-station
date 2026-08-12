/**
 * What one lost BLE notification does to the byte stream.
 *
 * chunkedStream.ts frames messages as [u16 LE length][payload] over an assumed
 * ORDERED, LOSSLESS byte stream, and slices them into maxPacket chunks. On BLE
 * the host→client direction is a GATT *notification* (bleTransport.ts:58,
 * `notify: true`), which is unacknowledged — if the peripheral's TX buffer is
 * full the packet is simply gone. Client→host is `writeCharacteristic` (with
 * response) and is therefore paced and reliable; the unreliable direction is
 * the one carrying every snapshot.
 *
 * This isolates the consequence, deterministically, with no timing and no RNG:
 *   A. drop a whole SINGLE-chunk message  → stream stays aligned (harmless)
 *   B. drop one chunk of a MULTI-chunk message → does the stream resync?
 *
 * Exit code is the verdict. Run: npx tsx e2e/framing-loss.mts
 */
import { frameMessage, StreamReader } from '../src/net/framing/chunkedStream'
import { MsgType } from '../src/net/types'

// The reader can only tell a real message start from payload bytes if it knows
// which first-bytes name a message. Both sessions pass this.
const VALID = new Set<number>(Object.values(MsgType) as number[])
const isValidStart = (t: number): boolean => VALID.has(t)
const reader = (): StreamReader => new StreamReader({ isValidStart })

const MAX_PACKET = 180 // bleTransport.ts MAX_PACKET

const failures: string[] = []
const check = (cond: boolean, msg: string): void => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures.push(msg)
}

/** A recognisable message of a given size: first byte is the tag, rest is filler. */
const msgOf = (tag: number, size: number): Uint8Array => {
  const m = new Uint8Array(size)
  m[0] = tag // callers pass real MsgType values so the reader accepts them
  for (let i = 1; i < size; i++) m[i] = (tag * 31 + i) & 0xff
  return m
}

/** Feed packets to a reader, optionally dropping selected global packet indices. */
const feed = (
  reader: StreamReader,
  messages: Uint8Array[],
  dropIdx: Set<number>,
): { received: Uint8Array[]; sent: number } => {
  const received: Uint8Array[] = []
  let n = 0
  for (const m of messages) {
    for (const packet of frameMessage(m, MAX_PACKET)) {
      const i = n++
      if (dropIdx.has(i)) continue
      reader.push(packet, (out) => received.push(out))
    }
  }
  return { received, sent: n }
}

console.log(`[framing-loss] BLE packet size ${MAX_PACKET}B\n`)

// ---------------------------------------------------------------- sanity
console.log('baseline (no loss)')
{
  const msgs = [msgOf(MsgType.Snapshot, 40), msgOf(MsgType.Input, 500), msgOf(MsgType.Hello, 40)]
  const { received } = feed(reader(), msgs, new Set())
  check(received.length === 3, 'all three messages arrive when nothing is dropped')
  check(
    received.length === 3 && received[0][0] === MsgType.Snapshot && received[1][0] === MsgType.Input && received[2][0] === MsgType.Hello,
    'messages arrive intact and in order',
  )
  check(received.length === 3 && received[1].length === 500, 'the 500B message reassembles from 3 packets')
}

// ------------------------------------------- A. losing a whole small message
console.log('\nA. a whole SINGLE-packet message is lost')
{
  // Three small messages, each one packet. Drop the middle packet entirely.
  const msgs = [msgOf(MsgType.Snapshot, 40), msgOf(MsgType.Input, 40), msgOf(MsgType.Hello, 40)]
  const { received } = feed(reader(), msgs, new Set([1]))
  check(received.length === 2, 'the two surviving messages still arrive')
  check(
    received.length === 2 && received[0][0] === MsgType.Snapshot && received[1][0] === MsgType.Hello,
    'the stream stays ALIGNED — message 3 is still parsed correctly after the gap',
  )
}

// ------------------------------------- B. losing one chunk of a big message
console.log('\nB. ONE packet of a MULTI-packet message is lost, then 20 good messages follow')
{
  // msg1: 500B → 3 packets (idx 0,1,2). Drop packet idx 1 (a middle chunk).
  // Then send 20 perfectly good 40B messages and see if ANY are recovered.
  const good = Array.from({ length: 20 }, (_, i) => msgOf(MsgType.Events, 40))
  const msgs = [msgOf(MsgType.Snapshot, 500), ...good]
  const { received, sent } = feed(reader(), msgs, new Set([1]))

  const goodTags = new Set(good.map((m) => m[0]))
  const recoveredGood = received.filter((m) => m.length === 40 && goodTags.has(m[0]))
  console.log(`     ${sent} packets sent, 1 dropped; reader emitted ${received.length} message(s), ${recoveredGood.length} of them correct`)
  if (received.length > 0) {
    console.log(`     first emitted message: ${received[0].length}B, tag=${received[0][0]} (expected a 40B message with tag>=100)`)
  }

  check(
    recoveredGood.length === 20,
    'the stream RESYNCS: all 20 later messages are delivered intact after one lost chunk',
  )
}

// ------------------------------- B2. how long does a bogus length prefix stall?
console.log('\nB2. does a misparsed length prefix stall the stream, and for how long?')
{
  const rd = reader()
  const good = Array.from({ length: 200 }, (_, i) => msgOf(MsgType.Events, 40))
  const msgs = [msgOf(MsgType.Snapshot, 500), ...good]
  const { received } = feed(rd, msgs, new Set([1]))
  const goodTags = new Set(good.map((m) => m[0]))
  const correct = received.filter((m) => m.length === 40 && goodTags.has(m[0])).length
  console.log(`     after 200 further messages (~${((200 * 42) / 1024).toFixed(1)}KB, ~20s of play at 10Hz): ${correct}/200 delivered correctly`)
  check(correct >= 190, 'the stream recovers within 200 messages (~20s) of one lost chunk')
}

// ------------------------------------------ C. is there any length sanity gate?
console.log('\nC. a corrupted length prefix')
{
  const rd = reader()
  // A single packet that claims a 65535-byte message.
  const bogus = new Uint8Array(180)
  bogus[0] = 0xff
  bogus[1] = 0xff
  const received: Uint8Array[] = []
  rd.push(bogus, (m) => received.push(m))
  // Now 100 perfectly good messages behind it.
  for (const m of Array.from({ length: 100 }, (_, i) => msgOf(MsgType.State, 40))) {
    for (const p of frameMessage(m, MAX_PACKET)) rd.push(p, (o) => received.push(o))
  }
  console.log(`     reader emitted ${received.length} message(s) after a 65535-byte length claim followed by 100 valid messages`)
  check(received.length > 0, 'a bogus 65535-byte length claim does not swallow every subsequent message')
}

console.log('')
if (failures.length > 0) {
  console.error(`[framing-loss] ${failures.length} FAILURE(S):`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error(
    '\n[framing-loss] Consequence on two phones: the host keeps simulating and the\n' +
      'transport link stays UP, so nothing triggers the reconnect path. The joining\n' +
      'player just watches a frozen world.',
  )
  process.exit(1)
}
console.log('[framing-loss] OK — framing survives packet loss')
process.exit(0)
