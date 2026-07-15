// Data-driven element table. Each element is a status effect with optional
// per-tick behavior; later milestones fill in the stubbed ones. `dot` is hp
// lost per tick while the effect is active, applied generically by elementSystem.

export interface ElementDef {
  id: string
  /** hp lost per damage tick while active (0 = no damage-over-time). */
  dot: number
  /** ticks between damage ticks — burning gnaws on a timer, not every frame. */
  interval: number
  /** default lifetime in ticks when the effect is applied. */
  durationTicks: number
}

export const ELEMENTS: Record<string, ElementDef> = {
  burning: { id: 'burning', dot: 2, interval: 9, durationTicks: 600 },
  frozen: { id: 'frozen', dot: 0, interval: 30, durationTicks: 90 },
  wet: { id: 'wet', dot: 0, interval: 30, durationTicks: 150 },
  electrified: { id: 'electrified', dot: 0, interval: 30, durationTicks: 30 },
  poisoned: { id: 'poisoned', dot: 1, interval: 15, durationTicks: 120 },
}
