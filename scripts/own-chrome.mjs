#!/usr/bin/env node
// Launch and kill a Windows Chrome that this tool owns, from WSL, for CDP driving.
//
//   node scripts/own-chrome.mjs launch [--dir D] [--url U] [--port P]   prints the lock as JSON
//   node scripts/own-chrome.mjs kill <lockfile>
//   node scripts/own-chrome.mjs list [--dir D]
//
// Lockfiles live in --dir, else $OWN_CHROME_DIR, else <tmpdir>/own-chrome.
//
// It exists because agents took down the owner's personal Chrome twice: once by
// attaching to it on :9222, once by killing every chrome.exe whose command line
// matched a profile-name substring that a quoting bug had cut down to `C:`.
// So: port 9222 is refused everywhere, a kill targets only the recorded PID tree,
// and only after Windows confirms that PID's own command line carries this lock's
// exact port flag and exact profile dir. Nothing here matches processes by name
// or pattern. Every child process gets an argv array and no shell option; the
// PowerShell scripts are fixed text whose only inputs are an integer PID or
// base64 JSON.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHROME_EXE = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
export const PERSONAL_CDP_PORT = 9222
export const PORT_MIN = 9300
export const PORT_MAX = 9999
const PROFILE_PREFIX = 'own-chrome-'
const POWERSHELL = 'powershell.exe'
const TASKKILL = 'taskkill.exe'

export const defaultLockDir = () => process.env.OWN_CHROME_DIR ?? join(tmpdir(), 'own-chrome')

/** Throws unless `port` is one this tool may launch on. 9222 gets its own message. */
export const assertPortAllowed = (port) => {
  if (port === PERSONAL_CDP_PORT)
    throw new Error(`port ${PERSONAL_CDP_PORT} is the owner's personal Chrome; own-chrome never launches on or attaches to it`)
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX)
    throw new Error(`port ${port} is outside ${PORT_MIN}-${PORT_MAX}`)
}

/** Throws when a CDP endpoint is the owner's personal Chrome. For anything that connects over CDP. */
export const assertNotPersonalChrome = (cdpUrl) => {
  const { port } = new URL(cdpUrl)
  if (Number(port) === PERSONAL_CDP_PORT)
    throw new Error(`refusing to attach to ${cdpUrl}: :${PERSONAL_CDP_PORT} is the owner's personal Chrome. Launch your own with scripts/own-chrome.mjs`)
}

