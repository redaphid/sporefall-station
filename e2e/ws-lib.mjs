// Shared harness for the WebSocket e2e proofs: boot `wrangler dev` (workerd,
// local) serving the Worker (static assets + the RoomDO relay) and wait until it
// answers, so tests can drive the REAL relay over real sockets/browsers.

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/** Start `wrangler dev` on `port`, resolving once the Worker answers a request.
 * Returns `{ proc, stop }`; call `await stop()` to tear it down. */
export const startWrangler = async (port) => {
  const proc = spawn('node_modules/.bin/wrangler', ['dev', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  })
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))

  const stop = async () => {
    proc.kill('SIGINT')
    await sleep(300)
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  // The GET /ota/check route (a Worker route) answering proves the Worker is live.
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/ota/check`)
      if (res.ok) return { proc, stop }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  console.error(log)
  await stop()
  throw new Error('wrangler dev did not come up in time')
}
