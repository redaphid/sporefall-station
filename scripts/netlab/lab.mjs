// Network-impairment lab: the relay Worker (wrangler dev), a static page server
// and headless Chromium all run inside one unprivileged user+net+pid namespace,
// where netem on `lo` impairs relay TCP and WebRTC UDP independently.
// See README.md for the traversal math.
//
// API (call enterNetns() first; it re-execs the calling script inside the netns):
//   await enterNetns()
//   const lab = await startLab({ dir, relayPort, staticPort, staticRoot })
//   const { host, guest } = await lab.openPages(url)
//   await lab.impair({ relayDelayMs, relayLossPct, udpDelayMs, udpLossPct })
//   await lab.impair(profileToImpairment({ relay: { rttMs, lossPct }, udp: { rttMs, lossPct } }))
//   await lab.stop()
//
// CLI:
//   node scripts/netlab/lab.mjs up                      hold a lab open, serve the control socket
//   node scripts/netlab/lab.mjs ctl [k=v ...]           show / change impairment of a running lab
//     keys: relayDelayMs relayLossPct udpDelayMs udpLossPct  (per traversal)
//           relayRttMs relayOneWayLossPct udpRttMs udpOneWayLossPct  (end to end)

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const TC = '/usr/sbin/tc'
const IP = '/usr/sbin/ip'
export const LAN_IP = '10.77.0.1'

export const CLEAN = Object.freeze({ relayDelayMs: 0, relayLossPct: 0, udpDelayMs: 0, udpLossPct: 0 })

/** Traversals of `lo` per class: a relayed message goes page->relay->page (2), a P2P datagram goes page->page (1). */
const ONE_WAY_TRAVERSALS = { relay: 2, udp: 1 }

/**
 * End-to-end profile -> per-traversal netem values.
 * rttMs is added round-trip time; lossPct is end-to-end ONE-WAY loss.
 */
export const profileToImpairment = ({ relay = {}, udp = {} } = {}) => {
  const per = (cls, { rttMs = 0, lossPct = 0 }) => {
    const n = ONE_WAY_TRAVERSALS[cls]
    return { delayMs: rttMs / (2 * n), lossPct: 100 * (1 - (1 - lossPct / 100) ** (1 / n)) }
  }
  const r = per('relay', relay)
  const u = per('udp', udp)
  const round = (x) => Math.round(x * 1e4) / 1e4
  return { relayDelayMs: round(r.delayMs), relayLossPct: round(r.lossPct), udpDelayMs: round(u.delayMs), udpLossPct: round(u.lossPct) }
}

const parseImpairment = (raw) => {
  const out = { ...CLEAN }
  for (const k of Object.keys(out)) {
    if (raw[k] === undefined) continue
    const v = Number(raw[k])
    if (!Number.isFinite(v) || v < 0 || (k.endsWith('LossPct') && v > 100)) throw new RangeError(`bad ${k}: ${raw[k]}`)
    out[k] = v
  }
  return out
}

/** Re-exec the current script inside a fresh user+net+pid namespace. Resolves only inside it. */
export const enterNetns = async () => {
  if (process.env.NETLAB_INNER === '1') return
  const child = spawn(
    '/usr/sbin/unshare',
    ['--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--kill-child',
      process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, NETLAB_INNER: '1' } },
  )
  // unshare does not relay signals, so signal the netns init (our re-exec'd self)
  // directly. SIGKILL on unshare is the backstop: --kill-child takes down init,
  // and the kernel then kills every process left in the pid namespace.
  const forward = (sig) => {
    const kids = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
    for (const pid of kids) process.kill(Number(pid), sig)
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => forward(sig))
  const code = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)))
  process.exit(code)
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

