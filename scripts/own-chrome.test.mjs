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
  quoteWindowsArg,
  splitWindowsCommandLine,
  taskkillArgv,
  windowsCommandLine,
} from './own-chrome.mjs'

const TEMP = 'C:\\Users\\aaron\\AppData\\Local\\Temp'
const PROFILE = `${TEMP}\\own-chrome-9411-0123456789ab`
const LOCK = { pid: 4242, port: 9411, profileDir: PROFILE, startedAt: '2026-10-04T00:00:00.000Z' }
const EXE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
const liveCmd = (argv) => `${EXE} ${windowsCommandLine(argv)}`

/** A fake Windows that records every side effect a kill or launch performs. */
const fakeWindows = (procs) => {
  const calls = { taskkill: [], removeDir: [], startChrome: [] }
  const win = {
    tempDir: () => TEMP,
    busyPorts: () => new Set(),
    queryProcess: (pid) => (procs.has(pid) ? { pid, commandLine: procs.get(pid) } : null),
    taskkill: (pid) => (calls.taskkill.push(pid), procs.delete(pid)),
    removeDir: (dir) => calls.removeDir.push(dir),
    startChrome: (argv) => (calls.startChrome.push(argv), LOCK.pid),
  }
  return { win, calls }
}
const writeLock = (lock) => {
  const file = join(mkdtempSync(join(tmpdir(), 'own-chrome-test-')), 'own-chrome-9411-4242.json')
  writeFileSync(file, JSON.stringify(lock))
  return file
}