/** First allowed port at or after `start` (wrapping) that `isFree` accepts. */
export const pickPort = async (isFree, start = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1))) => {
  const span = PORT_MAX - PORT_MIN + 1
  for (let i = 0; i < span; i++) {
    const port = PORT_MIN + ((start - PORT_MIN + i) % span)
    if (await isFree(port)) return port
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`)
}

export const chromeArgv = ({ port, profileDir, url = 'about:blank' }) => {
  assertPortAllowed(port)
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A tab that is not in front stops its frame loop, and the sim with it.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1320,860',
    '--window-position=40,40',
    url,
  ]
}

export const taskkillArgv = (pid) => ['/PID', String(pid), '/T', '/F']

/** Windows profile dir for a new launch: unique, directly under the Windows temp dir. */
const newProfileDir = (winTempDir, port) => `${winTempDir}\\${PROFILE_PREFIX}${port}-${randomBytes(6).toString('hex')}`

const isOwnProfileDir = (profileDir, winTempDir) => {
  const prefix = `${winTempDir}\\`
  return profileDir.startsWith(prefix) && /^own-chrome-\d{4}-[0-9a-f]{12}$/.test(profileDir.slice(prefix.length))
}

/**
 * A lockfile's JSON, validated. Anything a kill acts on (pid, port, profile dir)
 * must be shaped exactly as `launch` writes it, so a hand-edited or truncated
 * lock (a profile dir of `C:`) is refused rather than trusted.
 */
export const parseLock = (raw, winTempDir) => {
  const lock = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0) throw new Error(`lock pid ${lock?.pid} is not a positive integer`)
  assertPortAllowed(lock.port)
  if (typeof lock.profileDir !== 'string' || !isOwnProfileDir(lock.profileDir, winTempDir))
    throw new Error(`lock profileDir ${JSON.stringify(lock.profileDir)} is not an own-chrome profile under ${winTempDir}`)
  if (typeof lock.startedAt !== 'string') throw new Error('lock startedAt missing')
  return { pid: lock.pid, port: lock.port, profileDir: lock.profileDir, startedAt: lock.startedAt, cdpUrl: `http://127.0.0.1:${lock.port}` }
}

/** Split a Windows command line the way CommandLineToArgvW does. */
export const splitWindowsCommandLine = (cmd) => {
  const args = []
  let cur = ''
  let inArg = false
  let quoted = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '\\') {
      let n = 0
      while (cmd[i] === '\\') {
        n++
        i++
      }
      if (cmd[i] === '"') {
        cur += '\\'.repeat(n >> 1)
        if (n % 2) cur += '"'
        else quoted = !quoted
      } else {
        cur += '\\'.repeat(n)
        i--
      }
      inArg = true
    } else if (c === '"') {
      if (quoted && cmd[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = !quoted
      inArg = true
    } else if ((c === ' ' || c === '\t') && !quoted) {
      if (inArg) args.push(cur)
      cur = ''
      inArg = false
    } else {
      cur += c
      inArg = true
    }
  }
  if (inArg) args.push(cur)
  return args
}

/**
 * Is the live process `proc` ({pid, commandLine} from Windows) the browser this
 * lock recorded? Whole-argument equality only: `--remote-debugging-port=93` does
 * not match `--remote-debugging-port=9301`, and a renderer child (`--type=...`)
 * is not the browser root.
 */
export const checkOwnership = (lock, proc) => {
  if (proc.pid !== lock.pid) return { ok: false, reason: `asked about pid ${lock.pid}, Windows answered for ${proc.pid}` }
  if (typeof proc.commandLine !== 'string' || !proc.commandLine) return { ok: false, reason: `pid ${lock.pid} command line is unreadable` }
  const argv = splitWindowsCommandLine(proc.commandLine)
  const want = [`--remote-debugging-port=${lock.port}`, `--user-data-dir=${lock.profileDir}`]
  const missing = want.filter((a) => !argv.includes(a))
  if (missing.length) return { ok: false, reason: `pid ${lock.pid} command line lacks ${missing.join(' and ')}` }
  if (argv.some((a) => a.startsWith('--type='))) return { ok: false, reason: `pid ${lock.pid} is a Chrome child process, not the browser` }
  return { ok: true }
}

/** Run a fixed PowerShell script. -EncodedCommand keeps its text out of any argv quoting. */
export const powershell = (body) => {
  const script = `$ProgressPreference='SilentlyContinue'; ${body}`
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** One argument quoted so CommandLineToArgvW (and `splitWindowsCommandLine`) reads it back unchanged. */
export const quoteWindowsArg = (arg) => {
  if (arg && !/[\s"]/.test(arg)) return arg
  let out = '"'
  for (let i = 0; i < arg.length; i++) {
    let n = 0
    while (arg[i] === '\\') {
      n++
      i++
    }
    if (i === arg.length) out += '\\'.repeat(n * 2)
    else if (arg[i] === '"') out += '\\'.repeat(n * 2 + 1) + '"'
    else out += '\\'.repeat(n) + arg[i]
  }
  return out + '"'
}

export const windowsCommandLine = (argv) => argv.map(quoteWindowsArg).join(' ')

/**
 * Ports in our range that are taken, from Windows' own view: line one is the
 * listening ports joined by commas, the rest is `netsh ... excludedportrange`
 * (start/end rows), which Chrome cannot bind either.
 */
export const parseBusyPorts = (text) => {
  const [listeners = '', ...netsh] = text.split(/\r?\n/)
  const ranges = listeners.split(',').filter(Boolean).map((p) => [Number(p), Number(p)])
  for (const line of netsh) {
    const row = /^\s*(\d+)\s+(\d+)/.exec(line)
    if (row) ranges.push([Number(row[1]), Number(row[2])])
  }
  const busy = new Set()
  for (const [lo, hi] of ranges) for (let p = Math.max(lo, PORT_MIN); p <= Math.min(hi, PORT_MAX); p++) busy.add(p)
  return busy
}

/** The real Windows side. Tests swap pieces of it. */
export const windows = {
  tempDir: () => powershell('(Get-Item -LiteralPath $env:TEMP).FullName'),
  /** Ports in our range that Windows has a listener on or has excluded from binding. */
  busyPorts: () =>
    parseBusyPorts(
      powershell(
        `(@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort }) -join ','); ` +
          `netsh interface ipv4 show excludedportrange protocol=tcp`,
      ),
    ),
  /** {pid, commandLine} for exactly this PID, or null when no such process exists. */
  queryProcess: (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid ${pid}`)
    const out = powershell(
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
        `if ($p) { [pscustomobject]@{pid=[int]$p.ProcessId; commandLine=$p.CommandLine} | ConvertTo-Json -Compress } else { 'null' }`,
    )
    return JSON.parse(out)
  },
  /**
   * Start chrome.exe and return its Windows PID. Start-Process hands back the PID
   * of exactly the process it created, so a launch that never answers on CDP can
   * still be killed by PID. The arguments travel as base64 JSON, never as script text.
   */
  startChrome: (argv) => {
    if (!existsSync(CHROME_EXE)) throw new Error(`no Windows Chrome at ${CHROME_EXE}`)
    const exe = execFileSync('wslpath', ['-w', CHROME_EXE], { encoding: 'utf8' }).trim()
    const payload = Buffer.from(JSON.stringify({ exe, args: windowsCommandLine(argv) })).toString('base64')
    const pid = Number(
      powershell(
        `$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; ` +
          `(Start-Process -FilePath $a.exe -ArgumentList $a.args -PassThru).Id`,
      ),
    )
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Start-Process returned no pid for ${exe}`)
    return pid
  },
  taskkill: (pid) => execFileSync(TASKKILL, taskkillArgv(pid), { stdio: 'ignore' }),
  removeDir: (winPath) => {
    const linuxPath = execFileSync('wslpath', ['-u', winPath], { encoding: 'utf8' }).trim()
    rmSync(linuxPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  },
}

/**
 * Something already answers on this port. A closed port under mirrored networking
 * drops the SYN rather than refusing it, hence the short timeout. Never probe by
 * binding: a WSL bind holds the port on the Windows side long enough that Chrome's
 * DevTools server then fails to start on it.
 */
const portAnswers = (port) =>
  new Promise((done) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    sock.setTimeout(300)
    sock.once('connect', () => (sock.destroy(), done(true)))
    sock.once('timeout', () => (sock.destroy(), done(false)))
    sock.once('error', () => done(false))
  })

const fetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

const cdpCall = (wsUrl, method) =>
  new Promise((done, fail) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => (ws.close(), fail(new Error(`${method}: no CDP reply`))), 10000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method }))
    ws.onerror = () => (clearTimeout(timer), fail(new Error(`${method}: CDP socket error at ${wsUrl}`)))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) fail(new Error(`${method}: ${msg.error.message}`))
      else done(msg.result)
    }
  })

