// Sanity: prove the byte-identical guarantee depends on RNG-state restore.
// Restoring the stream keeps ticks identical; resetting it (the old lossy path)
// diverges. Not a unit test — a one-off confirmation. Run: npx tsx <thisfile>
import { hashLabel, mulberry32 } from '../../src/game/rng'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { deserializeWorld, serializeWorld } from '../../src/game/serialize'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'

const build = () => {
  const w = createWorld(0xdecaf, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, 'soldier', sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  for (let i = 0; i < 50; i++) tickWorld(w, new Map([[0, { ...emptyInput(), moveX: -1, attack: true }]]))
  return w
}
const orig = build()
const json = serializeWorld(orig)
const good = deserializeWorld(json)
const bad = deserializeWorld(json)
bad.rng = mulberry32(hashLabel(json.seed >>> 0, `sim:${json.floor}`)) // reset to genesis
const inp = new Map([[0, { ...emptyInput(), moveX: 1, attack: true }]])
for (let i = 0; i < 40; i++) { tickWorld(orig, new Map(inp)); tickWorld(good, new Map(inp)); tickWorld(bad, new Map(inp)) }
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
console.log('good (rng restored) identical to original:', eq(serializeWorld(good), serializeWorld(orig)))
console.log('bad  (rng reset)    identical to original:', eq(serializeWorld(bad), serializeWorld(orig)))