const setupNetwork = (relayPort) => {
  run(IP, ['link', 'set', 'lo', 'up'])
  run(IP, ['link', 'add', 'lan0', 'type', 'dummy'])
  // No IPv6 link-local on lan0, so WebRTC's only host candidate is LAN_IP.
  run(IP, ['link', 'set', 'lan0', 'addrgenmode', 'none'])
  run(IP, ['addr', 'add', `${LAN_IP}/24`, 'dev', 'lan0'])
  run(IP, ['link', 'set', 'lan0', 'up'])
  // Without media permission Chromium gathers ICE only on the default-route
  // address, found by routing toward a public IP. No route, no candidates.
  run(IP, ['route', 'add', 'default', 'dev', 'lan0'])
  const tc = (...a) => run(TC, a)
  tc('qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '4', 'priomap', ...Array(16).fill('0'))
  tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:2', 'handle', '20:', 'netem', 'delay', '0ms', 'limit', '10000')
  tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', 'netem', 'delay', '0ms', 'limit', '10000')
  // A filter priority holds one protocol, so IPv4 takes prio 1-2 and IPv6 prio 3-4.
  for (const [proto, sel, prio] of [['ip', 'ip', 1], ['ipv6', 'ip6', 3]]) {
    for (const dir of ['sport', 'dport']) {
      tc('filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', proto, 'prio', String(prio), 'u32',
        'match', sel, 'protocol', '6', '0xff', 'match', sel, dir, String(relayPort), '0xffff', 'flowid', '1:2')
    }
    tc('filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', proto, 'prio', String(prio + 1), 'u32',
      'match', sel, 'protocol', '17', '0xff', 'flowid', '1:3')
  }
}

const applyImpairment = (imp) => {
  const netem = (handle, parent, delayMs, lossPct) =>
    run(TC, ['qdisc', 'change', 'dev', 'lo', 'parent', parent, 'handle', handle, 'netem',
      'delay', `${delayMs}ms`, 'loss', `${lossPct}%`, 'limit', '10000'])
  netem('20:', '1:2', imp.relayDelayMs, imp.relayLossPct)
  netem('30:', '1:3', imp.udpDelayMs, imp.udpLossPct)
}

const qdiscStats = () => run(TC, ['-s', 'qdisc', 'show', 'dev', 'lo'])

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm' }

const serveStatic = (root, port) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      const file = path.join(root, rel.endsWith('/') ? `${rel}index.html` : rel)
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      fs.createReadStream(file).pipe(res)
    })
    server.listen(port, '0.0.0.0', () => resolve(server))
  })

// A unix socket path is capped at 108 bytes and the scratch dir alone can be
// longer, so bind and connect through a /proc fd link to the directory.
const shortSockPath = (dir) => `/proc/self/fd/${fs.openSync(dir, 'r')}/ctl.sock`

/** Write a wrangler config into `dir` so wrangler's .wrangler/ cache and state land there, not in the repo. */
const wranglerConfig = (dir) => {
  const cfg = vm.runInNewContext(`(${fs.readFileSync(path.join(REPO, 'wrangler.jsonc'), 'utf8')})`)
  delete cfg.$schema
  delete cfg.routes
  cfg.main = path.join(REPO, cfg.main)
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  cfg.assets = { ...cfg.assets, directory: path.join(dir, 'assets') }
  const file = path.join(dir, 'wrangler.json')
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  return file
}

