// Every goal code the AI can adopt: the core drives goals.ts scores, the codes
// the registry behaviors propose (behaviors.ts), and the ones the AI executor
// steers by (ai.ts). A leaf module on purpose: ai.ts, goals.ts and behaviors.ts
// sit on import cycles through world.ts, and ai.ts and behaviors.ts build
// values from these at load. Read through a cycle, a code could still be
// undefined when read (vitest) or throw (native ESM), so tests ran different
// AI from the game. Nothing here imports anything; scripts/check-init-order.mts
// (run by initOrder.test.ts) catches a load-time read across a cycle.

export const WANDER = 'wander'
export const BATTLE = 'battle'
export const PURSUE = 'pursue'
export const FLEE = 'flee'
export const INVESTIGATE = 'investigate'
/** Baseline desirability of wandering — the floor every drive competes against. */
export const WANDER_SCORE = 1

export const PATROL = 'patrol'
export const SEARCH = 'search'
export const ALERT = 'alert'
export const SCAVENGE = 'scavenge'
export const FORMUP = 'formup'
export const STACK = 'stack'
export const FLANK = 'flank'
export const DRAWN = 'drawn'
export const WORK = 'work'
export const GARRISON = 'garrison'
export const FORTIFY = 'fortify'
export const RETREAT = 'retreat'
export const STAGE = 'stage'
export const GUARD = 'guard'
export const EMPLACE = 'emplace'
export const BREACH = 'breach'
export const FALLBACK = 'fallback'
export const TEND = 'tend'
export const RING = 'ring'
