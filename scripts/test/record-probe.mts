import { GameHarness } from '../../src/debug/harness'
const dirs: [string, number, number][] = [['right+down', 1, 1], ['right', 1, 0], ['down', 0, 1]]
for (const [label, mx, my] of dirs) {
  const h = new GameHarness()
  h.create({ seed: 20260715, name: 'Host' })
  h.addBot({ name: 'Bravo' })
  h.addBot({ name: 'Charlie' })
  h.start()
  h.startRecording()
  h.setInput(0, { moveX: mx, attack: true })
  h.setInput(1, { moveX: mx, moveY: my, attack: true })
  h.setInput(2, { moveX: mx, moveY: my })
  h.stepTicks(200)
  const rec = h.stopRecording()
  const evs = rec.ticks.flatMap((t: any) => t.events)
  const types = new Map<string, number>()
  for (const e of evs) types.set(e.type, (types.get(e.type) ?? 0) + 1)
  console.log(label, 'events:', evs.length, JSON.stringify([...types]))
}