const waitFor = async (what, probe, ms, alive = () => true) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive()) throw new Error(`${what}: process exited`)
    if (await probe().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${what}: not ready after ${ms} ms`)
}

/**
 * Start the lab. Must run inside enterNetns().
 * @param {{ dir?: string, relayPort?: number, staticPort?: number, staticRoot?: string, headless?: boolean }} [opts]
 */
export const startLab = async (opts = {}) => {
  if (process.env.NETLAB_INNER !== '1') throw new Error('startLab() must run inside enterNetns()')
  const {
    dir = process.env.NETLAB_DIR ?? path.join(os.tmpdir(), 'sporefall-netlab'),
    relayPort = 8787,
    staticPort = 8790,
    staticRoot = HERE,
    headless = true,
  } = opts
  fs.mkdirSync(dir, { recursive: true })
  setupNetwork(relayPort)

  const children = []
  /** Spawn a helper in its own process group so stop() can kill exactly it and its descendants. */
  const spawnTracked = (name, cmd, args, extra = {}) => {
    const log = fs.openSync(path.join(dir, `${name}.log`), 'w')
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', log, log], ...extra })
    child.on('exit', () => { child.exited = true })
    children.push(child)
    return child
  }

  const wrangler = spawnTracked('wrangler', process.execPath, [
    path.join(REPO, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
    '--config', wranglerConfig(dir), '--ip', '0.0.0.0', '--port', String(relayPort),
    '--persist-to', path.join(dir, 'state'), '--show-interactive-dev-session=false', '--log-level', 'warn',
  ], {
    cwd: dir,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', NO_UPDATE_NOTIFIER: '1', CI: '1' },
  })

  const staticServer = await serveStatic(path.resolve(staticRoot), staticPort)
  let current
  const setImpairment = (raw) => {
    current = parseImpairment(raw)
    applyImpairment(current)
    return { impairment: current, qdisc: qdiscStats() }
  }
  setImpairment(CLEAN)

  const ctlPath = shortSockPath(dir)
  const ctl = http.createServer(async (req, res) => {
    try {
      let body = ''
      for await (const c of req) body += c
      const msg = req.method === 'POST' ? JSON.parse(body || '{}') : null
      const out = msg ? setImpairment(msg.profile ? profileToImpairment(msg.profile) : msg) : { impairment: current, qdisc: qdiscStats() }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    } catch (e) {
      res.writeHead(400).end(JSON.stringify({ error: String(e.message ?? e) }))
    }
  })
  try { fs.unlinkSync(path.join(dir, 'ctl.sock')) } catch { /* fresh */ }
  await new Promise((r) => ctl.listen(ctlPath, r))
  fs.writeFileSync(path.join(dir, 'lab.json'), JSON.stringify({ dir, relayPort, staticPort, lanIp: LAN_IP }))

  await waitFor('wrangler dev', async () => (await fetch(`http://127.0.0.1:${relayPort}/ws/ready`)).status === 426, 90_000, () => !wrangler.exited)

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  })

  let stopped = false
  const lab = {
    dir,
    lanIp: LAN_IP,
    relayPort,
    staticOrigin: `http://127.0.0.1:${staticPort}`,
    relayHttp: `http://${LAN_IP}:${relayPort}`,
    relayWs: (room, role) => `ws://${LAN_IP}:${relayPort}/ws/${encodeURIComponent(room)}?role=${role}`,
    browser,
    /** Two isolated browser contexts (separate storage), one page each. */
    openPages: async (hostUrl, guestUrl = hostUrl) => {
      const open = async (url) => {
        const page = await (await browser.newContext()).newPage()
        await page.goto(url)
        return page
      }
      const [host, guest] = await Promise.all([open(hostUrl), open(guestUrl)])
      return { host, guest }
    },
    /** Set per-traversal impairment (missing keys = 0). Returns the applied values and `tc -s qdisc` output. */
    impair: async (imp) => setImpairment(imp),
    qdisc: qdiscStats,
    /** Run another helper (e.g. a vite dev server) that stop() will kill. */
    spawn: spawnTracked,
    stop: async () => {
      if (stopped) return
      stopped = true
      await browser.close().catch(() => {})
      ctl.close()
      staticServer.close()
      for (const c of children) {
        if (!c.exited) try { process.kill(-c.pid, 'SIGTERM') } catch { /* gone */ }
      }
      await waitFor('children exit', async () => children.every((c) => c.exited), 5000).catch(() => {
        for (const c of children) if (!c.exited) try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ }
      })
    },
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => lab.stop().finally(() => process.exit(130)))
  return lab
}

/** HTTP request to a running lab's control socket (works from outside the netns). */
export const control = (dir, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: shortSockPath(dir), path: '/', method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } },
      async (res) => {
        let s = ''
        for await (const c of res) s += c
        const out = JSON.parse(s)
        if (out.error) reject(new Error(out.error))
        else resolve(out)
      },
    )
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })

const PROFILE_KEYS = { relayRttMs: ['relay', 'rttMs'], relayOneWayLossPct: ['relay', 'lossPct'], udpRttMs: ['udp', 'rttMs'], udpOneWayLossPct: ['udp', 'lossPct'] }

const cli = async () => {
  const [cmd, ...rest] = process.argv.slice(2)
  const dir = process.env.NETLAB_DIR ?? path.join(os.tmpdir(), 'sporefall-netlab')
  if (cmd === 'up') {
    await enterNetns()
    const lab = await startLab({ dir })
    console.log(`netlab up. pages: ${lab.staticOrigin}/  relay: ws://${lab.lanIp}:${lab.relayPort}/ws/<room>?role=host|client`)
    console.log(`control: NETLAB_DIR=${dir} node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))} ctl relayRttMs=110`)
    await new Promise(() => {})
  } else if (cmd === 'ctl') {
    const kv = Object.fromEntries(rest.map((a) => a.split('=')))
    const profileKeys = Object.keys(kv).filter((k) => k in PROFILE_KEYS)
    let body
    if (profileKeys.length) {
      const profile = { relay: {}, udp: {} }
      for (const k of profileKeys) profile[PROFILE_KEYS[k][0]][PROFILE_KEYS[k][1]] = Number(kv[k])
      body = { profile }
    } else if (rest.length) body = kv
    const out = await control(dir, body)
    console.log(JSON.stringify(out.impairment))
    console.log(out.qdisc)
  } else {
    console.error('usage: lab.mjs up | lab.mjs ctl [key=value ...]')
    process.exit(2)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli()
