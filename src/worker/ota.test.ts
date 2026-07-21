import { describe, expect, it } from 'vitest'
import { decideOta } from './ota'

describe('decideOta', () => {
  it('offers a newer bundle when the installed version differs', () => {
    expect(decideOta('41', { version: '42', url: 'https://x/ota/42.zip' })).toEqual({
      version: '42',
      url: 'https://x/ota/42.zip',
    })
  })

  it('reports up-to-date when the installed version matches', () => {
    expect(decideOta('42', { version: '42', url: 'https://x/ota/42.zip' })).toEqual({ message: 'up-to-date' })
  })

  it('reports up-to-date when there is no published bundle url', () => {
    expect(decideOta('builtin', { version: 'builtin', url: '' })).toEqual({ message: 'up-to-date' })
  })

  it('does not offer an update with an empty url even if versions differ', () => {
    expect(decideOta('1', { version: '2', url: '' })).toEqual({ message: 'up-to-date' })
  })
})
