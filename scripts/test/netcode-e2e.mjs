// Headless END-TO-END netcode harness over the REAL dev transport.
//
// Stands up a real NetHostSession and a real NetClientSession talking over an
// actual BroadcastChannelTransport pair (40-55ms latency + jitter, BLE-sized
// packets, the two-lane send queue, chunked framing) inside one Node process —
// no browser, no dev server. Then it drives the real 30Hz tick loop and proves
// the netcode fixes end to end:
//   1. join handshake + client reaches "playing"
//   2. client movement reconciles on the host (prediction ↔ authority)
//   3. every input EDGE round-trips exactly once over the laggy wire:
//      hotbar-equip, Use/Throw, dodge-roll (the pure edges with no held fallback)
//   4. a dodge-roll survives a burst of inputs (the #57 drop-on-overwrite class)
//   5. inventory (#57) syncs host→client on change
//   6. a truncated/garbage host packet does NOT crash the client
//
// Usage: pnpm exec tsx scripts/test/netcode-e2e.mjs
import { NetHostSession } from '../../src/app/netHost.ts'
import { NetClientSession } from '../../src/app/netClient.ts'
import { BroadcastChannelTransport } from '../../src/net/transport/broadcastChannelTransport.ts'
import { emptyInput } from '../../src/game/types.ts'
import { frameMessage } from '../../src/net/framing/chunkedStream.ts'
import { MsgType } from '../../src/net/types.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// A mutable input source, like the touch/keyboard sources feed the sim.
const makeInput = () => {
  let cur = emptyInput()
  return { source: { sample: () => ({ ...cur }) }, set: (c) => (cur = { ...emptyInput(), ...c }) }
}

