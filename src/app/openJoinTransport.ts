import type { Transport } from '../net/types'
import { BleClientTransport } from '../net/transport/bleTransport'
import { BroadcastChannelTransport } from '../net/transport/broadcastChannelTransport'
import { WebBluetoothClientTransport } from '../net/transport/webBluetoothTransport'
import { onlineTransport } from '../net/transport/rtcTransport'
import { pickJoinTransport, showJoinUnsupported } from '../ui/menu'
import { JOIN_UNSUPPORTED, isAppleMobile, planJoinTransport, probeWebBluetooth } from './joinTransport'

export interface JoinTransportDeps {
  /** Play online: join `room` on the relay, whatever the device. */
  online: boolean
  /** Capacitor native build. */
  native: boolean
  /** `location.search`. */
  search: string
  /** `navigator`, or a stand-in with the same shape. */
  nav: { userAgent: string; maxTouchPoints: number }
  room: string
  uiMount: HTMLElement
  log: (msg: string) => void
  backToMenu: () => void
}

/**
 * The whole join-transport decision: probe the device, plan, and open what the
 * plan chose. A device that cannot join sees why and gets null back.
 * BroadcastChannel comes only from `?transport=tabs` or the picker's tabs button.
 * Picking Bluetooth runs Chrome's requestDevice chooser inside the picker
 * button's click handler (gesture required).
 */
export const openJoinTransport = async (deps: JoinTransportDeps): Promise<Transport | null> => {
  const plan = planJoinTransport({
    online: deps.online,
    native: deps.native,
    transport: new URLSearchParams(deps.search).get('transport'),
    webBluetooth: await probeWebBluetooth(deps.nav),
    appleMobile: isAppleMobile(deps.nav.userAgent, deps.nav.maxTouchPoints),
  })
  deps.log(`join: plan ${plan.kind}${plan.kind === 'unsupported' ? ` (${plan.reason})` : ''}`)
  switch (plan.kind) {
    case 'native-ble':
      return new BleClientTransport(deps.log)
    case 'ws':
      return onlineTransport('client', deps.room, deps.search, deps.log)
    case 'tabs':
      return new BroadcastChannelTransport('client', deps.room)
    case 'web-ble': {
      const webBle = new WebBluetoothClientTransport()
      const choice = await pickJoinTransport(deps.uiMount, () => webBle.requestDevice())
      return choice === 'ble' ? webBle : new BroadcastChannelTransport('client', deps.room)
    }
    case 'unsupported':
      showJoinUnsupported(deps.uiMount, JOIN_UNSUPPORTED[plan.reason], deps.backToMenu)
      return null
  }
}
