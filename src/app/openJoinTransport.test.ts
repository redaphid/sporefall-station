// @vitest-environment happy-dom
// The join wiring main.ts calls, driven with fake navigators and query strings.
// #15 was this layer, not the planner: with no Web Bluetooth the join path
// quietly opened a BroadcastChannel, which reaches no phone.
import { afterEach, describe, expect, it } from 'vitest'
import { BleClientTransport } from '../net/transport/bleTransport'
import { BroadcastChannelTransport } from '../net/transport/broadcastChannelTransport'
import { WsTransport } from '../net/transport/wsTransport'
import type { Transport } from '../net/types'
import { openJoinTransport, type JoinTransportDeps } from './openJoinTransport'

const UA = {
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iPhoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  iPadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
}
const TOUCH: Record<keyof typeof UA, number> = {
  iPhoneSafari: 5,
  iPhoneChrome: 5,
  iPadDesktopMode: 5,
  desktopChrome: 0,
  androidChrome: 5,
  firefox: 0,
}

/** Every shape `navigator.bluetooth` takes in the wild, plus hostile ones. */
const BLUETOOTH: Record<string, () => object> = {
  absent: () => ({}),
  undefined: () => ({ bluetooth: undefined }),
  null: () => ({ bluetooth: null }),
  'getter throws': () =>
    Object.defineProperty({}, 'bluetooth', {
      get: () => {
        throw new Error('SecurityError')
      },
    }),
  'adapter off': () => ({ bluetooth: { getAvailability: () => Promise.resolve(false) } }),
  'getAvailability rejects': () => ({ bluetooth: { getAvailability: () => Promise.reject(new Error('blocked')) } }),
  'getAvailability throws': () => ({
    bluetooth: {
      getAvailability: () => {
        throw new Error('blocked')
      },
    },
  }),
  available: () => ({ bluetooth: { getAvailability: () => Promise.resolve(true) } }),
  'no getAvailability': () => ({ bluetooth: {} }),
}

/** Any query a player or a stale link could carry, except the explicit opt-in. */
const SEARCHES = ['', '?mode=join&room=r', '?transport=', '?transport=ble', '?transport=TABS', '?transport=tab', '?transport=tabs2']

const opened: Transport[] = []
const mounts: HTMLElement[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((t) => t.stop().catch(() => {})))
  for (const m of mounts.splice(0)) m.remove()
})

const deps = (over: Partial<JoinTransportDeps> & { bluetooth?: object; ua?: keyof typeof UA }): JoinTransportDeps => {
  const uiMount = document.createElement('div')
  document.body.appendChild(uiMount)
  mounts.push(uiMount)
  const ua = over.ua ?? 'desktopChrome'
  const nav = Object.assign(over.bluetooth ?? {}, { userAgent: UA[ua], maxTouchPoints: TOUCH[ua] })
  return { native: false, search: '', nav, room: 'r', uiMount, log: () => {}, backToMenu: () => {}, ...over }
}

type Outcome = { kind: 'returned'; transport: Transport | null } | { kind: 'waiting-on-picker' }

/** Run the wiring until it returns or parks on the Bluetooth-vs-tabs picker. */
const run = async (d: JoinTransportDeps): Promise<Outcome> => {
  const pending = openJoinTransport(d).then((transport): Outcome => {
    if (transport) opened.push(transport)
    return { kind: 'returned', transport }
  })
  const parked = new Promise<'parked'>((r) => setTimeout(() => r('parked'), 25))
  const first = await Promise.race([pending, parked])
  if (first !== 'parked') return first
  expect(d.uiMount.textContent).toContain('JOIN VIA')
  return { kind: 'waiting-on-picker' }
}

describe('openJoinTransport', () => {
  it('never hands back a BroadcastChannel unless ?transport=tabs asks for one', async () => {
    let cases = 0
    for (const ua of Object.keys(UA) as (keyof typeof UA)[])
      for (const [bt, bluetooth] of Object.entries(BLUETOOTH))
        for (const search of SEARCHES) {
          const outcome = await run(deps({ ua, bluetooth: bluetooth(), search }))
          const label = `${ua} / bluetooth ${bt} / "${search}"`
          if (outcome.kind === 'returned')
            expect(outcome.transport instanceof BroadcastChannelTransport, label).toBe(false)
          cases++
        }
    expect(cases).toBe(Object.keys(UA).length * Object.keys(BLUETOOTH).length * SEARCHES.length)
  })

  it('an iPhone without Web Bluetooth gets null and the reason, not a lobby', async () => {
    for (const ua of ['iPhoneSafari', 'iPhoneChrome', 'iPadDesktopMode'] as const) {
      const d = deps({ ua, bluetooth: {} })
      expect(await run(d)).toEqual({ kind: 'returned', transport: null })
      expect(d.uiMount.querySelector('[data-role="join-unsupported"]')?.textContent).toContain(
        "Safari and Chrome on iPhone and iPad can't use Bluetooth",
      )
      expect(d.uiMount.textContent).not.toContain('Looking for a host')
    }
  })

  it('a desktop browser with Bluetooth switched off says so', async () => {
    const d = deps({ bluetooth: BLUETOOTH['adapter off']() })
    expect(await run(d)).toEqual({ kind: 'returned', transport: null })
    expect(d.uiMount.textContent).toContain('Bluetooth unavailable')
  })

  it('Back to menu calls back exactly once', async () => {
    let backs = 0
    const d = deps({ bluetooth: {}, backToMenu: () => backs++ })
    await run(d)
    d.uiMount.querySelector('button')!.click()
    expect(backs).toBe(1)
  })

  it('?transport=tabs opens a BroadcastChannel on every device, Bluetooth or not', async () => {
    for (const ua of Object.keys(UA) as (keyof typeof UA)[])
      for (const bluetooth of Object.values(BLUETOOTH)) {
        const outcome = await run(deps({ ua, bluetooth: bluetooth(), search: '?transport=tabs' }))
        expect(outcome.kind === 'returned' && outcome.transport instanceof BroadcastChannelTransport, ua).toBe(true)
      }
  })

  it('Web Bluetooth available parks on the picker instead of choosing for the player', async () => {
    expect(await run(deps({ bluetooth: BLUETOOTH.available() }))).toEqual({ kind: 'waiting-on-picker' })
  })

  it('?transport=ws opens a WebSocket transport, and the native build opens the BLE plugin', async () => {
    const ws = await run(deps({ search: '?transport=ws', bluetooth: {} }))
    expect(ws.kind === 'returned' && ws.transport instanceof WsTransport).toBe(true)
    const native = await run(deps({ native: true, ua: 'iPhoneSafari', bluetooth: {} }))
    expect(native.kind === 'returned' && native.transport instanceof BleClientTransport).toBe(true)
  })
})
