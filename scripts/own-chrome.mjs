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
// So: port 9222 is refused everywhere, and a kill reaches only the recorded
// browser (same PID, same start time, this lock's exact port and profile args)
// and descendants that started after it with the same profile arg. It never uses
// `taskkill /T`, whose tree follows stale parent PIDs into unrelated processes.
// Nothing here matches processes by name or pattern. Every child process gets an argv array and no shell option; the
// PowerShell scripts are fixed text whose only inputs are an integer PID or
// base64 JSON.
import { execFileSync, spawn } from 'node:child_process'
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

export const defaultLockDir = () => process.env.OWN_CHROME_DIR ?? join(tmpdir(), 'own-chrome')

/** Throws unless `port` is one this tool may launch on. 9222 gets its own message. */
export const assertPortAllowed = (port) => {
  if (port === PERSONAL_CDP_PORT)
    throw new Error(`port ${PERSONAL_CDP_PORT} is the owner's personal Chrome; own-chrome never launches on or attaches to it`)
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX)
    throw new Error(`port ${port} is outside ${PORT_MIN}-${PORT_MAX}`)
}

/**
 * The port a CDP endpoint names, however it is spelled: a URL, a ws:// URL, a
 * bare `host:port` (which `new URL` would read as a scheme), or a bare port.
 */
