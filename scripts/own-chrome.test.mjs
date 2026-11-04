import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PORT_MAX,
  PORT_MIN,
  assertNotPersonalChrome,
  assertPortAllowed,
  checkOwnership,
  chromeArgv,
  killOwnChrome,
  launchOwnChrome,
  parseBusyPorts,
  parseLock,
  pickPort,
  planKill,
  quoteWindowsArg,
  splitWindowsCommandLine,
  windowsCommandLine,
} from './own-chrome.mjs'

const TEMP = 'C:\\Users\\aaron\\AppData\\Local\\Temp'
const PROFILE = `${TEMP}\\own-chrome-9411-0123456789ab`
const T0 = 134355870000000000n
const ticks = (offset) => String(T0 + BigInt(offset))
const LOCK = { pid: 4242, port: 9411, profileDir: PROFILE, startTicks: ticks(0), startedAt: '2026-10-04T00:00:00.000Z' }
const EXE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
const liveCmd = (argv) => `${EXE} ${windowsCommandLine(argv)}`
const OUR_BROWSER = liveCmd(chromeArgv({ port: 9411, profileDir: PROFILE }))
const ourChild = (type) => liveCmd([`--type=${type}`, `--user-data-dir=${PROFILE}`])
const OWNER_PROFILE = 'C:\\Users\\aaron\\AppData\\Local\\Google\\Chrome\\User Data'
const OWNER_BROWSER = `${EXE} --restore-last-session`
const ownerChild = (type) => liveCmd([`--type=${type}`, `--user-data-dir=${OWNER_PROFILE}`])

/**
 * A fake Windows over a process table {pid, ppid, startTicks, commandLine}.
 * killTree reports the whole ParentProcessId subtree, with no start-time
 * filter, so planKill alone has to keep imposters out.
 */
const fakeWindows = (rows) => {
  const procs = new Map(rows.map((p) => [p.pid, p]))
  const calls = { stopped: [], removeDir: [], startChrome: [] }
  const info = ({ pid, startTicks, commandLine }) => ({ pid, startTicks, commandLine })
  const win = {
    procs,
    tempDir: () => TEMP,
    busyPorts: () => new Set(),
    queryProcess: (pid) => (procs.has(pid) ? info(procs.get(pid)) : null),
    killTree: async (pid, decide) => {
      const root = procs.get(pid)
      const descendants = []
      const queue = root ? [pid] : []
      while (queue.length) {
        const parent = queue.shift()
        for (const p of procs.values())
          if (p.ppid === parent && p.pid !== pid && !descendants.some((d) => d.pid === p.pid)) {
            descendants.push(info(p))
            queue.push(p.pid)
          }
      }
      const ids = decide({ root: root ? info(root) : null, descendants })
      for (const id of ids) {
        calls.stopped.push(id)
        procs.delete(id)
      }
      return { killed: ids, survived: [] }
    },
    removeDir: (dir) => calls.removeDir.push(dir),
    startChrome: (argv) => (calls.startChrome.push(argv), { pid: LOCK.pid, startTicks: LOCK.startTicks }),
  }
  return { win, calls }
}
const writeLock = (lock) => {
  const file = join(mkdtempSync(join(tmpdir(), 'own-chrome-test-')), 'own-chrome-9411-4242.json')
  writeFileSync(file, JSON.stringify(lock))
  return file
}

