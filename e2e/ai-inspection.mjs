// window.sporefall / window.world e2e: drive the REAL built page purely through
// the console inspection surface, exactly as an AI agent in the browser would
// (claude-in-chrome runs JavaScript in the page and reads the console).
//
// Three boots against the same server:
//   1. production-like (no flags) — every read works, .verb refuses with the gate
//      explanation, and the boot console line advertises the surface.
//   2. ?debug — .verb drives the real dispatcher (teleport observed in-world).
//   3. ?e2e — the legacy __world/__verb hooks are aliases of the same surface.

import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4977'
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'ok' : 'FAIL'} - ${msg}`)
}

const browser = await chromium.launch({ headless: true })

const boot = async (params) => {
  const page = await browser.newPage()
  const consoleLines = []
  const pageErrors = []
  page.on('console', (m) => consoleLines.push(m.text()))
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(`${BASE}/?${new URLSearchParams(params)}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.sporefall && window.world && window.sporefall.tick() > 10, null, {
    timeout: 30000,
  })
  return { page, consoleLines, pageErrors }
}

// ---- 1. production-like: reads everywhere, writes refused ----
{
  const { page, consoleLines, pageErrors } = await boot({ mode: 'solo', seed: 7 })

  const s = await page.evaluate(() => {
    const b = window.sporefall
    const player = b.player()
    const before = { x: player.pos.x, y: player.pos.y }
    const refusal = b.verb(`teleport ${player.id} 1 1`)
    const after = b.player().pos
    const parsed = JSON.parse(b.serialize())
    return {
      help: b.help(),
      version: b.version(),
      tick: b.tick(),
      tickType: typeof b.tick(),
      session: b.session(),
      playerHasCtl: !!player.playerCtl,
      npcCount: b.entities('npc').length,
      doorsAllDoors: b.entities('door').every((e) => !!e.door),
      predicateCount: b.entities('e => e.playerCtl != null').length,
      lowHpIsArray: Array.isArray(b.entities('e => e.health && e.health.hp < 2')),
      entityById: b.entity(player.id)?.id,
      mission: b.mission(),
      events: b.events(),
      eventsSinceFuture: b.events(10 ** 9),
      schemaFields: Object.keys(b.schema().fields),
      serializedSeed: parsed.seed,
      refusal,
      moved: after.x !== before.x || after.y !== before.y,
      worldIsSame: window.world === b.world,
      worldTick: window.world.tick,
      frozen: Object.isFrozen(b),
    }
  })

  check(typeof s.help === 'string' && s.help.includes('sporefall.verb'), 'prod: help() documents the API')
  check(typeof s.version === 'string' && s.version.length > 0, 'prod: version() reports a build')
  check(s.tickType === 'number' && s.tick > 10, 'prod: tick() advances')
  check(s.session.mode === 'solo' && s.session.paused === false, 'prod: session() has {mode, paused}')
  check(s.session.seed === 7, 'prod: session() carries the seed')
  check(s.playerHasCtl, 'prod: player() returns the playerCtl entity')
  check(s.npcCount > 0, 'prod: entities("npc") finds NPCs on the deployed-style build')
  check(s.doorsAllDoors, 'prod: entities("door") all carry the door component')
  check(s.predicateCount === 1, 'prod: predicate-string filter compiles and matches the player')
  check(s.lowHpIsArray, 'prod: predicate filters return arrays')
  check(s.entityById !== undefined, 'prod: entity(id) round-trips')
  check(typeof s.mission.description === 'string', 'prod: mission() has a description')
  check(Array.isArray(s.events) && s.events.every((e) => typeof e.tick === 'number'), 'prod: events() tagged with ticks')
  check(s.eventsSinceFuture.length === 0, 'prod: events(sinceTick) filters')
  check(s.schemaFields.includes('pos'), 'prod: schema() reflects components')
  check(s.serializedSeed === 7, 'prod: serialize() is a parseable WorldJson')
  check(typeof s.refusal === 'string' && s.refusal.includes('?debug'), 'prod: verb() refuses and explains the ?debug gate')
  check(!s.moved, 'prod: refused verb mutated nothing')
  check(s.worldIsSame && typeof s.worldTick === 'number', 'prod: window.world is the same live world')
  check(s.frozen, 'prod: namespace is frozen')
  check(
    consoleLines.some((l) => l.includes('sporefall') && l.includes('window.world')),
    'prod: boot console line advertises the surface',
  )
  check(pageErrors.length === 0, `prod: no page errors (${pageErrors.join(' | ')})`)
  await page.close()
}

// ---- 2. ?debug: verbs live ----
{
  const { page, pageErrors } = await boot({ mode: 'solo', seed: 7, debug: '' })
  const s = await page.evaluate(() => {
    const b = window.sporefall
    const id = b.player().id
    const reply = JSON.parse(b.verb('teleport', `${id} 3 3`))
    const pos = b.entity(id).pos
    const state = JSON.parse(b.verb('state'))
    return { reply, pos, stateTick: state.tick, worldPos: window.world.byId.get(id).pos }
  })
  check(s.reply.pos.x === 3 && s.reply.pos.y === 3, 'debug: verb(teleport) answers with the new pos')
  check(s.pos.x === 3 && s.pos.y === 3, 'debug: teleport is visible through entity()')
  check(s.worldPos.x === 3 && s.worldPos.y === 3, 'debug: teleport landed in the live world')
  check(typeof s.stateTick === 'number', 'debug: read verbs (state) answer too')
  check(pageErrors.length === 0, `debug: no page errors (${pageErrors.join(' | ')})`)
  await page.close()
}

// ---- 3. ?e2e: legacy hooks are aliases of the canonical surface ----
{
  const { page, pageErrors } = await boot({ mode: 'solo', seed: 7, e2e: '' })
  const s = await page.evaluate(() => {
    const state = JSON.parse(window.__verb('state'))
    return {
      sameWorld: window.__world === window.world && window.__world === window.sporefall.world,
      stateTick: state.tick,
      verbWrites: JSON.parse(window.__verb(`teleport ${window.sporefall.player().id} 4 4`)).pos.x === 4,
    }
  })
  check(s.sameWorld, 'e2e: __world aliases window.world / sporefall.world')
  check(typeof s.stateTick === 'number', 'e2e: __verb still answers verbs')
  check(s.verbWrites, 'e2e: __verb still writes (the ?e2e gate)')
  check(pageErrors.length === 0, `e2e: no page errors (${pageErrors.join(' | ')})`)
  await page.close()
}

await browser.close()

if (failures.length) {
  console.error(`\n[ai-inspection] ${failures.length} FAILURE(S):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\n[ai-inspection] OK — all asserts passed')
