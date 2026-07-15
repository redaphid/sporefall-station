/**
 * Pure press-to-join + hotplug reducer. Given the previous pad->slot map, the
 * pad indices present this frame, and the indices currently pressing a join
 * button, produce the new map plus join/leave events. Slots are stable player
 * lanes: a survivor keeps its slot, a disconnect frees it, a new joiner takes
 * the lowest free one.
 */
export type AssignEvent =
  | { type: 'join'; padIndex: number; slot: number }
  | { type: 'leave'; padIndex: number; slot: number }

export interface AssignResult {
  assignments: Map<number, number>
  events: AssignEvent[]
}

const lowestFree = (used: Set<number>): number => {
  let slot = 0
  while (used.has(slot)) slot++
  return slot
}

export const assignPads = (
  prev: Map<number, number>,
  connected: number[],
  joining: number[],
): AssignResult => {
  const assignments = new Map<number, number>()
  const events: AssignEvent[] = []

  for (const [padIndex, slot] of prev) {
    if (connected.includes(padIndex)) assignments.set(padIndex, slot)
    if (!connected.includes(padIndex)) events.push({ type: 'leave', padIndex, slot })
  }

  const used = new Set(assignments.values())
  for (const padIndex of joining) {
    if (assignments.has(padIndex)) continue
    const slot = lowestFree(used)
    used.add(slot)
    assignments.set(padIndex, slot)
    events.push({ type: 'join', padIndex, slot })
  }

  return { assignments, events }
}
