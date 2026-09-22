// Proof that a BETA build's multiplayer rooms are isolated from production's,
// through the REAL relay — `wrangler dev` (workerd) serving the Worker and its
// RoomDO Durable Object, driven over raw WebSockets.
//
// WHY THIS EXISTS: the sim is deterministic and the host is authoritative, so a
// beta peer and a production peer who land in the same room do not get a version
// warning — they DESYNC. The symptom is rubber-banding and ghost entities, which
// reads as a flaky network, and the cause (two different builds in one room) is
// invisible from inside the game. A beta build therefore prefixes its room names
// with its slug (namespaceRoom in src/app/betaSlug.ts); `/ws/:room` keys the
// Durable Object by `idFromName(room)`, so the prefix IS the isolation.
//
// The unit tests assert the string. This asserts the CONSEQUENCE: that the
// relay really does put those names in different rooms, and really does still
// put two peers on the SAME beta together.
//
//   node e2e/beta-room-isolation.mjs        (after `pnpm run build`)
//
// Env: WS_E2E_PORT (8787).

import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { startWrangler } from './ws-lib.mjs'

const PORT = Number(process.env.WS_E2E_PORT ?? 8787)
const BASE = `ws://localhost:${PORT}`

// The exact strings the two builds produce for the SAME `?room=car`:
// production ships no slug, the beta ships `<slug>~`. Written out literally
// rather than imported, so a change to namespaceRoom has to be made on purpose
// in two places instead of silently agreeing with itself.
const PROD_ROOM = 'car'
const BETA_ROOM = 'betas-path~car'
const OTHER_BETA_ROOM = 'other-beta~car'

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    failures.push(msg)
  }
}

/** Open a relay socket and collect the control frames it receives. */
const openPeer = async (role, room) => {
  const ws = new WebSocket(`${BASE}/ws/${encodeURIComponent(room)}?role=${role}`)
  const controls = []
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    try {
      controls.push(JSON.parse(raw.toString()))
    } catch {
      /* not a control frame */
    }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, controls, sawPeer: () => controls.some((c) => c.t === 'peer+') }
}

const main = async () => {
  console.log('[beta-rooms] starting wrangler dev (real RoomDO)…')
  const wrangler = await startWrangler(PORT)
  const sockets = []
  try {
    // 1. Two players on the SAME beta must meet. If the prefix broke this, the
    //    beta would be unreviewable for multiplayer — the failure mode of an
    //    over-eager namespacing scheme.
    const betaHost = await openPeer('host', BETA_ROOM)
    const betaClient = await openPeer('client', BETA_ROOM)
    sockets.push(betaHost.ws, betaClient.ws)
    await sleep(1500)
    check(betaHost.sawPeer(), 'two peers on the SAME beta room join the same relay room')

    // 2. A production player in the bare room must NOT reach the beta host.
    const prodClient = await openPeer('client', PROD_ROOM)
    sockets.push(prodClient.ws)
    await sleep(1500)
    check(
      betaHost.controls.filter((c) => c.t === 'peer+').length === 1,
      'a PRODUCTION peer in room "car" never reaches the beta host (no second peer+)',
    )
    check(
      prodClient.controls.every((c) => c.t !== 'host+'),
      'the production peer sees no host — the beta host is in a different room entirely',
    )

    // 3. Two DIFFERENT betas must not meet each other either.
    const otherClient = await openPeer('client', OTHER_BETA_ROOM)
    sockets.push(otherClient.ws)
    await sleep(1500)
    check(
      betaHost.controls.filter((c) => c.t === 'peer+').length === 1,
      'a peer from a DIFFERENT beta never reaches this beta host',
    )
    check(otherClient.controls.every((c) => c.t !== 'host+'), 'the other beta sees no host of its own')
  } finally {
    for (const ws of sockets) {
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
    await sleep(300)
    await wrangler.stop()
  }

  if (failures.length) {
    console.error(`\n[beta-rooms] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[beta-rooms] OK — beta rooms are isolated from production and from each other')
}

await main()
