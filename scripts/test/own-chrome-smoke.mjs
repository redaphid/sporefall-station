#!/usr/bin/env node
// Real run of scripts/own-chrome.mjs on this Windows desktop: launch, drive it
// over CDP, refuse two forged locks, kill, and prove the kill touched nothing
// else. A chrome.exe is identified by PID plus creation time, so a PID reused
// mid-run cannot pass for a survivor. Every chrome.exe alive before the launch
// must be alive after the kill. The chrome.exe listing is read-only.
//
//   node scripts/test/own-chrome-smoke.mjs [--dir <lock dir>]
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { defaultLockDir, killOwnChrome, launchOwnChrome, powershell, splitWindowsCommandLine, windows } from '../own-chrome.mjs'

const i = process.argv.indexOf('--dir')
const dir = i >= 0 ? process.argv[i + 1] : defaultLockDir()

/** Every chrome.exe on the desktop, keyed `pid@creation` (FILETIME in microseconds, CIM's precision). */
const chromeProcs = () => {
  const out = powershell(
    `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object { ` +
      `[pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; created = [string][math]::Floor($_.CreationDate.ToFileTimeUtc() / 10); commandLine = $_.CommandLine } }) | ConvertTo-Json -Compress -Depth 2`,
  )
  const list = out ? [].concat(JSON.parse(out)) : []
  return new Map(list.map((p) => [`${p.pid}@${p.created}`, p]))
}
const failures = []
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failures.push(msg)
}
const forgedKill = async (lock, change) => {
  const file = lock.lockfile.replace(/\.json$/, '-forged.json')
  const { pid, port, profileDir, startTicks, startedAt } = lock
  writeFileSync(file, JSON.stringify({ pid, port, profileDir, startTicks, startedAt, ...change }))
  const refused = await killOwnChrome(file).then(() => null, (e) => e.message)
  rmSync(file, { force: true })
  return refused
}

const before = chromeProcs()
console.log(`chrome.exe before launch: ${before.size}`)
const roots = (procs) => [...procs].filter(([, p]) => !/--type=/.test(p.commandLine ?? '')).map(([k, p]) => `${k} ${(p.commandLine ?? '?').slice(0, 110)}`)
for (const r of roots(before)) console.log(`  browser before: ${r}`)

const lock = await launchOwnChrome({ dir })
console.log(`launched ${JSON.stringify(lock)}`)
check(lock.port >= 9300 && lock.port <= 9999, `port ${lock.port} is in 9300-9999`)
check(existsSync(lock.lockfile), `lockfile written at ${lock.lockfile}`)
const during = chromeProcs()
const profileArg = `--user-data-dir=${lock.profileDir}`
const mine = [...during.keys()].filter((k) => !before.has(k) && splitWindowsCommandLine(during.get(k).commandLine ?? '').includes(profileArg))
const myRoot = `${lock.pid}@${BigInt(lock.startTicks) / 10n}`
check(mine.includes(myRoot), `browser ${myRoot} is new, with ${mine.length} chrome.exe carrying our profile`)

const browser = await chromium.connectOverCDP(lock.cdpUrl)
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage()
await page.goto('about:blank')
check((await page.evaluate(() => location.href)) === 'about:blank', 'opened about:blank over CDP')
await browser.close()

const otherProfile = await forgedKill(lock, { profileDir: lock.profileDir.replace(/[0-9a-f]{12}$/, '000000000000') })
check(otherProfile?.startsWith(`refusing to kill pid ${lock.pid}`) && windows.queryProcess(lock.pid) !== null, `a lock with our pid and another profile is refused (${otherProfile})`)
const reusedPid = await forgedKill(lock, { startTicks: String(BigInt(lock.startTicks) - 1n) })
check(reusedPid?.includes('the PID was reused') && windows.queryProcess(lock.pid) !== null, `a lock with our pid and another start time is refused (${reusedPid})`)

const preKill = chromeProcs()
const killed = await killOwnChrome(lock.lockfile)
console.log(`killed ${JSON.stringify(killed)}`)
const left = windows.queryProcess(lock.pid)
check(left === null || left.startTicks !== lock.startTicks, `browser ${lock.pid}@${lock.startTicks} is gone`)
check(!existsSync(lock.lockfile), 'lockfile removed')
const profileLinux = execFileSync('wslpath', ['-u', lock.profileDir], { encoding: 'utf8' }).trim()
check(!existsSync(profileLinux), `profile dir removed (${lock.profileDir})`)

const after = chromeProcs()
for (const r of roots(after)) console.log(`  browser after: ${r}`)
const lost = [...before.keys()].filter((k) => !after.has(k))
const oursAtKill = [...preKill.keys()].filter((k) => !before.has(k) && splitWindowsCommandLine(preKill.get(k).commandLine ?? '').includes(profileArg))
const lostAcrossKill = [...preKill.keys()].filter((k) => !oursAtKill.includes(k) && !after.has(k))
const goneBeforeKill = lost.filter((k) => !preKill.has(k))
const others = (procs) => [...procs.keys()].filter((k) => !mine.includes(k)).length
console.log(`chrome.exe other than ours: before ${before.size}, during ${others(during)}, after ${others(after)}`)
check(lostAcrossKill.length === 0, `every other chrome.exe alive just before the kill survived it (${lostAcrossKill.length ? `lost ${lostAcrossKill.join(' ')}` : `${preKill.size - oursAtKill.length} of ${preKill.size - oursAtKill.length}`})`)
check(lost.length === 0, `every chrome.exe alive before the launch survived, same pid and creation time (${lost.length ? `lost ${lost.length}, of which ${goneBeforeKill.length} were gone before the kill ran` : `${before.size} of ${before.size}`})`)
check(mine.every((k) => !after.has(k)), `all ${mine.length} of our chrome.exe are gone`)

console.log(failures.length ? `FAIL (${failures.length})` : 'PASS')
process.exit(failures.length ? 1 : 0)
