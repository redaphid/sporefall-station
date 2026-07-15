// Pure helpers for the inert on-screen annotation layer (see types.ts
// `Annotation`). This module NEVER runs inside a sim system — `tickWorld` does
// not touch `w.annotations`, so nothing here can affect determinism. It only
// validates/adds/removes annotations (driven by the debug `annotate` verb) and
// computes which are still visible for the render overlay. Keeping it a pure,
// side-effect-free module makes the adversarial validation trivially testable.

import type { Annotation, AnnotationKind } from './types'
import type { World } from './world'

export const ANNOTATION_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>([
  'text',
  'label',
  'pin',
  'arrow',
  'circle',
])

/** Caps on untrusted string fields so a debug client can't wedge a megabyte of
 * text into world state (which then serializes/replays). */
const MAX_TEXT = 240
const MAX_COLOR = 64
const MAX_ID = 128

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const finite = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`annotation ${what} must be a finite number`)
  return v
}

const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string') throw new Error(`annotation ${what} must be a string`)
  if (v.length > max) throw new Error(`annotation ${what} too long (${v.length} > ${max})`)
  return v
}

/**
 * Validate ONE untrusted annotation object and return a fresh, whitelisted copy —
 * only known fields are ever read, so a hostile `__proto__`/`constructor` key on
 * the input can never reach a prototype (we never touch it). Throws cleanly on any
 * malformed field so the verb transport turns it into an `ok:false` reply.
 *
 * `nextId` supplies an auto id when the caller omits one (the ergonomic path).
 */
export const sanitizeAnnotation = (raw: unknown, nextId: () => number): Annotation => {
  if (!isPlainObject(raw)) throw new Error('annotation must be a JSON object')
  const kind = raw.kind
  if (typeof kind !== 'string' || !ANNOTATION_KINDS.has(kind as AnnotationKind))
    throw new Error(`annotation kind must be one of ${[...ANNOTATION_KINDS].join('/')}`)

  const out: Annotation = { id: nextId(), kind: kind as AnnotationKind }
  if (raw.id !== undefined) {
    if (typeof raw.id === 'number') {
      if (!Number.isFinite(raw.id)) throw new Error('annotation id must be a finite number')
      out.id = raw.id
    } else if (typeof raw.id === 'string') {
      if (raw.id.length === 0 || raw.id.length > MAX_ID) throw new Error('annotation id string is empty or too long')
      out.id = raw.id
    } else {
      throw new Error('annotation id must be a number or string')
    }
  }
  if (raw.text !== undefined) out.text = str(raw.text, 'text', MAX_TEXT)
  if (raw.color !== undefined) out.color = str(raw.color, 'color', MAX_COLOR)
  if (raw.x !== undefined) out.x = finite(raw.x, 'x')
  if (raw.y !== undefined) out.y = finite(raw.y, 'y')
  if (raw.x2 !== undefined) out.x2 = finite(raw.x2, 'x2')
  if (raw.y2 !== undefined) out.y2 = finite(raw.y2, 'y2')
  if (raw.radius !== undefined) out.radius = finite(raw.radius, 'radius')
  if (raw.targetId !== undefined) out.targetId = finite(raw.targetId, 'targetId')
  if (raw.ttlTick !== undefined) out.ttlTick = finite(raw.ttlTick, 'ttlTick')

  // A shape/label needs SOMEWHERE to anchor: an entity (engine-positioned, the
  // recommended form) or an explicit world point. The `text` banner is screen-
  // space and needs neither (it defaults to a top-centre banner).
  if (kind !== 'text' && out.targetId === undefined && (out.x === undefined || out.y === undefined))
    throw new Error(`annotation kind "${kind}" needs a targetId or an x/y position`)

  return out
}

/** The smallest unused positive integer id — deterministic (no clock/random), so
 * two identical `annotate` calls on identical worlds assign identical ids. */
export const nextAnnotationId = (w: World): number => {
  let max = 0
  for (const a of w.annotations) if (typeof a.id === 'number' && a.id > max) max = a.id
  return max + 1
}

/** Validate + append one-or-many annotations. Returns the sanitized copies added. */
export const addAnnotations = (w: World, raw: unknown): Annotation[] => {
  const list = Array.isArray(raw) ? raw : [raw]
  // Assign ids up front against a moving high-water mark so a batch with no ids
  // gets distinct sequential ids in one call.
  let seq = nextAnnotationId(w) - 1
  const added = list.map((r) => sanitizeAnnotation(r, () => ++seq))
  w.annotations.push(...added)
  return added
}

/** Remove every annotation (no id) or just the ones matching `id`. Returns count removed. */
export const clearAnnotations = (w: World, id?: number | string): number => {
  const before = w.annotations.length
  if (id === undefined) {
    w.annotations.length = 0
  } else {
    w.annotations = w.annotations.filter((a) => a.id !== id)
  }
  return before - w.annotations.length
}

/** Annotations still worth drawing at `tick`: a `ttlTick` expires the mark once
 * the tick reaches it (visible strictly before). Pure — the overlay calls it. */
export const visibleAnnotations = (annotations: readonly Annotation[], tick: number): Annotation[] =>
  annotations.filter((a) => a.ttlTick === undefined || tick < a.ttlTick)
