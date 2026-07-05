export const SIM_RATE = 30
export const SIM_DT = 1 / SIM_RATE
export const LEVEL_W = 64
export const LEVEL_H = 64

export type EntityId = number

export interface Vec2 {
  x: number
  y: number
}

export interface InputCmd {
  seq: number
  moveX: number // -1..1
  moveY: number // -1..1
  attack: boolean
  interact: boolean
  special: boolean
  aimX: number
  aimY: number
}

export const emptyInput = (): InputCmd => ({
  seq: 0,
  moveX: 0,
  moveY: 0,
  attack: false,
  interact: false,
  special: false,
  aimX: 1,
  aimY: 0,
})

export type SimEvent =
  | { type: 'hit'; x: number; y: number; targetId: EntityId; amount: number }
  | { type: 'death'; x: number; y: number; entityId: EntityId }
  | { type: 'doorToggle'; entityId: EntityId; open: boolean }
  | { type: 'pickup'; entityId: EntityId; byId: EntityId; itemId: string }
  | { type: 'explosion'; x: number; y: number; radius: number }
  | { type: 'missionComplete'; description: string }
  | { type: 'floorChange'; floor: number }
  | { type: 'noise'; x: number; y: number }
  | { type: 'runOver'; floor: number }
