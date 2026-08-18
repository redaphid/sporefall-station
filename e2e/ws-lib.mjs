// Shared harness for the WebSocket e2e proofs: boot `wrangler dev` (workerd,
// local) serving the Worker (static assets + the RoomDO relay) and wait until it
// answers, so tests can drive the REAL relay over real sockets/browsers.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Absolute path to wrangler's JS entrypoint.
 *
 * NOT `node_modules/.bin/wrangler`. That path is a POSIX shell script with no
 * extension; on Windows the executable is the sibling `wrangler.CMD`, so
 * spawning the extensionless name fails with ENOENT and every WS e2e proof was
 * unrunnable there — a harness bug that looked exactly like a broken relay.
 *
 * Resolving the package's own `bin` field instead works on every platform and
 * needs no shell: we spawn `node <entry>` directly. `wrangler/bin/wrangler.js`
 * cannot be require.resolve'd (the package's `exports` map does not expose the
 * subpath), but `wrangler/package.json` can be — so resolve that and read the
 * bin field it declares.
 */
const wranglerEntry = () => {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('wrangler/package.json')
  const { bin } = require(pkgPath)
  const rel = typeof bin === 'string' ? bin : bin.wrangler
  return resolvePath(dirname(pkgPath), rel)
}

/** Start `wrangler dev` on `port`, resolving once the Worker answers a request.
 * Returns `{ proc, stop }`; call `await stop()` to tear it down. */
export const startWrangler = async (port) => {
  const proc = spawn(process.execPath, [wranglerEntry(), 'dev', '--port', String(port)], {
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
