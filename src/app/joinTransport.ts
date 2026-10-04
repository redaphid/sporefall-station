/**
 * Which transport a joining player gets, decided once from what the device can do.
 *
 * Joining used to fall back to BroadcastChannel whenever Web Bluetooth was
 * missing. That transport only reaches tabs in the same browser, so an iPhone
 * (no iOS browser ships Web Bluetooth) landed in an empty lobby that looked
 * exactly like a host that would not advertise (#15). BroadcastChannel is now
 * reached only on purpose, with `?transport=tabs`; a device that cannot join
 * gets a plan that says why.
 */

/** What `navigator.bluetooth` offers. `unavailable`: the API exists but
 * `getAvailability()` says no adapter can be used (missing, off, or blocked). */
export type WebBluetoothSupport = 'available' | 'unavailable' | 'absent'

export type UnsupportedReason = 'apple-mobile' | 'no-web-bluetooth' | 'no-adapter'

export interface JoinEnvironment {
  /** Capacitor native build: joins through the BLE plugin, never Web Bluetooth. */
  native: boolean
  /** Raw `?transport=` value. */
  transport: string | null
  webBluetooth: WebBluetoothSupport
  appleMobile: boolean
}

export type JoinPlan =
  | { kind: 'native-ble' }
  | { kind: 'ws' }
  | { kind: 'tabs' }
  /** Web Bluetooth picker; it still offers same-computer tabs as a second button. */
  | { kind: 'web-ble' }
  | { kind: 'unsupported'; reason: UnsupportedReason }

export const planJoinTransport = (env: JoinEnvironment): JoinPlan => {
  if (env.native) return { kind: 'native-ble' }
  if (env.transport === 'ws') return { kind: 'ws' }
  if (env.transport === 'tabs') return { kind: 'tabs' }
  if (env.webBluetooth === 'available') return { kind: 'web-ble' }
  if (env.appleMobile) return { kind: 'unsupported', reason: 'apple-mobile' }
  if (env.webBluetooth === 'unavailable') return { kind: 'unsupported', reason: 'no-adapter' }
  return { kind: 'unsupported', reason: 'no-web-bluetooth' }
}

export const JOIN_UNSUPPORTED: Record<UnsupportedReason, { title: string; detail: string }> = {
  'apple-mobile': {
    title: "Can't join from this device",
    detail:
      "iPhones and iPads can't join over Bluetooth. Apple doesn't let any iOS browser use it, Chrome included. " +
      'Join from an Android phone or a laptop running Chrome.',
  },
  'no-web-bluetooth': {
    title: "Can't join from this browser",
    detail: "This browser can't join over Bluetooth. Open the game in Chrome or Edge on Android or a laptop.",
  },
  'no-adapter': {
    title: 'Bluetooth unavailable',
    detail: "This browser can't reach a Bluetooth radio. Turn Bluetooth on, then try again.",
  },
}

/** iPhone/iPod/iPad, including an iPad in desktop mode, which reports a Mac UA
 * but has a touch screen no Mac has. */
export const isAppleMobile = (userAgent: string, maxTouchPoints: number): boolean =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)

/** Never throws: a locked-down webview can throw on merely reading the property. */
export const probeWebBluetooth = async (nav: object): Promise<WebBluetoothSupport> => {
  let bluetooth: unknown
  try {
    if (!('bluetooth' in nav)) return 'absent'
    bluetooth = (nav as { bluetooth?: unknown }).bluetooth
  } catch {
    return 'absent'
  }
  if (typeof bluetooth !== 'object' || bluetooth === null) return 'absent'
  const getAvailability = (bluetooth as { getAvailability?: unknown }).getAvailability
  if (typeof getAvailability !== 'function') return 'available'
  try {
    return (await getAvailability.call(bluetooth)) === false ? 'unavailable' : 'available'
  } catch {
    return 'unavailable'
  }
}
