#!/usr/bin/env node
// Fail before `wrangler deploy` when a file it would upload is over 24 MiB.
// Workers reject any asset over 25 MiB, and one such file fails the whole
// deploy. Prints the biggest files either way, so the log shows the headroom.
//
//   node scripts/check-dist-sizes.mjs [dir]    (default: dist)
//
// deploy-web runs this after the OTA zip is staged and after an oversize APK
// is dropped, so it sees exactly the files wrangler uploads.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LIMIT = 24 * 1024 * 1024
const dir = process.argv[2] ?? 'dist'
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

const files = readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => {
    const path = join(e.parentPath, e.name)
    return { path, bytes: statSync(path).size }
  })
  .sort((a, b) => b.bytes - a.bytes)

console.log(`${files.length} files in ${dir}, biggest first:`)
for (const f of files.slice(0, 8)) console.log(`${mib(f.bytes).padStart(12)}  ${f.path}`)

const over = files.filter((f) => f.bytes > LIMIT)
for (const f of over) {
  console.log(`::error::${f.path} is ${mib(f.bytes)} (${f.bytes} B), over the 24 MiB budget; Workers reject an asset over 25 MiB`)
}
if (over.length) process.exit(1)
