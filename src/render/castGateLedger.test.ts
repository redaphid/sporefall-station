// The cast ship gate may change only through docs/cast-walks/GATE-CHANGES.md.
// scripts/assets/gate_hash.py hashes exactly the content that decides a
// cast_walk.py gate verdict; this suite fails the merge gate when that hash is
// not the ledger's head, and proves the hash moves on a semantic edit and
// nowhere else. Aaron, 2026-09-29: "find a way to prevent gate bypassing like
// this. If we have to change them, it should be deliberate and reasoned."
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = process.cwd()
const ASSETS = 'scripts/assets'
const LEDGER = 'docs/cast-walks/GATE-CHANGES.md'
const SANDBOX_FILES = [
  ...['gate_hash.py', 'cast_walk.py', 'cast-gate-spec.json', 'consistency-spec.json', 'verify.py', 'consistency.py',
    'spritesheet.py'].map((f) => `${ASSETS}/${f}`),
  LEDGER,
  'public/themes/swampspace-hires/CURATION.md',
  'public/themes/swampspace/CURATION.md',
]
const APPROVED = 'Aaron "yes, change it" (2026-10-01)'

type Run = { status: number | null; out: string }

function python(cwd: string, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('python3', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  if (r.error) throw new Error(`python3 did not run (${r.error.message}); the gate ledger check needs it`)
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const gateHash = (root: string, ...args: string[]) => python(root, [`${ASSETS}/gate_hash.py`, ...args])
const hashOf = (root: string) => gateHash(root).out.trim().split('\n').pop()!

let sandboxes: string[] = []
afterEach(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true })
  sandboxes = []
})

/** A copy of the gate files and the ledger, laid out like the repo. */
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-ledger-'))
  sandboxes.push(root)
  for (const rel of SANDBOX_FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    cpSync(join(REPO, rel), join(root, rel))
  }
  return root
}

/** Replace text that must exist, so a stale anchor fails loudly instead of testing nothing. */
function edit(root: string, rel: string, from: string, to: string) {
  const path = join(root, rel)
  const text = readFileSync(path, 'utf8')
  expect(text.includes(from), `${rel} no longer contains ${JSON.stringify(from)}`).toBe(true)
  writeFileSync(path, text.replace(from, to))
}

type GateSpec = {
  seam_max: number
  _seam: string
  judge: Record<string, number>
  seam_exception?: Record<string, Record<string, number>>
}
type ConsistencySpec = Record<string, { ref_frame: string; ref: Record<string, number>; tol: Record<string, number> }>

function editJson<T>(root: string, rel: string, change: (spec: T) => void, indent = 1) {
  const path = join(root, rel)
  const spec = JSON.parse(readFileSync(path, 'utf8')) as T
  change(spec)
  writeFileSync(path, JSON.stringify(spec, null, indent))
}

