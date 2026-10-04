#!/usr/bin/env node
// Real run of scripts/own-chrome.mjs on this Windows desktop: launch, drive it
// over CDP, kill it, and prove the kill touched nothing else. Every chrome.exe
// alive before the launch must still be alive after the kill, and every process
// in the launched browser's tree must be gone. The chrome.exe listing is read-only.
//
//   node scripts/test/own-chrome-smoke.mjs [--dir <lock dir>]
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { defaultLockDir, killOwnChrome, launchOwnChrome, windows } from '../own-chrome.mjs'

const i = process.argv.indexOf('--dir')
const dir = i >= 0 ? process.argv[i + 1] : defaultLockDir()

/** pid -> parent pid of every chrome.exe on the desktop. */
const chromeProcs = () => {
  const script = `$ProgressPreference='SilentlyContinue'; (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object { "$($_.ProcessId):$($_.ParentProcessId)" }) -join ','`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim()
  return new Map(out ? out.split(',').map((pair) => pair.split(':').map(Number)) : [])
}
const treeOf = (procs, root) => {
  const tree = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of procs) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
    }
  }
  return [...tree].filter((p) => procs.has(p))
}
const failures = []
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failures.push(msg)
}

const before = chromeProcs()
console.log(`chrome.exe before launch: ${before.size}`)

const lock = await launchOwnChrome({ dir })
console.log(`launched ${JSON.stringify(lock)}`)
check(lock.port !== 9222 && lock.port >= 9300 && lock.port <= 9999, `port ${lock.port} is in 9300-9999`)
check(existsSync(lock.lockfile), `lockfile written at ${lock.lockfile}`)
const during = chromeProcs()
const mine = treeOf(during, lock.pid)
check(mine.includes(lock.pid) && !before.has(lock.pid), `browser pid ${lock.pid} is a new chrome.exe with ${mine.length} processes in its tree`)

const browser = await chromium.connectOverCDP(lock.cdpUrl)
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage()
await page.goto('about:blank')
check((await page.evaluate(() => location.href)) === 'about:blank', 'opened about:blank over CDP')
await browser.close()

const forged = lock.lockfile.replace(/\.json$/, '-forged.json')
writeFileSync(forged, JSON.stringify({ pid: lock.pid, port: lock.port, profileDir: lock.profileDir.replace(/[0-9a-f]{12}$/, '000000000000'), startedAt: lock.startedAt }))
const refused = await killOwnChrome(forged).then(() => null, (e) => e.message)
rmSync(forged)
check(refused?.startsWith(`refusing to kill pid ${lock.pid}`) && windows.queryProcess(lock.pid) !== null, `a lock naming our pid with another profile is refused, pid alive (${refused})`)

const killed = await killOwnChrome(lock.lockfile)
console.log(`killed ${JSON.stringify(killed)}`)
check(windows.queryProcess(lock.pid) === null, `pid ${lock.pid} is gone`)
check(!existsSync(lock.lockfile), 'lockfile removed')
const profileLinux = execFileSync('wslpath', ['-u', lock.profileDir], { encoding: 'utf8' }).trim()
check(!existsSync(profileLinux), `profile dir removed (${lock.profileDir})`)

const after = chromeProcs()
const lost = [...before.keys()].filter((p) => !after.has(p))
const others = (procs) => [...procs.keys()].filter((p) => !mine.includes(p)).length
console.log(`chrome.exe other than ours: before ${before.size}, during ${others(during)}, after ${others(after)}`)
check(lost.length === 0, `every pre-existing chrome.exe survived (${lost.length ? `lost ${lost.join(',')}` : `${before.size} of ${before.size}`})`)
check(mine.every((p) => !after.has(p)), `all ${mine.length} of our chrome.exe processes are gone`)

console.log(failures.length ? `FAIL (${failures.length})` : 'PASS')
process.exit(failures.length ? 1 : 0)