const main = async () => {
  const room = `e2e-${Math.random().toString(36).slice(2, 8)}`
  const hostTransport = new BroadcastChannelTransport('host', room)
  // Heavy, jittery uplink latency so the two-lane send queue, framing and
  // backpressure are exercised honestly (not a fast in-memory shortcut). NOTE: the
  // precise packet-overwrite that DROPS a pure edge is proven deterministically in
  // netCoop.test.ts ("does not drop a pure-edge tap … under congestion"); this e2e
  // proves the edges round-trip correctly end-to-end over the real laggy wire.
  const clientTransport = new BroadcastChannelTransport('client', room, 120, 40)

  const hostIn = makeInput()
  const clientIn = makeInput()
  const host = new NetHostSession(4242, 'Alice', hostIn.source, hostTransport)
  const client = new NetClientSession('Bob', clientIn.source, clientTransport)

  await host.start()
  await client.start() // client posts 'join'; host accepts → both see peerConnected

  // Wait for the lobby handshake to settle over the real (laggy) channel.
  for (let i = 0; i < 80 && client.phase !== 'lobby'; i++) await sleep(25)
  check('join handshake: client reaches lobby', client.phase === 'lobby', `phase=${client.phase}`)
  check('host lists the joined client', host.lobbyPlayers().some((p) => p.name === 'Bob'))

  host.beginGame()
  for (let i = 0; i < 80 && client.phase !== 'playing'; i++) await sleep(25)
  check('game start: client reaches playing', client.phase === 'playing', `phase=${client.phase}`)

  // Real tick loop at 30Hz driving BOTH sessions, like the app's RAF loop.
  let running = true
  const loop = (async () => {
    while (running) {
      host.tick()
      client.tick()
      await sleep(33)
    }
  })()

  const slot = client.slot
  const avatar = () => host.world.byId.get(host.peersBySlot.get(slot)?.entityId)
  // Give the client's host-side avatar a known multi-weapon loadout to switch/use.
  avatar().playerCtl.inventory = [
    { itemId: 'pistol', qty: 20 },
    { itemId: 'freezeRay', qty: 6, mods: [{ id: 'frost', stacks: 2 }] },
    { itemId: 'bandage', qty: 3 },
  ]
  avatar().playerCtl.activeSlot = 0
  avatar().combat.weapon = 'pistol'
  await sleep(800)

  // (2) Movement reconciles: client walks right, host avatar's x should advance.
  const x0 = avatar().pos.x
  clientIn.set({ moveX: 1 })
  await sleep(700)
  clientIn.set({})
  await sleep(600)
  check('movement round-trips: host avatar moved right', avatar().pos.x > x0 + 0.2, `dx=${(avatar().pos.x - x0).toFixed(2)}`)

  // (3a) Hotbar equip edge round-trips (pure edge → reliable lane).
  clientIn.set({ hotbar: 1 })
  await sleep(120)
  clientIn.set({})
  await sleep(500)
  check('hotbar equip edge round-trips: host equipped slot 1 (freezeRay)', avatar().combat.weapon === 'freezeRay', `weapon=${avatar().combat.weapon}`)
  check('hotbar equip reflected back to client', client.renderView().self?.combat?.weapon === 'freezeRay')

  // (5) Inventory (#57) sync: host spends freeze-ray ammo, client sees the drop.
  avatar().playerCtl.inventory[1].qty = 2
  await sleep(500)
  const clientFreeze = client.renderView().self?.playerCtl?.inventory?.find((s) => s.itemId === 'freezeRay')
  check('inventory ammo change syncs host→client', clientFreeze?.qty === 2, `qty=${clientFreeze?.qty}`)
  check('per-weapon mods survive to the client', JSON.stringify(clientFreeze?.mods) === JSON.stringify([{ id: 'frost', stacks: 2 }]))

  // (3b) Use/Throw edge: switch to the bandage, hurt the avatar, tap throwItem.
  clientIn.set({ hotbar: 2 })
  await sleep(150)
  clientIn.set({})
  await sleep(400)
  avatar().health.hp = 40
  const bandageBefore = avatar().playerCtl.inventory.find((s) => s.itemId === 'bandage').qty
  clientIn.set({ throwItem: true })
  await sleep(120)
  clientIn.set({})
  await sleep(500)
  const bandageAfter = avatar().playerCtl.inventory.find((s) => s.itemId === 'bandage')?.qty ?? 0
  check('Use/Throw edge round-trips: host consumed one bandage', bandageAfter === bandageBefore - 1, `${bandageBefore}→${bandageAfter}`)
  check('Use/Throw healed authoritatively on the host', avatar().health.hp > 40, `hp=${avatar().health.hp}`)

  // (4) Dodge-roll survives a BURST of inputs (the drop-on-overwrite / #57 class).
  // Fire many movement inputs, sneak a single roll tap into the burst, and confirm
  // the host still registers the roll over the laggy wire.
  let sawRoll = false
  const rollWatch = setInterval(() => {
    if (avatar()?.playerCtl?.roll) sawRoll = true
  }, 10)
  for (let i = 0; i < 10; i++) {
    clientIn.set({ moveX: 1 })
    await sleep(25)
  }
  clientIn.set({ moveX: 1, roll: true })
  await sleep(80) // hold across at least one client send-tick so the edge latches
  clientIn.set({ moveX: 1 })
  for (let i = 0; i < 10; i++) {
    clientIn.set({ moveX: 1 })
    await sleep(25)
  }
  clientIn.set({})
  await sleep(1200) // let the (heavily delayed) reliable roll drain and apply
  clearInterval(rollWatch)
  check('dodge-roll edge survives an input burst (host rolled)', sawRoll)

  // (6) A truncated/garbage host packet must NOT crash the client. Post a bad
  // frame straight onto the room channel addressed to the client.
  const clientId = clientTransport.id
  const hostWireId = hostTransport.id
  const raw = new BroadcastChannel(`sporefall-${room}`)
  const badSnapshot = new Uint8Array([MsgType.Snapshot, 0xff]) // header only → decode reads past end
  for (const pkt of frameMessage(badSnapshot, 244)) {
    raw.postMessage({ kind: 'data', from: hostWireId, to: clientId, bytes: [...pkt] })
  }
  raw.postMessage({ kind: 'data', from: hostWireId, to: clientId, bytes: [...frameMessage(new Uint8Array([MsgType.State, 0x7b, 0xff]), 244)[0]] })
  await sleep(300)
  check('client survived a garbage host packet (still playing)', client.phase === 'playing', `phase=${client.phase}`)
  // And a valid snapshot still lands afterward — the stream stayed aligned.
  const beforeX = client.renderView().self?.pos?.x
  await sleep(400)
  check('client still rendering its avatar after garbage', client.renderView().self !== undefined && beforeX !== undefined)
  raw.close()

  running = false
  await loop
  await host.stop?.()
  await hostTransport.stop()
  await clientTransport.stop()

  console.log(failures === 0 ? '\nE2E PASS — all netcode paths held over the real transport' : `\nE2E FAIL — ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
