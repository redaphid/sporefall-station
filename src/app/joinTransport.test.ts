import { describe, expect, it } from 'vitest'
import {
  JOIN_UNSUPPORTED,
  isAppleMobile,
  planJoinTransport,
  probeWebBluetooth,
  type JoinEnvironment,
  type JoinPlan,
} from './joinTransport'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

const env = (over: Partial<JoinEnvironment>): JoinEnvironment => ({
  online: false,
  native: false,
  transport: null,
  webBluetooth: 'available',
  appleMobile: false,
  ...over,
})

describe('isAppleMobile', () => {
  it.each([
    ['iPhone Safari', IPHONE_SAFARI, 5, true],
    ['iPhone Chrome (WebKit underneath)', IPHONE_CHROME, 5, true],
    ['iPad in desktop mode (Mac UA, touch screen)', IPAD_DESKTOP_MODE, 5, true],
    ['a real Mac (Mac UA, no touch)', IPAD_DESKTOP_MODE, 0, false],
    ['desktop Chrome', DESKTOP_CHROME, 0, false],
    ['Android Chrome', ANDROID_CHROME, 5, false],
    ['empty UA', '', 0, false],
  ])('%s -> %s', (_label, ua, touchPoints, expected) => {
    expect(isAppleMobile(ua, touchPoints)).toBe(expected)
  })
})

describe('probeWebBluetooth', () => {
  it('no bluetooth property at all (iOS Safari, Firefox) is absent', async () => {
    expect(await probeWebBluetooth({})).toBe('absent')
  })

  it('a bluetooth property holding undefined is absent, not available', async () => {
    expect(await probeWebBluetooth({ bluetooth: undefined })).toBe('absent')
  })

  it('getAvailability() resolving true is available', async () => {
    expect(await probeWebBluetooth({ bluetooth: { getAvailability: () => Promise.resolve(true) } })).toBe('available')
  })

  it('getAvailability() resolving false (no adapter, or blocked) is unavailable', async () => {
    expect(await probeWebBluetooth({ bluetooth: { getAvailability: () => Promise.resolve(false) } })).toBe('unavailable')
  })

  it('getAvailability() rejecting is unavailable', async () => {
    const bluetooth = { getAvailability: () => Promise.reject(new DOMException('blocked', 'SecurityError')) }
    expect(await probeWebBluetooth({ bluetooth })).toBe('unavailable')
  })

  it('getAvailability() throwing synchronously is unavailable', async () => {
    const bluetooth = {
      getAvailability: () => {
        throw new Error('boom')
      },
    }
    expect(await probeWebBluetooth({ bluetooth })).toBe('unavailable')
  })

  it('a Chrome without getAvailability still counts as available (requestDevice reports its own errors)', async () => {
    expect(await probeWebBluetooth({ bluetooth: { requestDevice: () => Promise.resolve() } })).toBe('available')
  })

  it('a navigator whose bluetooth getter throws is absent, and the probe does not throw', async () => {
    const nav = Object.defineProperty({}, 'bluetooth', {
      enumerable: true,
      get() {
        throw new Error('SecurityError: locked-down webview')
      },
    })
    expect(await probeWebBluetooth(nav)).toBe('absent')
  })

  it('a navigator whose `in` check throws (hostile proxy) is absent', async () => {
    const nav = new Proxy(
      {},
      {
        has() {
          throw new Error('nope')
        },
      },
    )
    expect(await probeWebBluetooth(nav)).toBe('absent')
  })
})

