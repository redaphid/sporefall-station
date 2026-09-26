// Measure each draft trait (data/traits.ts) through the headless playtest CLI:
// stage one situation where the trait should change the outcome, play it twice
// (bare, then holding the trait), and print the numbers side by side.
//
//   node scripts/test/trait-measure.mjs [outDir]
//
// Every step is a real `npx tsx scripts/playtest.mts <state> <verb>` call, so the
// run is the same one an agent would type. The stage is seed 31337 floor 1's open
// street (x 12-16), with the floor's own cast removed from the state file so only
// the staged actors act, and the world set hostile so a staged enemy fights.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? 'e2e/output/trait-measure'
mkdirSync(OUT, { recursive: true })
const SEED = 31337

const pt = (file, ...args) => {
  const out = execFileSync('npx', ['tsx', 'scripts/playtest.mts', file, ...args], { encoding: 'utf8' }).trim()
  return JSON.parse(out)
}
const readWorld = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeWorld = (file, w) => writeFileSync(file, JSON.stringify(w))
const hpOf = (e) => e.health?.hp ?? 0

/** A fresh stage: the real floor, its cast cleared, hostile, the player at (x,y). */
const stage = (name, trait, x = 14.5, y = 10.5) => {
  const file = join(OUT, `${name}-${trait ?? 'bare'}.json`)
  const look = pt(file, 'new', '--seed', String(SEED))
  const w = readWorld(file)
  w.entities = w.entities.filter((e) => !e.ai)
  w.hostile = true
  writeWorld(file, w)
  const pid = look.player.id
  pt(file, 'teleport', String(pid), String(x), String(y))
  pt(file, 'set', String(pid), JSON.stringify({ health: { iframes: 0 } }))
  if (trait) pt(file, 'addTrait', String(pid), trait)
  return { file, pid }
}
const spawn = (file, kind, arch, x, y, patch) => {
  const e = pt(file, 'spawn', kind, arch, String(x), String(y))
  if (patch) pt(file, 'set', String(e.id), JSON.stringify(patch))
  return e.id
}
const get = (file, id) => pt(file, 'get', String(id))

