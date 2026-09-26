// Prints the #87 `element-verbs` stage as a WorldJson on stdout: a fresh solo
// run (seed from argv, default 7) built exactly as HostSession does, then the
// scenario. e2e/feature-element-verbs.mjs injects it via ?world=@inline so the
// recording starts at tick 0, with the shock's leap still on screen.
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { applyScenario } from '../../src/game/scenarios'
import { serializeWorld } from '../../src/game/serialize'
import { playerSpawnPoint } from '../../src/game/spawnPlacement'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'

const seed = Number(process.argv[2] ?? 7)
const w = createWorld(seed, 1)
populateWorld(w)
setupFloor(w)
const at = playerSpawnPoint(w.level, 0)
spawnPlayer(w, 0, at.x, at.y)
if (!applyScenario(w, 'element-verbs')) throw new Error('element-verbs scenario missing')
process.stdout.write(JSON.stringify(serializeWorld(w)))