const waitForCdp = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`)
    } catch (e) {
      if (Date.now() > deadline)
        throw new Error(`Chrome never answered on :${port} (${e.message}). WSL reaches Windows' 127.0.0.1 only with networkingMode=mirrored`, { cause: e })
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/**
 * Launch a Chrome this tool owns. The lockfile is written as soon as Windows
 * hands back the PID, so a launcher that dies mid-launch still leaves a lock
 * `kill` can act on. The launch then succeeds only if the browser Chrome reports
 * over CDP on our port is that same PID and it passes the ownership check;
 * otherwise our Chrome is killed through `killOwnChrome` and the launch throws.
 */
export const launchOwnChrome = async ({ dir = defaultLockDir(), url, port, timeoutMs = 30000, win = windows } = {}) => {
  if (port !== undefined) assertPortAllowed(port)
  const busy = win.busyPorts()
  const isFree = async (p) => !busy.has(p) && !(await portAnswers(p))
  if (port !== undefined && !(await isFree(port))) throw new Error(`port ${port} is in use`)
  const chosen = port ?? (await pickPort(isFree))
  const winTemp = win.tempDir()
  const profileDir = newProfileDir(winTemp, chosen)
  const pid = win.startChrome(chromeArgv({ port: chosen, profileDir, url }))
  const lock = parseLock({ pid, port: chosen, profileDir, startedAt: new Date().toISOString() }, winTemp)
  mkdirSync(dir, { recursive: true })
  const lockfile = resolve(join(dir, `own-chrome-${chosen}-${pid}.json`))
  writeFileSync(lockfile, JSON.stringify({ pid, port: chosen, profileDir, startedAt: lock.startedAt }, null, 2) + '\n')
  try {
    const version = await waitForCdp(chosen, timeoutMs)
    const { processInfo } = await cdpCall(version.webSocketDebuggerUrl, 'SystemInfo.getProcessInfo')
    const cdpPid = processInfo.find((p) => p.type === 'browser')?.id
    if (cdpPid !== pid) throw new Error(`the browser answering on :${chosen} is pid ${cdpPid}, not the launched pid ${pid}`)
    const proc = win.queryProcess(pid)
    const owned = proc ? checkOwnership(lock, proc) : { ok: false, reason: `pid ${pid} exited` }
    if (!owned.ok) throw new Error(owned.reason)
  } catch (e) {
    await killOwnChrome(lockfile, { win }).catch((k) => (e.message += `; cleanup: ${k.message}`))
    throw e
  }
  return { ...lock, lockfile }
}

