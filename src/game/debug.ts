// A tiny scripted-action surface for the e2e harness (only installed under
// ?e2e). It lets a black-box browser test drive interaction-matrix events —
// freeze, wet, shock, and a raw impact hit — by entity id, and reads back the
// immediate result before the next tick sweeps a shattered body away.

import { applyDamage } from './systems/combat'
import { freeze, shock, wet } from './systems/interactions'
import type { World } from './world'

export interface DebugApi {
  freeze: (id: number) => void
  wet: (id: number) => void
  shock: (id: number) => void
  hit: (id: number, dmg?: number) => { id: number; hp: number | null; dead: boolean; shattered: boolean } | null
}

export const createDebugApi = (w: World): DebugApi => ({
  freeze: (id) => {
    const e = w.byId.get(id)
    if (e) freeze(w, e)
  },
  wet: (id) => {
    const e = w.byId.get(id)
    if (e) wet(w, e)
  },
  shock: (id) => {
    const e = w.byId.get(id)
    if (e) shock(w, e)
  },
  hit: (id, dmg = 1) => {
    const e = w.byId.get(id)
    if (!e) return null
    applyDamage(w, e, dmg, e.pos.x - 1, e.pos.y, 0, 0)
    return { id, hp: e.health ? e.health.hp : null, dead: !!e.dead, shattered: !!e.shattered }
  },
})
