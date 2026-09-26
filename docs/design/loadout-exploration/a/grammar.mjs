// Enumerates the Primer/Striker reaction grammar and counts the space.
const SUB = { none: [], soak: ['conducts', 'douses'], oil: ['flammable'], rime: ['brittle'], magnet: ['networked'] }
const VERB = { impact: 'kinetic', spark: 'electric', flame: 'heat', frost: 'cold' }
const MEDIUM = { electric: 'conducts', heat: 'flammable', cold: 'conducts' }
const react = (s, v) => {
  const props = [].concat(...s.split('&').map((k) => SUB[k])), kind = VERB[v], out = []
  if (props.includes('networked') && kind !== 'kinetic') out.push(`hop-${kind}`)
  if (MEDIUM[kind] && props.includes(MEDIUM[kind])) out.push(`propagate-${kind}`)
  if (kind === 'heat' && props.includes('douses')) out.push('steam-blind')
  if (kind === 'heat' && props.includes('brittle')) out.push('melt-to-soak')
  if (kind === 'cold' && props.includes('brittle')) out.push('deep-freeze')
  if (kind === 'kinetic' && props.includes('brittle')) out.push('crack-bonus')
  if (kind === 'electric' && props.includes('flammable')) out.push('ignite')
  if (kind === 'cold' && props.includes('flammable')) out.push('FIZZLE')
  if (!out.length) out.push(s === 'none' ? `plain-${v}` : `plain-${v}+keeps-${s}`)
  return out.join('+')
}
const rows = []
for (const s of Object.keys(SUB)) for (const v of Object.keys(VERB)) rows.push([s, v, react(s, v)])
console.table(rows)
const distinct = new Set(rows.map((r) => r[2]))
console.log('substance x verb cells', rows.length, 'distinct outcomes', distinct.size)
const plainish = [...distinct].filter((o) => o.startsWith('plain')).length
console.log('named reactions (non-plain)', distinct.size - plainish)
// Delivery classes change WHO gets primed / triggered; each pair of classes is a distinct tactical footprint.
const DELIV = ['single', 'line', 'area', 'fan', 'ricochet', 'seek']
console.log('raw signatures (outcome x primer delivery x striker delivery)', distinct.size * DELIV.length ** 2)
// Footprints that differ in play: collapse seek into single, ricochet into line (both reach past cover but hit one lane).
const PLAY = ['single', 'line', 'area', 'fan']
console.log('play-distinct signatures', distinct.size * PLAY.length ** 2)
// Today (default fold): the element survivor decides the verb; behaviours are delivery only.
console.log('today default verbs', ['plain', 'frozen', 'burning', 'electrified'].length, 'today default signatures', 4 * PLAY.length)

// Layered primes: a primer with two substance payloads alternates casts, so one body can carry two.
const subs = ['soak', 'oil', 'rime', 'magnet']
const layers = ['none', ...subs]
for (let i = 0; i < subs.length; i++) for (let j = i + 1; j < subs.length; j++) layers.push(`${subs[i]}&${subs[j]}`)
const lay = new Set()
for (const s of layers) for (const v of Object.keys(VERB)) lay.add(react(s, v))
console.log('prime states', layers.length, 'x verbs 4 =', layers.length * 4, 'cells; distinct outcomes with layering', lay.size)
console.log('play-distinct signatures with layering', lay.size * PLAY.length ** 2)
