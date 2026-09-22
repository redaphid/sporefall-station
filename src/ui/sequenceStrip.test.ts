// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { SequenceModel } from './sequenceModel'
import { createSequenceStrip } from './sequenceStrip'

const model = (over: Partial<SequenceModel> = {}): SequenceModel => ({
  weaponName: 'Pistol',
  slots: 4,
  castsPerTrigger: 1,
  rechargeLeft: 0,
  rechargeTotal: 20,
  entries: ['frost', 'overload', 'shock', 'incendiary', 'pierce'].map((id, i) => ({
    listIndex: i,
    id,
    name: id,
    icon: id[0],
    color: '#88ccff',
    stacks: 1,
    payload: id === 'frost' || id === 'shock' || id === 'incendiary',
    live: i < 4,
    next: i === 1 || i === 2,
  })),
  ...over,
})

describe('sequence strip DOM', () => {
  it('is hidden with no model and shows one chip per mod otherwise', () => {
    const s = createSequenceStrip(() => {})
    s.update(null)
    expect(s.el.style.display).toBe('none')
    s.update(model())
    expect(s.el.querySelectorAll('button[data-i]')).toHaveLength(5)
    expect(s.el.textContent).toContain('next:')
  })

  it('tap one chip then another requests exactly that swap; tapping the same chip twice cancels', () => {
    const got: [number, number][] = []
    const s = createSequenceStrip((a, b) => got.push([a, b]))
    s.update(model())
    const click = (i: number) => s.el.querySelector<HTMLElement>(`button[data-i="${i}"]`)!.click()
    click(1)
    click(1)
    click(0)
    click(4)
    expect(got).toEqual([[0, 4]])
  })

  it('shows a recharge bar while the weapon recharges', () => {
    const s = createSequenceStrip(() => {})
    s.update(model({ rechargeLeft: 10 }))
    expect(s.el.querySelector('[data-role=mod-recharge]')).not.toBeNull()
    s.update(model())
    expect(s.el.querySelector('[data-role=mod-recharge]')).toBeNull()
  })
})
