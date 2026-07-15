import type { RenderView } from '../app/session'
import { CLASSES } from '../game/data/classes'
import { WEAPONS } from '../game/data/items'
import { OBJECTS } from '../game/data/objects'
import type { Entity } from '../game/entity'
import { nearestInteractable } from '../game/systems/interaction'
import { hasThrowable } from '../ui/hotbarModel'

/** Live text + enabled state for the action buttons, derived each frame. */
export interface TouchLabels {
  atk: string
  use: string
  useEnabled: boolean
  spc: string
  spcEnabled: boolean
  /** The THROW button only lights up when a throwable is carried. */
  throwEnabled: boolean
}

/** The verb the USE button is about to perform on the nearest interactable —
 * mirrors handleInteract's object/door branch so the label matches the action. */
const useLabel = (target: Entity): string => {
  const obj = OBJECTS[target.archetype]
  if (obj?.use) return obj.name
  if (target.door) return target.door.locked ? 'Unlock' : target.door.open ? 'Close' : 'Open'
  switch (target.interact?.verb) {
    case 'talk':
      return 'Talk'
    case 'pickup':
      return 'Grab'
    case 'open':
      return 'Open'
    default:
      return 'Use'
  }
}

/** Pure view → button-label mapping, unit-tested apart from the DOM. */
export const computeTouchLabels = (view: RenderView): TouchLabels => {
  const self = view.self
  if (!self) return { atk: 'ATK', use: 'USE', useEnabled: false, spc: 'SPC', spcEnabled: false, throwEnabled: false }
  const target = nearestInteractable(view.entities, self)
  const cls = CLASSES[self.playerCtl?.classId ?? '']
  const cd = self.playerCtl?.abilityCooldown ?? 0
  return {
    atk: WEAPONS[self.combat?.weapon ?? 'fists']?.name ?? 'Fists',
    use: target ? useLabel(target) : 'USE',
    useEnabled: !!target,
    spc: cls ? (cd > 0 ? `${cls.abilityName} ${Math.ceil(cd / 30)}s` : cls.abilityName) : 'SPC',
    spcEnabled: cd <= 0,
    throwEnabled: hasThrowable(self.playerCtl?.inventory ?? []),
  }
}
