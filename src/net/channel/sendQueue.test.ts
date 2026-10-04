import { describe, expect, it } from 'vitest'
import type { PeerId, Transport } from '../types'
import { SendQueue } from './sendQueue'

/** A transport whose sends finish only when the test says so. */
const heldTransport = () => {
  const pending: (() => void)[] = []
  let sent = 0
  const transport: Transport = {
    role: 'host',
    maxPacket: 180,
    start: async () => {},
    stop: async () => {},
    sendPacket: (_peer: PeerId, _bytes: Uint8Array) =>
      new Promise<void>((resolve) =>
        pending.push(() => {
          sent++
          resolve()
        }),
      ),
    on: () => () => {},
    peers: () => ['p'],
  }
  return { transport, releaseOne: () => pending.shift()?.(), sent: () => sent }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const settled = async (p: Promise<void>): Promise<boolean> => {
  let done = false
  void p.then(() => (done = true))
  await tick()
  return done
}

describe('SendQueue.flushed', () => {
  it('resolves at once on an idle queue', async () => {
    const q = new SendQueue(heldTransport().transport, 'p', () => {})
    expect(await settled(q.flushed())).toBe(true)
  })

  it('resolves only once everything queued has gone to the transport', async () => {
    const t = heldTransport()
    const q = new SendQueue(t.transport, 'p', () => {})
    q.queueReliable(new Uint8Array([20, 1]))
    q.queueReliable(new Uint8Array([20, 2]))
    const flushed = q.flushed()
    expect(await settled(flushed)).toBe(false)
    t.releaseOne()
    expect(await settled(flushed)).toBe(false)
    t.releaseOne()
    expect(await settled(flushed)).toBe(true)
    expect(t.sent()).toBe(2)
  })

  it('resolves when the queue is stopped while a send hangs, so a leaving host is never stuck', async () => {
    const t = heldTransport() // the send below never completes
    const q = new SendQueue(t.transport, 'p', () => {})
    q.queueReliable(new Uint8Array([20, 1]))
    const flushed = q.flushed()
    expect(await settled(flushed)).toBe(false)
    q.stop()
    expect(await settled(flushed)).toBe(true)
  })
})
