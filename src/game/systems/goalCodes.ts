// The goal codes the registry behaviors propose (behaviors.ts) and the AI
// executor steers by (ai.ts). A leaf module on purpose: ai.ts and behaviors.ts
// import each other, and ai.ts builds Sets of these codes at load. Read through
// that cycle, the codes could still be undefined when the Sets were built
// (vitest's loader hit this; tsx did not), so tests ran different group AI
// from the game. Nothing here imports anything.

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