const scenes = {
  // A flamethrower gangster 4 tiles off; the player stands and takes it for 5 s.
  fireproof: (trait) => {
    const { file, pid } = stage('fireproof', trait)
    spawn(file, 'npc', 'gangster', 14.5, 14.5, { combat: { weapon: 'flamethrower', cooldown: 0 }, health: { hp: 9999, max: 9999 } })
    let burningTicks = 0
    for (let i = 0; i < 15; i++) {
      pt(file, 'step', '10')
      if (get(file, pid).fx?.burning) burningTicks += 10
    }
    const p = get(file, pid)
    return { hpLost: 120 - hpOf(p), burningTicks, downed: !!p.playerCtl.downed }
  },
  // A brute at arm's length clawing a player who stands still: how long until
  // they go down, and how long the brute spends zapped.
  staticSkin: (trait) => {
    const { file, pid } = stage('staticSkin', trait)
    const brute = spawn(file, 'npc', 'brute', 14.5, 11.7, { health: { hp: 9999, max: 9999 } })
    let zappedTicks = 0
    let downedAt = 'standing after 300'
    for (let t = 5; t <= 300; t += 5) {
      pt(file, 'step', '5')
      if (get(file, brute).fx?.electrified) zappedTicks += 5
      if (get(file, pid).playerCtl.downed) {
        downedAt = t
        break
      }
    }
    return { ticksUntilDowned: downedAt, bruteZappedTicks: zappedTicks }
  },
  // A sledgehammer thug at arm's length; how far it shoves the player, and for
  // how long it stuns them, over 5 s. Then a roll down the open street.
  anchor: (trait) => {
    const { file, pid } = stage('anchor', trait)
    spawn(file, 'npc', 'thug', 14.5, 11.6, { combat: { weapon: 'sledgehammer', cooldown: 0 }, health: { hp: 9999, max: 9999 } })
    let shoved = 0
    let stunnedTicks = 0
    let last = get(file, pid).pos
    for (let i = 0; i < 30; i++) {
      pt(file, 'step', '5')
      const p = get(file, pid)
      shoved += Math.hypot(p.pos.x - last.x, p.pos.y - last.y)
      last = p.pos
      if (p.status?.stun > 0) stunnedTicks += 5
    }
    const hp = hpOf(get(file, pid))
    const roll = stage('anchor-roll', trait, 14.5, 3.5)
    pt(roll.file, 'step', '1', JSON.stringify({ moveY: 1, roll: true }))
    pt(roll.file, 'step', '20')
    const rolled = get(roll.file, roll.pid).pos.y - 3.5
    return { shovedTiles: +shoved.toFixed(2), stunnedTicks, hpLost: 120 - hp, rollTiles: +rolled.toFixed(2) }
  },
  // The same sledgehammer thug, but the player shoots back: shoves and stuns
  // cost aim time, so who drops first?
  anchorFight: (trait) => {
    const { file, pid } = stage('anchorFight', trait)
    const thug = spawn(file, 'npc', 'thug', 14.5, 11.6, { combat: { weapon: 'sledgehammer', cooldown: 0 } })
    for (let t = 5; t <= 300; t += 5) {
      pt(file, 'step', '5', JSON.stringify({ aimAt: thug, attack: true }))
      const p = get(file, pid)
      const foe = readWorld(file).entities.find((e) => e.id === thug)
      if (!foe || foe.dead || hpOf(foe) <= 0) return { outcome: 'thug down', ticks: t, hpLeft: hpOf(p) }
      if (p.playerCtl.downed) return { outcome: 'player downed', ticks: t, thugHpLeft: hpOf(foe) }
    }
    return { outcome: 'timeout' }
  },
  // Firing a pistol for 1 s: does a pod asleep 5 tiles behind wake, and does a
  // crew member 8 tiles off raise the alarm?
  softSteps: (trait) => {
    const { file, pid } = stage('softSteps', trait)
    const pod = spawn(file, 'npc', 'pod', 14.5, 15.5, { ai: { dormant: true, wakeOn: ['noise'] } })
    const w = readWorld(file)
    w.hostile = false
    writeWorld(file, w)
    spawn(file, 'npc', 'civilian', 14.5, 2.5, { ai: { faction: 'civ', mode: 'idle' } })
    pt(file, 'step', '30', JSON.stringify({ attack: true, aimX: 1, aimY: 0 }))
    const after = readWorld(file)
    return { podWoke: !get(file, pod).ai.dormant, alarmHeat: after.mission.heat ?? 0, alarm: after.alarm, player: pid }
  },
  // Explosive rounds into a target 1.3 tiles away for 2 s.
  blastproof: (trait) => {
    const { file, pid } = stage('blastproof', trait)
    pt(file, 'addMod', String(pid), 'explosive')
    const target = spawn(file, 'npc', 'pod', 14.5, 11.8, { ai: { dormant: true, wakeOn: [] }, health: { hp: 9999, max: 9999 } })
    pt(file, 'step', '60', JSON.stringify({ aimAt: target, attack: true }))
    const p = get(file, pid)
    return { hpLost: 120 - hpOf(p), targetHpLost: 9999 - hpOf(get(file, target)), downed: !!p.playerCtl.downed }
  },
  // A teammate goes down 2 tiles away (beyond a bare player's 1.3 reach) and 1
  // tile away: ticks until they are back up.
  medicHands: (trait) => {
    const reviveTicks = (gap) => {
      const { file } = stage(`medicHands-${gap}`, trait)
      const mate = spawn(file, 'player', 'player', 14.5, 10.5 + gap, {
        playerCtl: { downed: { bleedTicks: 900, reviveProgress: 0 } },
        health: { hp: 0, iframes: 0 },
      })
      for (let t = 5; t <= 150; t += 5) {
        pt(file, 'step', '5')
        if (!get(file, mate).playerCtl.downed) return t
      }
      return 'not revived in 150'
    }
    return { reviveTicksAt1: reviveTicks(1), reviveTicksAt2: reviveTicks(2) }
  },
  // A bat thug between two players: 2 tiles from P1, 4 from P2. The trait goes on P2.
  taunt: (trait) => {
    const { file, pid } = stage('taunt', null)
    const p2 = spawn(file, 'player', 'player', 14.5, 16.5, { health: { iframes: 0 } })
    if (trait) pt(file, 'addTrait', String(p2), trait)
    spawn(file, 'npc', 'thug', 14.5, 12.5, { combat: { weapon: 'bat', cooldown: 0 }, health: { hp: 9999, max: 9999 } })
    pt(file, 'step', '150')
    return { p1HpLost: 120 - hpOf(get(file, pid)), p2TaunterHpLost: 120 - hpOf(get(file, p2)) }
  },
  // Scout Eye changes no sim number; it shows a brute's tags ("weak: fire,
  // tough: bullets"). Measured here: what acting on the tag is worth, i.e. a
  // plain pistol vs one carrying the fire the tag points at, for 3 s.
  scoutEye: (trait) => {
    const { file, pid } = stage('scoutEye', trait)
    if (trait) pt(file, 'addMod', String(pid), 'incendiary')
    const brute = spawn(file, 'npc', 'brute', 14.5, 15, { ai: { dormant: true, wakeOn: [] }, health: { hp: 600, max: 600 } })
    pt(file, 'step', '90', JSON.stringify({ aimAt: brute, attack: true }))
    const b = get(file, brute)
    return { bruteResist: b.resist, bruteHpLost: 600 - hpOf(b), shotWith: trait ? 'incendiary (acting on the tag)' : 'plain pistol' }
  },
}

/** A scene named for a variant plays its base trait. */
const TRAIT_OF = { anchorFight: 'anchor' }

const only = process.argv[3]
const results = {}
for (const [name, run] of Object.entries(scenes)) {
  if (only && name !== only) continue
  results[name] = { bare: run(null), trait: run(TRAIT_OF[name] ?? name) }
  console.log(name, JSON.stringify(results[name]))
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