function lastEntry(root: string): number {
  const ns = [...readFileSync(join(root, LEDGER), 'utf8').matchAll(/^## G(\d+)\b/gm)].map((m) => Number(m[1]))
  return Math.max(...ns)
}

function addEntry(root: string, hash: string, { kind = 'all', approvedBy = APPROVED } = {}) {
  appendFileSync(join(root, LEDGER), `
## G${lastEntry(root) + 1} · test

- Hash: \`${hash}\`
- Commit: test
- Kind: ${kind}
- Changed: seam_max 0.5 to 0.6.
- Why the old rule was wrong: the approved frog measures 0.55 on a loop a viewer cannot tell from 0.4.
- Old gate vs new on the shipped cast: frog se FAIL to pass; every other shipped loop unchanged.
- Negative controls: a clip that turns around mid-stride still fails at 1.8.
- Approved-by: ${approvedBy}
`)
}

describe('the committed cast gate', () => {
  it('is the head of GATE-CHANGES.md', () => {
    const r = gateHash(REPO, '--check')
    expect(r.out).toMatch(/^ok {2}gate [0-9a-f]{16} is the head/)
    expect(r.status).toBe(0)
  })

  it('has a ledger whose every entry re-hashes from its commit', () => {
    const r = gateHash(REPO, '--history')
    expect(r.out).toContain("ok  every entry's commit hashes to its Hash")
    expect(r.status).toBe(0)
  })
})

describe('a gate change without a ledger entry', () => {
  it('fails --check with the way to make it deliberately, and passes once the entry is added', () => {
    const root = sandbox()
    editJson<GateSpec>(root, `${ASSETS}/cast-gate-spec.json`, (s) => { s.seam_max = 0.6 })
    const refused = gateHash(root, '--check')
    expect(refused.status).toBe(1)
    expect(refused.out).toContain('the gate changed with no ledger entry')
    expect(refused.out).toContain('Worker: do not change the gate')
    expect(refused.out).toContain('Approved-by: Aaron')

    addEntry(root, hashOf(root))
    const r = gateHash(root, '--check')
    expect(r.out).toContain('is the head of GATE-CHANGES.md')
    expect(r.status).toBe(0)
  })

  it('is refused when the new entry does not quote Aaron', () => {
    const root = sandbox()
    editJson<GateSpec>(root, `${ASSETS}/cast-gate-spec.json`, (s) => { s.seam_max = 0.6 })
    addEntry(root, hashOf(root), { approvedBy: 'none (pending Aaron)' })
    const r = gateHash(root, '--check')
    expect(r.out).toMatch(/Approved-by must quote Aaron/)
    expect(r.status).toBe(1)
  })

  it('is refused when an entry leaves out a field', () => {
    const root = sandbox()
    editJson<GateSpec>(root, `${ASSETS}/cast-gate-spec.json`, (s) => { s.seam_max = 0.6 })
    addEntry(root, hashOf(root))
    edit(root, LEDGER, '- Negative controls: a clip that turns', '- Nothing here: a clip that turns')
    const r = gateHash(root, '--check')
    expect(r.out).toMatch(/missing Negative controls/)
    expect(r.status).toBe(1)
  })

  it('stops cast_walk.py gate before it reads the run', () => {
    const root = sandbox()
    editJson<GateSpec>(root, `${ASSETS}/cast-gate-spec.json`, (s) => { s.judge.boil_max = 0.5 })
    const r = python(root, [`${ASSETS}/cast_walk.py`, 'gate', join(root, 'no-such-run'), '--kind', 'mycologist'])
    expect(r.out).toContain('REFUSED: the ship gate is not an approved version')
    expect(r.out).not.toContain('sheet.json')
    expect(r.status).not.toBe(0)
  })
})

describe('cast_walk.py gate on the approved gate', () => {
  it('passes the ledger check and names the gate version', () => {
    const root = sandbox()
    const r = python(root, [`${ASSETS}/cast_walk.py`, 'gate', join(root, 'no-such-run'), '--kind', 'mycologist'])
    expect(r.out).toMatch(/^gate [0-9a-f]{16} \(G\d+ in docs\/cast-walks\/GATE-CHANGES.md\)/)
    expect(r.out).toContain('no-such-run/sheet.json') // got past the check to the (missing) run
  })

  it.each(['VLM', 'VOTES', 'NUM_PREDICT'])('refuses a %s override of verify.py', (v) => {
    const root = sandbox()
    const r = python(root, [`${ASSETS}/cast_walk.py`, 'gate', join(root, 'no-such-run'), '--kind', 'mycologist'],
      { [v]: 'qwen3-vl:2b' })
    expect(r.out).toContain(`REFUSED: ${v} set`)
    expect(r.status).not.toBe(0)
  })
})

describe('a per-kind exception', () => {
  const addException = (root: string) =>
    editJson<GateSpec>(root, `${ASSETS}/cast-gate-spec.json`, (s) => { s.seam_exception = { 'mireclaw-stalker': { se: 1.4 } } })

  it('needs an entry whose Kind names that kind', () => {
    const root = sandbox()
    addException(root)
    addEntry(root, hashOf(root), { kind: 'all' })
    const r = gateHash(root, '--check')
    expect(r.out).toContain('seam_exception.mireclaw-stalker has no GATE-CHANGES.md entry with Kind: mireclaw-stalker')
    expect(r.status).toBe(1)
  })

  it('passes with an entry for exactly that kind', () => {
    const root = sandbox()
    addException(root)
    addEntry(root, hashOf(root), { kind: 'mireclaw-stalker' })
    expect(gateHash(root, '--check').status).toBe(0)
  })

  it('cannot be granted to several kinds in one entry', () => {
    const root = sandbox()
    addException(root)
    addEntry(root, hashOf(root), { kind: 'mireclaw-stalker, spore-drone' })
    const r = gateHash(root, '--check')
    expect(r.out).toMatch(/Kind is 'all' or exactly one kind/)
    expect(r.status).toBe(1)
  })
})

describe('a CURATION.md ship entry', () => {
  it('may cite only a gate the ledger has', () => {
    const root = sandbox()
    const cur = 'public/themes/swampspace-hires/CURATION.md'
    appendFileSync(join(root, cur), `\nGates: all PASS on gate ${hashOf(root)} (head).\n`)
    expect(gateHash(root, '--check').status).toBe(0)
    appendFileSync(join(root, cur), '\nGates: all PASS on gate `0123456789abcdef`.\n')
    const r = gateHash(root, '--check')
    expect(r.out).toContain('cites gate 0123456789abcdef, which no ledger entry has')
    expect(r.status).toBe(1)
  })
})

type Tamper = [name: string, apply: (root: string) => void]
const CAST_WALK = `${ASSETS}/cast_walk.py`
const SPEC = `${ASSETS}/cast-gate-spec.json`
const CONS_SPEC = `${ASSETS}/consistency-spec.json`

const KEEPS_HASH: Tamper[] = [
  ['cast-gate-spec.json re-indented', (r) => editJson<GateSpec>(r, SPEC, () => {}, 4)],
  ['a cast-gate-spec.json note reworded', (r) => editJson<GateSpec>(r, SPEC, (s) => { s._seam = 'reworded' })],
  ['comments and blank lines added to cast_walk.py', (r) => appendFileSync(join(r, CAST_WALK), '\n\n# a note\n\n')],
  ['a gate docstring reworded', (r) => edit(r, CAST_WALK, 'Gate 5 on one loop of raw video frames', 'Gate five, one loop')],
  ['spacing inside a gate constant', (r) => edit(r, CAST_WALK, 'BOIL_N, BOIL_DOWN, BOIL_R = 16, 2, 6',
    'BOIL_N,BOIL_DOWN,BOIL_R=16,2,6')],
  ['a new measured consistency ref (export re-derives it)', (r) =>
    editJson<ConsistencySpec>(r, CONS_SPEC, (s) => { s.mycologist.ref.mass += 100; s.mycologist.ref.height += 3 })],
  ['a new kind written with the default tolerances', (r) => editJson<ConsistencySpec>(r, CONS_SPEC, (s) => {
    s['new-kind'] = { ref_frame: 's-idle', ref: s.mycologist.ref, tol: { height: 2, width: 3, head_h: 2, mass_frac: 0.22,
      cx: 2.5, foot_y: 1 } }
  })],
  ['the contact sheet (not a gate) changed', (r) => edit(r, CAST_WALK, 's, lab = 2, 14', 's, lab = 3, 14')],
  ['spritesheet.py outside the loop finders changed', (r) => edit(r, `${ASSETS}/spritesheet.py`,
    "frames from {loop['start']}, seam", "frames, start {loop['start']}, seam")],
]

const MOVES_HASH: Tamper[] = [
  ['seam_max', (r) => editJson<GateSpec>(r, SPEC, (s) => { s.seam_max = 0.51 })],
  ['a pinned judge limit', (r) => editJson<GateSpec>(r, SPEC, (s) => { s.judge.sharpness_min = 55 })],
  ['a per-kind silhouette tolerance', (r) => editJson<ConsistencySpec>(r, CONS_SPEC, (s) => { s.mycologist.tol.width = 4 })],
  ['a kind\'s reference frame', (r) => editJson<ConsistencySpec>(r, CONS_SPEC, (s) => { s.mycologist.ref_frame = 'se-idle' })],
  ['consistency.py DEFAULT_TOL', (r) => edit(r, `${ASSETS}/consistency.py`, '"width": 3,       # +/- px',
    '"width": 4,       # +/- px')],
  ['the VLM model', (r) => edit(r, `${ASSETS}/verify.py`, '"qwen3-vl:8b-instruct")', '"qwen3-vl:2b-instruct")')],
  ['a VLM prompt', (r) => edit(r, `${ASSETS}/verify.py`, 'cannot show what is on the front', 'may show the front')],
  ['a comparison in gate 5', (r) => edit(r, CAST_WALK, 'rep["boil"] <= lim["boil_max"]', 'rep["boil"] <= 2 * lim["boil_max"]')],
  ['a new helper in cast_walk.py', (r) => appendFileSync(join(r, CAST_WALK), '\n\ndef seam_bonus(kind):\n    return 0.2\n')],
  ['the seam loop finder', (r) => edit(r, `${ASSETS}/spritesheet.py`, 'tol: float = 1.5', 'tol: float = 2.0')],
]

describe('the gate hash', () => {
  const base = hashOf(REPO)

  it.each(KEEPS_HASH)('stays the same: %s', (_, apply) => {
    const root = sandbox()
    apply(root)
    expect(hashOf(root)).toBe(base)
  })

  it.each(MOVES_HASH)('moves: %s', (_, apply) => {
    const root = sandbox()
    apply(root)
    expect(hashOf(root)).toMatch(/^[0-9a-f]{16}$/)
    expect(hashOf(root)).not.toBe(base)
  })
})