export const cdpPort = (cdpUrl) => {
  const s = String(cdpUrl).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

/** Throws when a CDP endpoint is the owner's personal Chrome, or cannot be read. For anything that connects over CDP. */
export const assertNotPersonalChrome = (cdpUrl) => {
  let port
  try {
    port = cdpPort(cdpUrl)
  } catch (e) {
    throw new Error(`refusing to attach to ${JSON.stringify(cdpUrl)}: not a readable CDP endpoint`, { cause: e })
  }
  if (port === PERSONAL_CDP_PORT)
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
  if (typeof lock.startTicks !== 'string' || !/^\d+$/.test(lock.startTicks)) throw new Error(`lock startTicks ${JSON.stringify(lock.startTicks)} is not a Windows FILETIME`)
  if (typeof lock.startedAt !== 'string') throw new Error('lock startedAt missing')
  const { pid, port, profileDir, startTicks, startedAt } = lock
  return { pid, port, profileDir, startTicks, startedAt, cdpUrl: `http://127.0.0.1:${port}` }
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
 * Is the live process `proc` ({pid, startTicks, commandLine} from Windows) the
 * browser this lock recorded? Its start time must equal the recorded one, so a
 * reused PID fails. Whole-argument equality only: `--remote-debugging-port=93`
 * does not match `--remote-debugging-port=9301`, and a renderer child
 * (`--type=...`) is not the browser root.
 */
export const checkOwnership = (lock, proc) => {
  if (proc.pid !== lock.pid) return { ok: false, reason: `asked about pid ${lock.pid}, Windows answered for ${proc.pid}` }
  if (proc.startTicks !== lock.startTicks)
    return { ok: false, reason: `pid ${lock.pid} started at ${proc.startTicks}, the lock recorded ${lock.startTicks}: the PID was reused` }
  if (typeof proc.commandLine !== 'string' || !proc.commandLine) return { ok: false, reason: `pid ${lock.pid} command line is unreadable` }
  const argv = splitWindowsCommandLine(proc.commandLine)
  const want = [`--remote-debugging-port=${lock.port}`, `--user-data-dir=${lock.profileDir}`]
  const missing = want.filter((a) => !argv.includes(a))
  if (missing.length) return { ok: false, reason: `pid ${lock.pid} command line lacks ${missing.join(' and ')}` }
  if (argv.some((a) => a.startsWith('--type='))) return { ok: false, reason: `pid ${lock.pid} is a Chrome child process, not the browser` }
  return { ok: true }
}

const isTicks = (t) => typeof t === 'string' && /^\d+$/.test(t)

/**
 * Which PIDs of a kill snapshot are ours. `snapshot` is what Windows reported
 * while holding a handle to each process: the root PID's process and every
 * process found below it by ParentProcessId. Windows never clears a dead
 * parent's PID from its children, so "below it" can include another Chrome
 * whose parent happened to have our PID. A descendant is ours only if it
 * started no earlier than our browser and carries our exact profile arg.
 * Throws, killing nothing, when the root is not this lock's browser.
 */
export const planKill = (lock, { root, descendants }) => {
  if (!root) return { kill: [], skipped: [] }
  const owned = checkOwnership(lock, root)
  if (!owned.ok) throw new Error(`refusing to kill pid ${lock.pid}: ${owned.reason}`)
  const profileArg = `--user-data-dir=${lock.profileDir}`
  const ours = (p) =>
    isTicks(p.startTicks) &&
    BigInt(p.startTicks) >= BigInt(lock.startTicks) &&
    typeof p.commandLine === 'string' &&
    splitWindowsCommandLine(p.commandLine).includes(profileArg)
  return {
    kill: [...descendants.filter(ours).map((p) => p.pid), root.pid],
    skipped: descendants.filter((p) => !ours(p)).map((p) => p.pid),
  }
}

const psArgs = (body) => [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${body}`, 'utf16le').toString('base64'),
]

/** Run a fixed PowerShell script. -EncodedCommand keeps its text out of any argv quoting. */
export const powershell = (body) =>
  execFileSync(POWERSHELL, psArgs(body), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Opens a process by PID and keeps the handle in `$held`, so Windows cannot
 * reuse that PID until this PowerShell exits. Start time and command line are
 * read after the handle is open, so both describe the process the handle holds.
 */
const PS_HOLD = `
$held = @{}
function Hold([int]$id) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { $null = $p.Handle; $t = $p.StartTime.ToFileTimeUtc() } catch { $t = $null }
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if (-not $c) { return $null }
  $held[$id] = $p
  return @{ ticks = $t; info = [pscustomobject]@{ pid = $id; startTicks = $(if ($t -ne $null) { [string]$t } else { $null }); commandLine = $c.CommandLine } }
}
`

/**
 * One PowerShell process does the check and the kill. It holds handles to the
 * root and to every descendant that started no earlier than the root, prints
 * that snapshot as one JSON line, reads back the PIDs to kill, and stops only
 * processes it holds. `decide` (planKill) runs in between; a throw sends an
 * empty list.
 */
const PS_KILL_TREE = (pid) => `${PS_HOLD}
$snap = [pscustomobject]@{ root = $null; descendants = @() }
$root = Hold ${pid}
if ($root) {
  $snap.root = $root.info
  $desc = @()
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(${pid})
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    foreach ($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent")) {
      $id = [int]$c.ProcessId
      if ($held.ContainsKey($id)) { continue }
      $h = Hold $id
      if (-not $h) { continue }
      if ($h.ticks -eq $null -or $root.ticks -eq $null -or $h.ticks -lt $root.ticks) { $held.Remove($id); continue }
      $desc += $h.info
      $queue.Enqueue($id)
    }
  }
  $snap.descendants = @($desc)
}
$snap | ConvertTo-Json -Compress -Depth 3
[Console]::Out.Flush()
$line = [Console]::In.ReadLine()
$killed = @(); $survived = @()
if ($line) {
  foreach ($s in $line.Split(',')) {
    $p = $held[[int]$s]
    if (-not $p) { continue }
    try { Stop-Process -InputObject $p -Force -ErrorAction Stop } catch {}
    if ($p.WaitForExit(10000)) { $killed += [int]$s } else { $survived += [int]$s }
  }
}
'killed=' + ($killed -join ',') + ';survived=' + ($survived -join ',')
`

const runKillTree = (pid, decide) =>
  new Promise((done, fail) => {
    const ps = spawn(POWERSHELL, psArgs(PS_KILL_TREE(pid)), { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let asked = false
    let refusal = null
    ps.stdout.on('data', (d) => {
      out += d
      if (asked || !out.includes('\n')) return
      asked = true
      let ids = []
      try {
        const snap = JSON.parse(out.slice(0, out.indexOf('\n')))
        ids = decide({ root: snap.root ?? null, descendants: [].concat(snap.descendants ?? []) })
      } catch (e) {
        refusal = e
      }
      ps.stdin.end(`${ids.join(',')}\n`)
    })
    ps.stderr.on('data', (d) => (err += d))
    ps.on('error', fail)
    ps.on('close', (code) => {
      if (refusal) return fail(refusal)
      const m = /killed=([\d,]*);survived=([\d,]*)/.exec(out)
      if (code !== 0 || !m) return fail(new Error(`kill script failed (exit ${code}): ${err.trim().slice(0, 400)}`))
      const ids = (list) => list.split(',').filter(Boolean).map(Number)
      done({ killed: ids(m[1]), survived: ids(m[2]) })
    })
  })

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
  /** {pid, startTicks, commandLine} for exactly this PID, or null when no such process exists. */
  queryProcess: (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid ${pid}`)
    return JSON.parse(powershell(`${PS_HOLD} $h = Hold ${pid}; if ($h) { $h.info | ConvertTo-Json -Compress } else { 'null' }`))
  },
  /**
   * Start chrome.exe and return {pid, startTicks} of exactly the process
   * Start-Process created, so a launch that never answers on CDP can still be
   * killed. The arguments travel as base64 JSON, never as script text.
   */
  startChrome: (argv) => {
    if (!existsSync(CHROME_EXE)) throw new Error(`no Windows Chrome at ${CHROME_EXE}`)
    const exe = execFileSync('wslpath', ['-w', CHROME_EXE], { encoding: 'utf8' }).trim()
    const payload = Buffer.from(JSON.stringify({ exe, args: windowsCommandLine(argv) })).toString('base64')
    const started = JSON.parse(
      powershell(
        `$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; ` +
          `$p = Start-Process -FilePath $a.exe -ArgumentList $a.args -PassThru; ` +
          `[pscustomobject]@{ pid = $p.Id; startTicks = [string]$p.StartTime.ToFileTimeUtc() } | ConvertTo-Json -Compress`,
      ),
    )
    if (!Number.isInteger(started.pid) || started.pid <= 0 || !isTicks(started.startTicks)) throw new Error(`Start-Process returned ${JSON.stringify(started)} for ${exe}`)
    return started
  },
  /** Snapshot the tree under `pid`, let `decide` pick PIDs, and stop those, in one PowerShell process. */
  killTree: runKillTree,
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
  const { pid, startTicks } = win.startChrome(chromeArgv({ port: chosen, profileDir, url }))
  const lock = parseLock({ pid, port: chosen, profileDir, startTicks, startedAt: new Date().toISOString() }, winTemp)
  mkdirSync(dir, { recursive: true })
  const lockfile = resolve(join(dir, `own-chrome-${chosen}-${pid}.json`))
  writeFileSync(lockfile, JSON.stringify({ pid, port: chosen, profileDir, startTicks, startedAt: lock.startedAt }, null, 2) + '\n')
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
 * Refuses (throws, touching nothing) unless the process at that PID has the
 * recorded start time and this lock's exact port and profile args; see
 * `planKill` for which descendants go with it. When Chrome already exited, or
 * a previous kill died halfway, it converges: nothing is left to kill, and the
 * profile and lock are removed.
 */
export const killOwnChrome = async (lockfile, { win = windows } = {}) => {
  const winTemp = win.tempDir()
  const lock = parseLock(readFileSync(lockfile, 'utf8'), winTemp)
  let plan = { kill: [], skipped: [] }
  const { killed, survived } = await win.killTree(lock.pid, (snapshot) => (plan = planKill(lock, snapshot)).kill)
  if (survived.length) throw new Error(`pids ${survived.join(',')} survived Stop-Process; lock kept`)
  win.removeDir(lock.profileDir)
  unlinkSync(lockfile)
  return { pid: lock.pid, port: lock.port, killed, skipped: plan.skipped, profileDir: lock.profileDir }
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
