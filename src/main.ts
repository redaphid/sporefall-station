import { HostSession } from './app/hostSession'
import { NetClientSession } from './app/netClient'
import { NetHostSession } from './app/netHost'
import type { Session } from './app/session'
import { applyScenario } from './game/scenarios'
import { SIM_DT } from './game/types'
import { createGamepad } from './input/gamepad'
import { createKeyboard } from './input/keyboard'
import { createTouch, mergeInputs } from './input/touch'
import type { InputSource } from './input/input'
import { Capacitor } from '@capacitor/core'
import { BleClientTransport, BleHostTransport } from './net/transport/bleTransport'
import { BroadcastChannelTransport } from './net/transport/broadcastChannelTransport'
import { isWebBluetoothAvailable, WebBluetoothClientTransport } from './net/transport/webBluetoothTransport'
import type { Transport } from './net/types'
import { createRenderer, type GameRenderer } from './render/renderer'
import { pickClass } from './ui/classSelect'
import { createHud } from './ui/hud'
import { createLobbyUi, pickHost, pickJoinTransport, pickMode, type GameMode } from './ui/menu'
import { createScreens } from './ui/screens'

const boot = async (): Promise<void> => {
  const mount = document.getElementById('app')!
  const uiMount = document.getElementById('ui')!
  const renderer = await createRenderer(mount)

  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed')) || ((Math.random() * 0xffffffff) >>> 0)
  const room = params.get('room') ?? 'car'
  const name = params.get('name') ?? `Player-${(Math.random() * 90 + 10) | 0}`

  const classId = params.get('class') ?? (await pickClass(uiMount))
  const mode = (params.get('mode') as GameMode | null) ?? (await pickMode(uiMount))

  let input: InputSource = mergeInputs(createKeyboard(), createGamepad())
  if (navigator.maxTouchPoints > 0) input = mergeInputs(input, createTouch(uiMount))

  const session = await createSession(mode, { seed, room, name, classId, input, uiMount, renderer })
  if (!session) return
  const scenario = params.get('scenario')
  if (scenario && session instanceof HostSession) applyScenario(session.world, scenario)
  if (params.has('e2e')) (window as unknown as { __sor: Session }).__sor = session
  runLoop(session, renderer, uiMount)
}

interface SessionDeps {
  seed: number
  room: string
  name: string
  classId: string
  input: InputSource
  uiMount: HTMLElement
  renderer: GameRenderer
}

/**
 * Browser join transport: Web Bluetooth (laptop joining a phone host) when
 * available, else BroadcastChannel tabs. `?transport=tabs` skips the picker so
 * the dev flow and mp-smoke stay click-free; picking Bluetooth runs Chrome's
 * requestDevice chooser inside the button's click handler (gesture required).
 */
const pickBrowserJoinTransport = async (deps: SessionDeps): Promise<Transport> => {
  const pref = new URLSearchParams(location.search).get('transport')
  if (pref !== 'tabs' && isWebBluetoothAvailable()) {
    const webBle = new WebBluetoothClientTransport()
    const choice = await pickJoinTransport(deps.uiMount, () => webBle.requestDevice())
    if (choice === 'ble') return webBle
  }
  return new BroadcastChannelTransport('client', deps.room)
}

const createSession = async (mode: GameMode, deps: SessionDeps): Promise<Session | null> => {
  if (mode === 'solo') {
    const session = new HostSession(deps.seed, deps.classId, deps.input)
    deps.renderer.setLevel(session.world.level)
    return session
  }

  const native = Capacitor.isNativePlatform()

  if (mode === 'host') {
    const transport = native
      ? new BleHostTransport(`SoR ${deps.name}`)
      : new BroadcastChannelTransport('host', deps.room)
    const session = new NetHostSession(deps.seed, deps.classId, deps.name, deps.input, transport)
    const lobby = createLobbyUi(deps.uiMount, true)
    lobby.setStatus('Waiting for players…')
    lobby.setPlayers(session.lobbyPlayers())
    session.onLobbyChange = (players) => lobby.setPlayers(players)
    await session.start()
    await lobby.waitForStart()
    session.beginGame()
    lobby.close()
    deps.renderer.setLevel(session.world.level)
    return session
  }

  // join
  const transport = native ? new BleClientTransport() : await pickBrowserJoinTransport(deps)
  const session = new NetClientSession(deps.name, deps.classId, deps.input, transport)

  if (transport instanceof BleClientTransport) {
    // BLE needs an explicit pick-a-host step before the lobby.
    await transport.start()
    const scanCtl: { stop: (() => Promise<void>) | null } = { stop: null }
    const deviceId = await pickHost(deps.uiMount, (onFound) => {
      void transport.scan(onFound).then((stop) => (scanCtl.stop = stop))
    })
    await scanCtl.stop?.()
    await transport.connect(deviceId)
  }

  const lobby = createLobbyUi(deps.uiMount, false)
  if (transport instanceof WebBluetoothClientTransport) {
    // Device was already picked in the gesture handler; now do the GATT
    // connect with the session's handlers registered so peerConnected lands.
    lobby.setStatus('Connecting over Bluetooth…')
    try {
      await transport.connect()
    } catch (err) {
      console.error(err)
      lobby.setStatus('Bluetooth connection failed — reload to retry')
      return null
    }
  }
  lobby.setStatus('Looking for a host…')
  session.onLobbyChange = (msg) => lobby.setPlayers(msg.players)
  session.onLevelChange = (level) => deps.renderer.setLevel(level)
  const ready = new Promise<boolean>((resolve) => {
    session.onPhaseChange = (phase) => {
      if (phase === 'lobby') lobby.setStatus('Connected — waiting for host to start')
      else if (phase === 'starting') lobby.setStatus('Generating city…')
      else if (phase === 'playing') resolve(true)
      else if (phase === 'rejected') {
        lobby.setStatus(`Rejected: ${session.rejectReason}`)
        resolve(false)
      } else if (phase === 'ended') {
        lobby.setStatus('Host disconnected')
        resolve(false)
      }
    }
  })
  await session.start()
  const ok = await ready
  if (!ok) return null
  lobby.close()
  return session
}

const runLoop = (session: Session, renderer: GameRenderer, uiMount: HTMLElement): void => {
  const hud = createHud(uiMount)
  const screens = createScreens(uiMount)
  let currentLevel = session.renderView().level

  let acc = 0
  let last = performance.now()
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.25)
    acc += dt
    last = now
    while (acc >= SIM_DT) {
      session.tick()
      acc -= SIM_DT
    }
    const alpha = acc / SIM_DT
    const view = session.renderView()
    if (view.level !== currentLevel) {
      currentLevel = view.level
      renderer.setLevel(view.level)
    }
    if (view.self) {
      const px = view.self.prevPos.x + (view.self.pos.x - view.self.prevPos.x) * alpha
      const py = view.self.prevPos.y + (view.self.pos.y - view.self.prevPos.y) * alpha
      renderer.camera.follow(px, py, dt)
    }
    renderer.draw(view, alpha, dt)
    hud.update(view)
    screens.update(view)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void boot()
