// Bit-exact vector maths for the SIMULATION. This file exists for determinism,
// not for style — please read before "tidying" `vlen` back into `Math.hypot`.
//
// WHY. `Math.hypot` is implementation-defined: ECMA-262 explicitly allows an
// implementation-approximated result, so Android's WebView and desktop V8 are
// free to disagree in the last bits. That is enough to reject a replay and to
// desync a co-op session, because sim positions feed forward tick over tick and
// a last-digit disagreement compounds.
//
// `+`, `-`, `*` and `Math.sqrt` are the opposite: IEEE 754 REQUIRES each of them
// to be correctly rounded, so `Math.sqrt(x * x + y * y)` produces the SAME BITS
// on every conforming engine. Changing the algorithm is the whole point.
//
// THE TRADE, STATED HONESTLY. This is NOT a value-preserving refactor.
// `Math.hypot` is written to dodge intermediate overflow/underflow and is often
// the more accurate of the two. Measured over 2.5M real sim calls, 34% of
// results move — but never by more than 2 ULP (max relative delta 4.4e-16). We
// accept a last-digit accuracy loss to buy an exact-everywhere guarantee: a sim
// that agrees with itself across devices is worth more here than one that sits
// marginally closer to the real-valued answer.
//
// THE RANGE CAVEAT — THE EQUIVALENCE IS NOT UNIVERSAL. `x * x` overflows to
// Infinity above |x| ~1.3e154, and underflows toward 0 below |x| ~1.5e-154,
// in both cases where `Math.hypot` would still return a good value. This
// substitution is sound HERE only because the sim's operands are bounded:
// positions live on a LEVEL_W x LEVEL_H (64x64) tile grid, and movement.ts
// snaps any velocity component below 0.01 to exactly 0, so nothing decays into
// the subnormal range. Measured extremes over that same soak: max |arg| 63.3,
// min non-zero |arg| 8.9e-16 — both roughly 140 orders of magnitude inside the
// safe band.
//
// So: use this for bounded simulation values. Do NOT reach for it for unbounded
// quantities (accumulated distances, unclamped impulses) — keep `Math.hypot`
// there, and say why at the call site.

/**
 * Length of the vector `(x, y)`, using only IEEE-754 correctly-rounded
 * operations so that every device computes identical bits.
 *
 * Named `vlen` rather than `len`/`dist` deliberately: both of those already
 * exist as local identifiers across the sim systems, and shadowing them would
 * turn a mechanical substitution into a silent behaviour change.
 */
export const vlen = (x: number, y: number): number => Math.sqrt(x * x + y * y)