describe('planJoinTransport: capability matrix', () => {
  it.each<[string, Partial<JoinEnvironment>, JoinPlan]>([
    ['Capacitor native build', { native: true, webBluetooth: 'absent' }, { kind: 'native-ble' }],
    ['Capacitor native ignores ?transport=tabs', { native: true, transport: 'tabs' }, { kind: 'native-ble' }],
    ['Capacitor native on an iPhone', { native: true, appleMobile: true, webBluetooth: 'absent' }, { kind: 'native-ble' }],
    ['desktop Chrome with Web Bluetooth', { webBluetooth: 'available' }, { kind: 'web-ble' }],
    ['iOS Safari', { appleMobile: true, webBluetooth: 'absent' }, { kind: 'unsupported', reason: 'apple-mobile' }],
    [
      'Web Bluetooth absent on a non-Apple browser (Firefox)',
      { webBluetooth: 'absent' },
      { kind: 'unsupported', reason: 'no-web-bluetooth' },
    ],
    [
      'Web Bluetooth present but getAvailability false',
      { webBluetooth: 'unavailable' },
      { kind: 'unsupported', reason: 'no-adapter' },
    ],
    [
      'iOS with getAvailability false still names the iPhone',
      { appleMobile: true, webBluetooth: 'unavailable' },
      { kind: 'unsupported', reason: 'apple-mobile' },
    ],
    ['an iOS browser that does ship Web Bluetooth (Bluefy) joins', { appleMobile: true, webBluetooth: 'available' }, { kind: 'web-ble' }],
  ])('%s', (_label, over, expected) => {
    expect(planJoinTransport(env(over))).toEqual(expected)
  })
})

describe('planJoinTransport: deliberate dev transports', () => {
  it('?transport=tabs reaches BroadcastChannel on purpose, even on iOS without Web Bluetooth', () => {
    expect(planJoinTransport(env({ transport: 'tabs', appleMobile: true, webBluetooth: 'absent' }))).toEqual({ kind: 'tabs' })
  })

  it('?transport=tabs skips the picker when Web Bluetooth exists', () => {
    expect(planJoinTransport(env({ transport: 'tabs' }))).toEqual({ kind: 'tabs' })
  })

  it('?transport=ws joins over the relay regardless of Bluetooth', () => {
    expect(planJoinTransport(env({ transport: 'ws', webBluetooth: 'absent', appleMobile: true }))).toEqual({ kind: 'ws' })
  })

  it.each(['', 'TABS', 'bluetooth', 'tabs ', 'broadcast'])('an unrecognised ?transport=%j never silently falls back to tabs', (t) => {
    expect(planJoinTransport(env({ transport: t, webBluetooth: 'absent' }))).toEqual({
      kind: 'unsupported',
      reason: 'no-web-bluetooth',
    })
  })

  it('no combination without ?transport=tabs ever plans BroadcastChannel', () => {
    for (const native of [false, true])
      for (const webBluetooth of ['available', 'unavailable', 'absent'] as const)
        for (const appleMobile of [false, true])
          for (const transport of [null, 'ws', 'bogus'])
            expect(planJoinTransport({ online: false, native, webBluetooth, appleMobile, transport }).kind).not.toBe('tabs')
  })

  it('Play online joins over the relay on every device, phones and iPhones included', () => {
    for (const native of [false, true])
      for (const webBluetooth of ['available', 'unavailable', 'absent'] as const)
        for (const appleMobile of [false, true])
          for (const transport of [null, 'tabs', 'bogus'])
            expect(planJoinTransport({ online: true, native, webBluetooth, appleMobile, transport })).toEqual({ kind: 'ws' })
  })
})

describe('JOIN_UNSUPPORTED copy', () => {
  it('tells an iPhone or iPad player plainly that their device cannot join', () => {
    expect(JOIN_UNSUPPORTED['apple-mobile'].detail).toMatch(/iPhone/)
    expect(JOIN_UNSUPPORTED['apple-mobile'].detail).toMatch(/iPad/)
    expect(JOIN_UNSUPPORTED['apple-mobile'].detail).toMatch(/Bluetooth/)
  })

  it('every reason has a title and a detail', () => {
    for (const msg of Object.values(JOIN_UNSUPPORTED)) {
      expect(msg.title.length).toBeGreaterThan(0)
      expect(msg.detail.length).toBeGreaterThan(0)
    }
  })
})