describe('port selection', () => {
  it('refuses 9222 by name, as a launch port and as a CDP endpoint', async () => {
    expect(() => assertPortAllowed(9222)).toThrow(/9222 is the owner's personal Chrome/)
    expect(() => chromeArgv({ port: 9222, profileDir: PROFILE })).toThrow(/9222/)
    expect(() => assertNotPersonalChrome('http://127.0.0.1:9222')).toThrow(/refusing to attach/)
    expect(() => assertNotPersonalChrome('http://localhost:9222/json/version')).toThrow(/refusing to attach/)
    expect(() => assertNotPersonalChrome('http://127.0.0.1:9411')).not.toThrow()
  })

  it('a launch asked for 9222 throws before starting anything', async () => {
    const { win, calls } = fakeWindows(new Map())
    await expect(launchOwnChrome({ port: 9222, win, dir: tmpdir() })).rejects.toThrow(/9222/)
    expect(calls.startChrome).toEqual([])
  })

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

  it('taskkill gets one PID and its tree, never an image name or wildcard', () => {
    expect(taskkillArgv(4242)).toEqual(['/PID', '4242', '/T', '/F'])
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
  const ours = liveCmd(chromeArgv({ port: 9411, profileDir: PROFILE }))

  it('accepts the browser process carrying this exact port and profile', () => {
    expect(checkOwnership(lock, { pid: 4242, commandLine: ours })).toEqual({ ok: true })
  })

  it('refuses a command line whose port only starts with ours', () => {
    const cmd = liveCmd(chromeArgv({ port: 9411, profileDir: PROFILE })).replace('--remote-debugging-port=9411', '--remote-debugging-port=94112')
    expect(checkOwnership(lock, { pid: 4242, commandLine: cmd })).toMatchObject({ ok: false, reason: expect.stringMatching(/remote-debugging-port=9411/) })
  })

  it('refuses a profile that merely contains or is contained in ours', () => {
    for (const profileDir of ['C:', TEMP, `${PROFILE}-other`, `${PROFILE}\\Default`]) {
      const cmd = liveCmd(['--remote-debugging-port=9411', `--user-data-dir=${profileDir}`])
      expect(checkOwnership(lock, { pid: 4242, commandLine: cmd }).ok).toBe(false)
    }
  })

  it("refuses the owner's Chrome, another agent's Chrome, and a Chrome child process", () => {
    const cases = [
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
      liveCmd(['--remote-debugging-port=9222', '--user-data-dir=D:\\projects\\playwright-mcp\\chrome-profile']),
      liveCmd(['--remote-debugging-port=9411', `--user-data-dir=${TEMP}\\sporefall-agent-9411`]),
      `${ours} --type=renderer`,
    ]
    for (const commandLine of cases) expect(checkOwnership(lock, { pid: 4242, commandLine }).ok).toBe(false)
  })

  it('refuses an unreadable command line and a different pid', () => {
    expect(checkOwnership(lock, { pid: 4242, commandLine: null }).ok).toBe(false)
    expect(checkOwnership(lock, { pid: 4243, commandLine: ours }).ok).toBe(false)
  })

  it('refuses a lockfile not shaped as launch writes it', () => {
    expect(() => parseLock({ ...LOCK, profileDir: 'C:' }, TEMP)).toThrow(/not an own-chrome profile/)
    expect(() => parseLock({ ...LOCK, profileDir: 'C:\\Users\\aaron\\AppData\\Local\\Google\\Chrome\\User Data' }, TEMP)).toThrow(/not an own-chrome profile/)
    expect(() => parseLock({ ...LOCK, profileDir: `${TEMP}\\own-chrome-9411-0123456789ab\\..\\..` }, TEMP)).toThrow(/not an own-chrome profile/)
    expect(() => parseLock({ ...LOCK, port: 9222 }, TEMP)).toThrow(/9222/)
    expect(() => parseLock({ ...LOCK, pid: 0 }, TEMP)).toThrow(/pid/)
    expect(() => parseLock({ ...LOCK, pid: '4242' }, TEMP)).toThrow(/pid/)
  })
})

describe('killOwnChrome', () => {
  it('kills the recorded PID tree, then removes the profile and the lock', async () => {
    const { win, calls } = fakeWindows(new Map([[4242, liveCmd(chromeArgv({ port: 9411, profileDir: PROFILE }))]]))
    const file = writeLock(LOCK)
    expect(await killOwnChrome(file, { win })).toMatchObject({ pid: 4242, killed: true })
    expect(calls).toMatchObject({ taskkill: [4242], removeDir: [PROFILE] })
    expect(existsSync(file)).toBe(false)
  })

  it('refuses when the recorded PID now belongs to someone else, touching nothing', async () => {
    const owners = liveCmd(['--remote-debugging-port=9222', '--user-data-dir=D:\\projects\\playwright-mcp\\chrome-profile'])
    const { win, calls } = fakeWindows(new Map([[4242, owners]]))
    const file = writeLock(LOCK)
    await expect(killOwnChrome(file, { win })).rejects.toThrow(/refusing to kill pid 4242/)
    expect(calls).toMatchObject({ taskkill: [], removeDir: [] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(LOCK)
  })

  it('refuses a lock whose profile dir was cut down to C:, before asking Windows anything', async () => {
    const { win, calls } = fakeWindows(new Map([[4242, `${EXE} --user-data-dir=C:`]]))
    await expect(killOwnChrome(writeLock({ ...LOCK, profileDir: 'C:' }), { win })).rejects.toThrow(/not an own-chrome profile/)
    expect(calls).toMatchObject({ taskkill: [], removeDir: [] })
  })

  it('converges when Chrome already exited: no kill, profile and lock removed', async () => {
    const { win, calls } = fakeWindows(new Map())
    const file = writeLock(LOCK)
    expect(await killOwnChrome(file, { win })).toMatchObject({ killed: false })
    expect(calls).toMatchObject({ taskkill: [], removeDir: [PROFILE] })
    expect(existsSync(file)).toBe(false)
  })
})

describe('launchOwnChrome', () => {
  it('a Chrome that never answers on CDP is killed by its own PID, and the launch throws', async () => {
    const procs = new Map()
    const { win, calls } = fakeWindows(procs)
    win.startChrome = (argv) => (calls.startChrome.push(argv), procs.set(LOCK.pid, `${EXE} ${windowsCommandLine(argv)}`), LOCK.pid)
    const dir = mkdtempSync(join(tmpdir(), 'own-chrome-test-'))
    await expect(launchOwnChrome({ dir, timeoutMs: 300, win })).rejects.toThrow(/never answered/)
    expect(calls.taskkill).toEqual([LOCK.pid])
    expect(calls.removeDir).toHaveLength(1)
    expect(calls.removeDir[0]).toMatch(/^C:\\Users\\aaron\\AppData\\Local\\Temp\\own-chrome-\d{4}-[0-9a-f]{12}$/)
  })
})

describe('the module never reaches for a shell or a name match', () => {
  const src = readFileSync(new URL('./own-chrome.mjs', import.meta.url), 'utf8')
  it('starts children only with execFile-style argv arrays', () => {
    expect(src).not.toMatch(/shell\s*:/)
    expect(src).not.toMatch(/(?<![.\w])exec(Sync)?\s*\(/)
    expect(src).not.toMatch(/import\s*\{[^}]*\bexec(Sync)?\b[^}]*\}\s*from 'node:child_process'/)
  })
  it('has no image-name, wildcard, or pattern kill', () => {
    expect(src).not.toMatch(/\/IM\b|pkill|killall|Stop-Process|-like|-match/i)
  })
})