describe('the 9222 guard', () => {
  it('refuses 9222 as a launch port', async () => {
    expect(() => assertPortAllowed(9222)).toThrow(/9222 is the owner's personal Chrome/)
    expect(() => chromeArgv({ port: 9222, profileDir: PROFILE })).toThrow(/9222/)
    const { win, calls } = fakeWindows([])
    await expect(launchOwnChrome({ port: 9222, win, dir: tmpdir() })).rejects.toThrow(/9222/)
    expect(calls.startChrome).toEqual([])
  })

  it('refuses a CDP endpoint on 9222 however it is spelled', () => {
    const spellings = [
      'http://127.0.0.1:9222',
      'http://localhost:9222/json/version',
      ' HTTP://LOCALHOST:9222/ ',
      'ws://127.0.0.1:9222/devtools/browser/abc',
      'localhost:9222',
      '127.0.0.1:9222',
      '[::1]:9222',
      '9222',
    ]
    for (const url of spellings) expect(() => assertNotPersonalChrome(url), url).toThrow(/refusing to attach/)
  })

  it('refuses an endpoint it cannot read, and lets any other port through', () => {
    expect(() => assertNotPersonalChrome('http://[nope')).toThrow(/not a readable CDP endpoint/)
    for (const url of ['http://127.0.0.1:9411', 'localhost:9411', 'ws://127.0.0.1:9900/devtools/browser/x', '9411'])
      expect(() => assertNotPersonalChrome(url), url).not.toThrow()
  })
})

describe('port selection', () => {
  it('refuses ports outside 9300-9999 and non-integers', () => {
    for (const port of [9299, 10000, 80, 9411.5, NaN, '9411']) expect(() => assertPortAllowed(port)).toThrow(/outside/)
    expect(() => assertPortAllowed(9300)).not.toThrow()
    expect(() => assertPortAllowed(9999)).not.toThrow()
  })

  it('takes the first free port from its start, skipping busy ones', async () => {
    const busy = new Set([9500, 9501])
    expect(await pickPort(async (p) => !busy.has(p), 9500)).toBe(9502)
  })

  it('wraps from the top of the range back to the bottom', async () => {
    expect(await pickPort(async (p) => p < 9305, 9998)).toBe(9300)
  })

  it('every start yields a port in range', async () => {
    for (let start = PORT_MIN; start <= PORT_MAX; start += 37) {
      const port = await pickPort(async () => true, start)
      expect(port).toBeGreaterThanOrEqual(PORT_MIN)
      expect(port).toBeLessThanOrEqual(PORT_MAX)
    }
  })

  it("reads Windows' listeners and excluded ranges as busy, clipped to our range", () => {
    const netsh = ['', 'Protocol tcp Port Exclusion Ranges', '', 'Start Port    End Port', '----------    --------', '      9290        9302', '     47984       48013     *', '', '* - Administered port exclusions.']
    const busy = parseBusyPorts(['135,9222,9371,9763', ...netsh].join('\r\n'))
    expect([...busy].sort()).toEqual([9300, 9301, 9302, 9371, 9763])
  })

  it('throws when every port is taken', async () => {
    await expect(pickPort(async () => false, 9300)).rejects.toThrow(/no free port/)
  })
})

describe('argv construction', () => {
  it('passes each flag as its own argv element, profile dir with spaces intact', () => {
    const profileDir = 'C:\\Users\\a b\\AppData\\Local\\Temp\\own-chrome-9411-0123456789ab'
    const argv = chromeArgv({ port: 9411, profileDir })
    expect(argv.slice(0, 4)).toEqual(['--remote-debugging-port=9411', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'])
    expect(argv.at(-1)).toBe('about:blank')
  })

  it('a Windows command line reads back as the exact argv it was built from', () => {
    const awkward = ['plain', 'has space', 'tab\there', 'quote"inside', 'trail\\', 'trail space\\', 'C:\\a b\\', 'x\\\\"y', '', '"', '\\\\']
    expect(splitWindowsCommandLine(windowsCommandLine(awkward))).toEqual(awkward)
    const alphabet = ['a', ' ', '"', '\\', '\t', 'C:']
    let seed = 7
    const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
    for (let t = 0; t < 500; t++) {
      const argv = Array.from({ length: 1 + rand(4) }, () => Array.from({ length: rand(7) }, () => alphabet[rand(alphabet.length)]).join(''))
      expect(splitWindowsCommandLine(windowsCommandLine(argv))).toEqual(argv)
    }
  })

  it('leaves simple arguments unquoted, the form Chrome reports back', () => {
    expect(quoteWindowsArg('--remote-debugging-port=9411')).toBe('--remote-debugging-port=9411')
    expect(quoteWindowsArg('C:\\a b')).toBe('"C:\\a b"')
  })
})

describe('the ownership guard', () => {
  const lock = parseLock(LOCK, TEMP)
  const proc = (over) => ({ pid: 4242, startTicks: ticks(0), commandLine: OUR_BROWSER, ...over })

  it('accepts the browser process carrying this start time, port and profile', () => {
    expect(checkOwnership(lock, proc({}))).toEqual({ ok: true })
  })

  it('refuses our pid with another start time: the PID was reused', () => {
    expect(checkOwnership(lock, proc({ startTicks: ticks(1) }))).toMatchObject({ ok: false, reason: expect.stringMatching(/PID was reused/) })
    expect(checkOwnership(lock, proc({ startTicks: null })).ok).toBe(false)
  })

  it('refuses a command line whose port only starts with ours', () => {
    const commandLine = OUR_BROWSER.replace('--remote-debugging-port=9411', '--remote-debugging-port=94112')
    expect(checkOwnership(lock, proc({ commandLine }))).toMatchObject({ ok: false, reason: expect.stringMatching(/remote-debugging-port=9411/) })
  })

  it('refuses a profile that merely contains or is contained in ours', () => {
    for (const profileDir of ['C:', TEMP, `${PROFILE}-other`, `${PROFILE}\\Default`])
      expect(checkOwnership(lock, proc({ commandLine: liveCmd(['--remote-debugging-port=9411', `--user-data-dir=${profileDir}`]) })).ok).toBe(false)
  })

  it("refuses the owner's Chrome, another agent's Chrome, a Chrome child, and an unreadable command line", () => {
    const cases = [
      OWNER_BROWSER,
      liveCmd(['--remote-debugging-port=9222', '--user-data-dir=D:\\projects\\playwright-mcp\\chrome-profile']),
      liveCmd(['--remote-debugging-port=9411', `--user-data-dir=${TEMP}\\sporefall-agent-9411`]),
      `${OUR_BROWSER} --type=renderer`,
      null,
    ]
    for (const commandLine of cases) expect(checkOwnership(lock, proc({ commandLine })).ok).toBe(false)
    expect(checkOwnership(lock, proc({ pid: 4243 })).ok).toBe(false)
  })

  it('refuses a lockfile not shaped as launch writes it', () => {
    expect(() => parseLock({ ...LOCK, profileDir: 'C:' }, TEMP)).toThrow(/not an own-chrome profile/)
    expect(() => parseLock({ ...LOCK, profileDir: `${OWNER_PROFILE}` }, TEMP)).toThrow(/not an own-chrome profile/)
    expect(() => parseLock({ ...LOCK, profileDir: `${PROFILE}\\..\\..` }, TEMP)).toThrow(/not an own-chrome profile/)
    expect(() => parseLock({ ...LOCK, port: 9222 }, TEMP)).toThrow(/9222/)
    expect(() => parseLock({ ...LOCK, pid: 0 }, TEMP)).toThrow(/pid/)
    expect(() => parseLock({ ...LOCK, pid: '4242' }, TEMP)).toThrow(/pid/)
    expect(() => parseLock({ ...LOCK, startTicks: undefined }, TEMP)).toThrow(/startTicks/)
    expect(() => parseLock({ ...LOCK, startTicks: 134355870000000000 }, TEMP)).toThrow(/startTicks/)
  })
})

/**
 * Our browser 4242 and its tree, next to the owner's Chrome. The owner's
 * browser 500 was started by a process that has since died, and Windows has
 * handed that dead parent's PID, 4242, to our browser. So the owner's whole
 * Chrome sits under 4242 by ParentProcessId, which is what `taskkill /T` follows.
 * 700 even carries our profile arg but started before our browser, so it is
 * not ours either.
 */
const COLLISION = [
  { pid: 4242, ppid: 77, startTicks: ticks(0), commandLine: OUR_BROWSER },
  { pid: 4300, ppid: 4242, startTicks: ticks(10), commandLine: ourChild('gpu-process') },
  { pid: 4301, ppid: 4242, startTicks: ticks(20), commandLine: ourChild('renderer') },
  { pid: 4302, ppid: 4301, startTicks: ticks(30), commandLine: ourChild('utility') },
  { pid: 500, ppid: 4242, startTicks: ticks(-9_000_000_000), commandLine: OWNER_BROWSER },
  { pid: 501, ppid: 500, startTicks: ticks(-8_000_000_000), commandLine: ownerChild('renderer') },
  { pid: 502, ppid: 500, startTicks: ticks(40), commandLine: ownerChild('renderer') },
  { pid: 600, ppid: 4242, startTicks: ticks(50), commandLine: liveCmd(['--type=renderer', `--user-data-dir=${PROFILE}-other`]) },
  { pid: 601, ppid: 4301, startTicks: ticks(60), commandLine: null },
  { pid: 700, ppid: 4242, startTicks: ticks(-1), commandLine: ourChild('renderer') },
]

describe('planKill', () => {
  it('takes our descendants and the root, root last, and nothing of a Chrome parented under a reused PID', () => {
    const { win } = fakeWindows(COLLISION)
    let plan
    return win
      .killTree(4242, (snap) => (plan = planKill(parseLock(LOCK, TEMP), snap)).kill)
      .then(() => {
        expect(plan.kill).toEqual([4300, 4301, 4302, 4242])
        expect(plan.skipped.sort()).toEqual([500, 501, 502, 600, 601, 700])
      })
  })

  it('takes nothing when the root is gone', () => {
    expect(planKill(parseLock(LOCK, TEMP), { root: null, descendants: [] })).toEqual({ kill: [], skipped: [] })
  })

  it('throws, taking nothing, when the root is not our browser', () => {
    const snap = { root: { pid: 4242, startTicks: ticks(5), commandLine: OUR_BROWSER }, descendants: [{ pid: 4300, startTicks: ticks(10), commandLine: ourChild('renderer') }] }
    expect(() => planKill(parseLock(LOCK, TEMP), snap)).toThrow(/refusing to kill pid 4242: .*PID was reused/)
  })
})

describe('killOwnChrome', () => {
  it("kills our tree, leaves the owner's Chrome parented under our PID untouched, then removes profile and lock", async () => {
    const { win, calls } = fakeWindows(COLLISION)
    const file = writeLock(LOCK)
    expect(await killOwnChrome(file, { win })).toMatchObject({ pid: 4242, killed: [4300, 4301, 4302, 4242] })
    expect(calls.stopped).toEqual([4300, 4301, 4302, 4242])
    expect([...win.procs.keys()].sort()).toEqual([500, 501, 502, 600, 601, 700])
    expect(calls.removeDir).toEqual([PROFILE])
    expect(existsSync(file)).toBe(false)
  })

  it('refuses when the recorded PID now belongs to someone else, touching nothing', async () => {
    const { win, calls } = fakeWindows([
      { pid: 4242, ppid: 1, startTicks: ticks(99), commandLine: OWNER_BROWSER },
      { pid: 4243, ppid: 4242, startTicks: ticks(100), commandLine: ownerChild('renderer') },
    ])
    const file = writeLock(LOCK)
    await expect(killOwnChrome(file, { win })).rejects.toThrow(/refusing to kill pid 4242/)
    expect(calls).toMatchObject({ stopped: [], removeDir: [] })
    expect(win.procs.size).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(LOCK)
  })

  it('refuses a lock whose profile dir was cut down to C:, before asking Windows anything', async () => {
    const { win, calls } = fakeWindows([{ pid: 4242, ppid: 1, startTicks: ticks(0), commandLine: `${EXE} --user-data-dir=C:` }])
    win.killTree = () => {
      throw new Error('Windows was asked')
    }
    await expect(killOwnChrome(writeLock({ ...LOCK, profileDir: 'C:' }), { win })).rejects.toThrow(/not an own-chrome profile/)
    expect(calls).toMatchObject({ stopped: [], removeDir: [] })
  })

  it('keeps the lock when a process survives the kill', async () => {
    const { win, calls } = fakeWindows(COLLISION)
    win.killTree = async (pid, decide) => ({ killed: [], survived: decide({ root: COLLISION[0], descendants: [] }) })
    const file = writeLock(LOCK)
    await expect(killOwnChrome(file, { win })).rejects.toThrow(/survived/)
    expect(calls.removeDir).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  it('converges when Chrome already exited: nothing stopped, profile and lock removed', async () => {
    const { win, calls } = fakeWindows([])
    const file = writeLock(LOCK)
    expect(await killOwnChrome(file, { win })).toMatchObject({ killed: [] })
    expect(calls).toMatchObject({ stopped: [], removeDir: [PROFILE] })
    expect(existsSync(file)).toBe(false)
  })
})

describe('launchOwnChrome', () => {
  it('a Chrome that never answers on CDP is killed by its own PID, and the launch throws', async () => {
    const { win, calls } = fakeWindows([])
    win.startChrome = (argv) => {
      calls.startChrome.push(argv)
      win.procs.set(LOCK.pid, { pid: LOCK.pid, ppid: 1, startTicks: LOCK.startTicks, commandLine: liveCmd(argv) })
      win.procs.set(500, { pid: 500, ppid: LOCK.pid, startTicks: ticks(-1), commandLine: OWNER_BROWSER })
      return { pid: LOCK.pid, startTicks: LOCK.startTicks }
    }
    const dir = mkdtempSync(join(tmpdir(), 'own-chrome-test-'))
    await expect(launchOwnChrome({ dir, timeoutMs: 300, win })).rejects.toThrow(/never answered/)
    expect(calls.stopped).toEqual([LOCK.pid])
    expect([...win.procs.keys()]).toEqual([500])
    expect(calls.removeDir).toHaveLength(1)
    expect(calls.removeDir[0]).toMatch(/^C:\\Users\\aaron\\AppData\\Local\\Temp\\own-chrome-\d{4}-[0-9a-f]{12}$/)
  })
})

describe('the module never reaches for a shell, a tree kill, or a name match', () => {
  const src = readFileSync(new URL('./own-chrome.mjs', import.meta.url), 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '')
  it('starts children only with execFile-style argv arrays', () => {
    expect(code).not.toMatch(/shell\s*:/)
    expect(code).not.toMatch(/(?<![.\w])exec(Sync)?\s*\(/)
    expect(code).not.toMatch(/import\s*\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from 'node:child_process'/)
  })
  it('has no taskkill, image-name, wildcard, or pattern kill', () => {
    expect(code).not.toMatch(/taskkill|\/IM\b|['"]\/T['"]|pkill|killall|-like\b|-match\b/i)
    const stops = code.match(/Stop-Process\s+-[^\n;]*/g) ?? []
    expect(stops.length).toBeGreaterThan(0)
    for (const stop of stops) expect(stop).toMatch(/^Stop-Process -InputObject \$p\b/)
  })
})