/**
 * Kill the Chrome a lockfile recorded, then delete its profile and the lock.
 * Refuses (throws, touching nothing) unless Windows says that PID's command line
 * carries this lock's exact port flag and profile dir. When Chrome already
 * exited, or a previous kill died halfway, it converges: nothing is left to
 * kill, and the profile and lock are removed.
 */
export const killOwnChrome = async (lockfile, { win = windows } = {}) => {
  const winTemp = win.tempDir()
  const lock = parseLock(readFileSync(lockfile, 'utf8'), winTemp)
  const proc = win.queryProcess(lock.pid)
  let killed = false
  if (proc) {
    const owned = checkOwnership(lock, proc)
    if (!owned.ok) throw new Error(`refusing to kill pid ${lock.pid}: ${owned.reason}`)
    win.taskkill(lock.pid)
    killed = true
    for (let i = 0; i < 40 && win.queryProcess(lock.pid); i++) await new Promise((r) => setTimeout(r, 250))
    if (win.queryProcess(lock.pid)) throw new Error(`pid ${lock.pid} survived taskkill`)
  }
  win.removeDir(lock.profileDir)
  unlinkSync(lockfile)
  return { pid: lock.pid, port: lock.port, killed, profileDir: lock.profileDir }
}

/** Every lock in `dir`, with whether its Chrome is still the one recorded. */
export const listOwnChrome = ({ dir = defaultLockDir(), win = windows } = {}) => {
  if (!existsSync(dir)) return []
  const winTemp = win.tempDir()
  return readdirSync(dir)
    .filter((f) => /^own-chrome-\d+-\d+\.json$/.test(f))
    .map((f) => {
      const lockfile = join(dir, f)
      try {
        const lock = parseLock(readFileSync(lockfile, 'utf8'), winTemp)
        const proc = win.queryProcess(lock.pid)
        const status = !proc ? 'gone' : checkOwnership(lock, proc).ok ? 'running' : 'pid reused'
        return { ...lock, lockfile, status }
      } catch (e) {
        return { lockfile, status: `invalid: ${e.message}` }
      }
    })
}

const cli = async (argv) => {
  const [cmd, ...rest] = argv
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : undefined
  }
  if (cmd === 'launch') {
    const port = flag('port')
    const lock = await launchOwnChrome({ dir: flag('dir') ?? defaultLockDir(), url: flag('url'), port: port === undefined ? undefined : Number(port) })
    console.log(JSON.stringify(lock))
  } else if (cmd === 'kill') {
    if (!rest[0]) throw new Error('usage: own-chrome.mjs kill <lockfile>')
    console.log(JSON.stringify(await killOwnChrome(rest[0])))
  } else if (cmd === 'list') {
    console.log(JSON.stringify(listOwnChrome({ dir: flag('dir') ?? defaultLockDir() }), null, 2))
  } else {
    throw new Error('usage: own-chrome.mjs launch [--dir D] [--url U] [--port P] | kill <lockfile> | list [--dir D]')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((e) => {
    console.error(`own-chrome: ${e.message}`)
    process.exit(1)
  })
}
