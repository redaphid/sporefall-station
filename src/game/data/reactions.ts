// Design B's reaction table: what happens when an element lands on a body that
// already carries a status. The status on the body is the PRIMER, the element
// arriving is the INCOMING half. Pure data, total by construction: every
// (primer, incoming) cell is written out, so a missing cell is a compile error.
//
// Only reactive-wand runs read this (World.modCasting === 'reactive'). The
// prototype slice implements five outcomes; the design's other cells (flash
// freeze, steam, wildfire, quench) are 'apply' here until they are built.

export type Primer = 'wet' | 'frozen' | 'burning' | 'electrified'
/** An element status, or `impact`: a round that carries no element at all. */
export type Incoming = Primer | 'impact'

export type ReactionId = 'chain' | 'thermalCrack' | 'shatter' | 'fizzle' | 'numb'

/** `apply` = no interaction: the incoming status lands normally (or, for a bare
 * impact, the blow is just damage). */
export type Outcome = 'apply' | ReactionId

export const REACTIONS: Record<Primer | 'none', Record<Incoming, Outcome>> = {
  none: { wet: 'apply', frozen: 'apply', burning: 'apply', electrified: 'apply', impact: 'apply' },
  // Water conducts: lightning floods every connected wet body. Fire into water
  // is wasted, and it dries the body off.
  wet: { wet: 'apply', frozen: 'apply', burning: 'fizzle', electrified: 'chain', impact: 'apply' },
  // Ice: fire cracks it into meltwater (the body is left wet), only a BARE
  // impact shatters it, and any other element is numbed (nothing lands).
  frozen: { wet: 'numb', frozen: 'numb', burning: 'thermalCrack', electrified: 'numb', impact: 'shatter' },
  burning: { wet: 'apply', frozen: 'apply', burning: 'apply', electrified: 'apply', impact: 'apply' },
  electrified: { wet: 'apply', frozen: 'numb', burning: 'apply', electrified: 'apply', impact: 'apply' },
}

/** Which status on a body acts as the primer when it carries several. Ice
 * first (it changes what an impact does), then water (it conducts). */
export const PRIMER_ORDER: readonly Primer[] = ['frozen', 'wet', 'burning', 'electrified']

export const isPrimer = (s: string): s is Primer => (PRIMER_ORDER as readonly string[]).includes(s)

/** Thermal Crack: the thaw's burst of damage (tagged `frozen` for resist). */
export const THERMAL_CRACK_DAMAGE = 30
