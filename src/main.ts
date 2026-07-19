import { HostSession } from './app/hostSession'
import { createInspect, installInspect, type Inspect } from './app/inspect'
import { NetClientSession } from './app/netClient'
import { NetHostSession } from './app/netHost'
import type { Session } from './app/session'
import { APP_VERSION } from './app/version'
import { createDebugApi } from './game/debug'
import { loadFixtureJson } from './game/fixtures'
import { applyScenario } from './game/scenarios'
import { deserializeWorld, type WorldJson } from './game/serialize'
import { SIM_DT } from './game/types'
import { padAimReticles, type ReticleAnchor } from './input/aim'
import { anyPadActive, createGamepadCoop } from './input/gamepadCoop'
import {
  anyPadProducing,
  detectTouchCaps,
  initialVisibility,
  stepVisibility,
  sticksVisible,
} from './input/stickVisibility'
import { createControllersOverlay } from './input/controllersOverlay'
import { createKeyboard } from './input/keyboard'
import { createScriptedInput, scriptTicks, SCRIPTS } from './input/scripted'
import { createTouch, mergeInputs, type TouchInput } from './input/touch'
import type { InputSource } from './input/input'
import { Capacitor } from '@capacitor/core'
import { notifyOtaReady } from './app/ota'
import { BleClientTransport, BleHostTransport } from './net/transport/bleTransport'
import { BroadcastChannelTransport } from './net/transport/broadcastChannelTransport'
import { isWebBluetoothAvailable, WebBluetoothClientTransport } from './net/transport/webBluetoothTransport'
import type { Transport } from './net/types'
import { createRenderer, type GameRenderer } from './render/renderer'
import type { ZoomSink } from './render/zoomModel'
import { wireWheelZoom } from './input/wheelZoom'
import { createHud } from './ui/hud'
import { createDebugLog } from './ui/debugLog'
import { createLobbyUi, pickHost, pickJoinTransport, pickMode, type GameMode } from './ui/menu'
import { createScreens } from './ui/screens'
import { createOverlay } from './ui/overlay'
import { createMissionPanel } from './ui/missionPanel'
import { resolveLink } from './ui/missionModel'
import { focusCameraTarget, focusPanRate, startFocus, tickFocus, type FocusState } from './ui/focusModel'
import { projectToScreen } from './ui/locatorModel'
import { createDraftScreen } from './ui/draftScreen'
import { applyDraftPick, floorDraftOffer } from './game/systems/draft'
import { weaponStack } from './game/systems/inventory'

const boot = async (): Promise<void> => {
  // Confirm this bundle booted so the native OTA layer keeps it (and applies any
  // newer bundle it fetched). Non-blocking; no-op on web / dev live-reload.
  void notifyOtaReady()

  const mount = document.getElementById('app')!
  const uiMount = document.getElementById('ui')!
  // UI chrome (settings gear/panel) mounts on #ui: it must hit-test ABOVE the
  // touch layer's stick zones (also on #ui) — chrome on #app is unreachable by
  // touch (see src/ui/chrome.ts).
  const renderer = await createRenderer(mount, uiMount)

  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed')) || ((Math.random() * 0xffffffff) >>> 0)
  const room = params.get('room') ?? 'car'
  const name = params.get('name') ?? `Player-${(Math.random() * 90 + 10) | 0}`

  const mode = (params.get('mode') as GameMode | null) ?? (await pickMode(uiMount))

  // Player 0 = keyboard (+ touch). Gamepads are owned by the co-op manager,
  // which press-to-joins each pad as player 0 (first pad) then 1, 2, 3.
  // A `?script=` deterministic input timeline replaces live input for e2e videos.
  const script = params.get('script') ? SCRIPTS[params.get('script')!] : undefined
  // View-only zoom control: pinch (touch) + scrollwheel (desktop), both routed
  // through the camera's smooth, anchored zoom target. Zero effect on the sim.
  const zoomSink: ZoomSink = {
    get: () => renderer.camera.zoomTarget,
    set: (z, ax, ay) => renderer.camera.setZoom(z, ax, ay),
    reset: () => renderer.camera.resetZoom(),
  }
  wireWheelZoom(renderer.app.canvas, zoomSink)
  let touch: TouchInput | undefined
  let input: InputSource = script ? createScriptedInput(script) : createKeyboard()
  if (!script && navigator.maxTouchPoints > 0) {
    touch = createTouch(uiMount, zoomSink)
    input = mergeInputs(input, touch)
  }
  const coop = createGamepadCoop()

  const session = await createSession(mode, { seed, room, name, input, coop, uiMount, renderer })
  if (!session) return
  const scenario = params.get('scenario')
  if (scenario && session instanceof HostSession) {
    applyScenario(session.world, scenario)
    // Scenarios may carve/build tiles (stages, walls) — re-bake the tilemap so
    // the render matches the sim's level, not the pre-scenario one.
    renderer.setLevel(session.world.level)
  }
  // #50 exact-world-state injection: `?world=<fixture>` replaces the freshly
  // built world with a deserialized snapshot BEFORE the loop starts, so a feature
  // test can set world state EXACTLY and still run the real systems (composes with
  // `?script=` — the scripted input then plays from tick 0 of the injected world).
  // `?world=@inline` (needs `?e2e`) instead waits for the harness to push a
  // WorldJson via `window.__loadWorld(json)` — same effect, no rebuild for ad-hoc
  // snapshots. Placed before the `?e2e`/`?script=` exposure below so `window.__world`
  // points at the injected world. Absent `?world=`, behavior is unchanged.
  const worldParam = params.get('world')
  if (worldParam && session instanceof HostSession) {
    const host = session
    const inject = (json: WorldJson): void => {
      const restored = deserializeWorld(json)
      host.world = restored
      host.self = restored.entities.find((e) => e.playerCtl) ?? host.self
      renderer.setLevel(restored.level)
    }
    if (worldParam === '@inline') {
      await new Promise<void>((resolve) => {
        ;(window as unknown as { __loadWorld: (j: WorldJson) => void }).__loadWorld = (j) => {
          inject(j)
          resolve()
        }
      })
    } else {
      inject(loadFixtureJson(worldParam))
    }
  }
  const zoom = Number(params.get('zoom'))
  if (zoom > 0) renderer.camera.snapZoom(zoom) // clamped to [ZOOM_MIN, ZOOM_MAX]
  // The always-on AI inspection surface (docs/ai-inspection.md): `window.world`
  // + `window.backseat` in EVERY build, including release. Reads are harmless
  // (the world is plain serializable objects — the AI-native design) and let an
  // agent driving the browser answer "what is happening right now?" against the
  // deployed site with no debug-hub infrastructure. Mutation (`backseat.verb`)
  // stays dev-gated: only `?debug`/`?e2e` enable it; otherwise it refuses with
  // an explanation. All getters, so world replacement (?world=, load, restart)
  // is tracked automatically.
  const inspect = createInspect({
    getWorld: () => ('world' in session ? (session as HostSession).world : undefined),
    getView: () => session.renderView(),
    sessionInfo: () => ({
      mode,
      paused: session.isPaused ?? false,
      ...(session instanceof NetHostSession ? { peers: session.lobbyPlayers() } : {}),
    }),
    devWrites: params.has('debug') || params.has('e2e'),
    version: APP_VERSION,
    setTheme: (id) => void renderer.setTheme(id),
  })
  installInspect(inspect, window)
  console.log(`backseat build ${APP_VERSION}: window.world + window.backseat.help() for inspection`)
  // Legacy e2e hook names alias the canonical surface so existing tests keep
  // working; `__world` is a getter for the same live world `window.world` serves.
  const aliasWorldHook = (): void => {
    Object.defineProperty(window, '__world', { configurable: true, get: () => inspect.ns.world })
  }
  if (params.has('e2e')) {
    ;(window as unknown as { __sor: Session }).__sor = session
    if (session instanceof HostSession) {
      const hostWorld = session.world
      ;(window as unknown as { __debug: unknown }).__debug = createDebugApi(hostWorld)
      aliasWorldHook()
      // Headless hooks for the screenshot e2es, now thin aliases over the
      // canonical `window.backseat` surface: `backseat.verb` drives the same
      // `runVerb` dispatcher (same guards as the live debug channel), and the
      // `?e2e` flag satisfies its dev-write gate.
      ;(window as unknown as { __annotate: (line: string) => string }).__annotate = (line) =>
        inspect.ns.verb('annotate', line)
      ;(window as unknown as { __verb: (line: string) => string }).__verb = (line) => inspect.ns.verb(line)
      // Awaitable theme swap for e2e screenshot tests (the `theme` verb is
      // fire-and-forget; this resolves when the new assets are actually baked).
      ;(window as unknown as { __setTheme: (id: string) => Promise<void> }).__setTheme = (id) =>
        renderer.setTheme(id)
      // #53 mod draft: the between-floor "pick 1 of N" screen. The offer is the
      // deterministic `floorDraftOffer(seed, floor)`; picking appends the mod to
      // the local player's equipped gun. Exposed here so a screenshot e2e can show
      // the card screen and drive a pick headlessly (no pixel math). The automatic
      // floor-clear trigger lands with floor progression (deferred, see P4 note).
      const draftScreen = createDraftScreen(uiMount)
      const applyPick = (id: string): void => {
        const self = hostWorld.entities.find((e) => e.playerCtl)
        const stack = self && weaponStack(self)
        if (stack) applyDraftPick(stack, id)
      }
      ;(window as unknown as { __draftOffer: (f?: number) => string }).__draftOffer = (f) =>
        JSON.stringify(floorDraftOffer(hostWorld.seed, f ?? hostWorld.floor))
      ;(window as unknown as { __draftShow: (f?: number) => string }).__draftShow = (f) => {
        const offer = floorDraftOffer(hostWorld.seed, f ?? hostWorld.floor)
        draftScreen.show(offer, applyPick)
        return JSON.stringify(offer)
      }
      ;(window as unknown as { __draftPick: (id: string) => void }).__draftPick = (id) => {
        applyPick(id)
        draftScreen.hide()
      }
      // Drive the view zoom headlessly: smooth (real interpolation path) or
      // snapped (deterministic stills at exact zoom levels).
      ;(window as unknown as { __zoom: (z: number, snap?: boolean) => number }).__zoom = (z, snap) => {
        if (snap) renderer.camera.snapZoom(z)
        else renderer.camera.setZoom(z)
        return renderer.camera.zoomTarget
      }
      // Project a world tile to a screen pixel via the LIVE camera, so an e2e can
      // click exactly on an entity (mirrors the overlay's own projection).
      ;(window as unknown as { __project: (wx: number, wy: number) => { x: number; y: number } }).__project = (wx, wy) =>
        projectToScreen(wx, wy, {
          x: renderer.camera.x,
          y: renderer.camera.y,
          zoom: renderer.camera.zoom,
          screenW: renderer.app.screen.width,
          screenH: renderer.app.screen.height,
          levelW: hostWorld.level.w,
          levelH: hostWorld.level.h,
        })
    }
  }
  if (script && session instanceof HostSession) {
    aliasWorldHook()
    ;(window as unknown as { __scriptTicks: number }).__scriptTicks = scriptTicks(script)
  }
  // Live ECS debug harness (issue #29): only under `?debug`, only for sessions
  // that own an authoritative world (solo/host). Dynamic import keeps it out of
  // normal builds. The hub URL derives from whoever served the app, so it "just
  // works" under Vite live-reload from the laptop.
  let debug: { afterTick(): void } | undefined
  if (params.has('debug') && 'world' in session) {
    const { startDebugChannel } = await import('./debug/channel')
    const { hubUrl, DEFAULT_HUB_PORT } = await import('./debug/protocol')
    const port = Number(params.get('debugPort')) || DEFAULT_HUB_PORT
    // `?debug=<name>` labels this game in the hub's registry so multiple games on
    // one hub stay distinguishable/selectable; bare `?debug` falls back to order.
    const name = params.get('debug') || undefined
    debug = startDebugChannel((session as HostSession).world, hubUrl(location.hostname || '127.0.0.1', port), console.log, {
      name,
      setTheme: (id) => void renderer.setTheme(id),
    })
  }
  runLoop(session, renderer, uiMount, coop, inspect, touch, debug)
}

interface SessionDeps {
  seed: number
  room: string
  name: string
  input: InputSource
  coop: ReturnType<typeof createGamepadCoop>
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
    const session = new HostSession(deps.seed, deps.input, deps.coop)
    deps.renderer.setLevel(session.world.level)
    return session
  }

  const native = Capacitor.isNativePlatform()
  // On-screen co-op diagnostics (host/join). Invaluable on a real phone where the
  // BLE handshake can't be watched over a single adb cable.
  const dbg = createDebugLog(deps.uiMount)

  if (mode === 'host') {
    // Advertise the host's display name so the join list can label this phone
    // (issue #35). No "SoR " tag: the scan already filters by service UUID, and
    // the ~8-char advertisement budget is too tight to waste on a prefix.
    const transport = native
      ? new BleHostTransport(deps.name, dbg.log)
      : new BroadcastChannelTransport('host', deps.room)
    dbg.log(`host: mode start, native=${native}, name="${deps.name}"`)
    const session = new NetHostSession(deps.seed, deps.name, deps.input, transport)
    const lobby = createLobbyUi(deps.uiMount, true)
    lobby.setStatus('Waiting for players…')
    lobby.setPlayers(session.lobbyPlayers())
    session.onLobbyChange = (players) => {
      dbg.log(`host: lobby now ${players.length} player(s)`)
      lobby.setPlayers(players)
    }
    await session.start()
    await lobby.waitForStart()
    session.beginGame()
    lobby.close()
    deps.renderer.setLevel(session.world.level)
    return session
  }

  // join
  dbg.log(`join: mode start, native=${native}`)
  const transport = native ? new BleClientTransport(dbg.log) : await pickBrowserJoinTransport(deps)
  const session = new NetClientSession(deps.name, deps.input, transport)

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
      dbg.log(`join: phase → ${phase}`)
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

/** "Controller detected" toast for a pad the browser exposes but that hasn't
 * joined yet. Any button or a firm stick push joins (padJoin.ts), so this only
 * shows in the window between exposure and the player's first real input —
 * exactly when a hint is worth having and invisible the rest of the time. */
const createPadHint = (mount: HTMLElement): ((show: boolean) => void) => {
  const el = document.createElement('div')
  el.textContent = 'Controller detected — press any button or move a stick to join'
  el.style.cssText =
    'position:absolute;top:14px;left:50%;transform:translateX(-50%);display:none;z-index:55;' +
    'font:600 13px system-ui;color:#fff;background:#000a;padding:6px 14px;border-radius:9px;' +
    'pointer-events:none;white-space:nowrap'
  mount.appendChild(el)
  return (show) => (el.style.display = show ? 'block' : 'none')
}

const createPauseBanner = (mount: HTMLElement): ((paused: boolean) => void) => {
  const el = document.createElement('div')
  el.textContent = 'PAUSED'
  el.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;z-index:60;' +
    'font:800 48px system-ui;color:#fff;letter-spacing:4px;background:#0007;pointer-events:none'
  mount.appendChild(el)
  return (paused) => (el.style.display = paused ? 'flex' : 'none')
}

const runLoop = (
  session: Session,
  renderer: GameRenderer,
  uiMount: HTMLElement,
  coop: ReturnType<typeof createGamepadCoop>,
  inspect: Inspect,
  touch?: TouchInput,
  debug?: { afterTick(): void },
): void => {
  const hud = createHud(uiMount)
  // Host/solo can restart in place (transport preserved); a client has no
  // restart() and instead waits for the host's fresh GameStart over the link.
  // Feed the teammate locator read-only camera/screen state so it can project
  // world→screen for on-screen markers — no renderer draw code is touched.
  const cameraSource = (): { x: number; y: number; zoom: number; screenW: number; screenH: number } => ({
    x: renderer.camera.x,
    y: renderer.camera.y,
    zoom: renderer.camera.zoom,
    screenW: renderer.app.screen.width,
    screenH: renderer.app.screen.height,
  })
  const screens = createScreens(uiMount, session.restart ? () => session.restart!() : undefined, cameraSource)
  // Mission panel + objective hyperlinks: tapping a linked objective row starts a
  // VIEW-ONLY camera focus (focusModel.ts) — an animated glide to the target and
  // back. Nothing here writes sim state; determinism is untouched.
  let focus: FocusState | undefined
  const beginFocus = (link: { targetId?: number; x?: number; y?: number }): void => {
    const self = session.renderView().self
    if (self) focus = startFocus(link, self.pos)
  }
  const missionPanel = createMissionPanel(uiMount, {
    cameraSource,
    onFocus: beginFocus,
    focusSource: () => focus?.target,
  })
  // Annotation + inspect overlay. Pointer listeners live on the canvas container
  // (#app — receives desktop clicks and, when a controller hides the touch
  // controls, raw touches); on phones the touch layer forwards NEUTRAL taps /
  // long-presses via setInspectHandler after its stick/pinch claiming rules run.
  // The popup itself mounts on #ui so its chip/✕/locate affordances paint (and
  // hit-test) ABOVE the stick zones. The card's mission-locate action reuses the
  // mission panel's beginFocus — one camera-focus machinery, no duplication.
  const appMount = (renderer.app.canvas.parentElement as HTMLElement | null) ?? uiMount
  const commOverlay = createOverlay(appMount, cameraSource, {
    cardMount: uiMount,
    onFocus: beginFocus,
    thumbnail: (artKey) => renderer.entityThumb(artKey),
  })
  touch?.setInspectHandler((mode, x, y) => commOverlay.inspectAt(mode === 'tap' ? 'chip' : 'card', x, y))
  const overlay = createControllersOverlay(uiMount)
  const showPause = createPauseBanner(uiMount)
  const showPadHint = createPadHint(uiMount)
  let currentLevel = session.renderView().level

  // Touch-controls visibility (stickVisibility.ts): last actor wins, pad wins
  // ties. The touch signal is a PASSIVE capture listener — it never claims,
  // preventDefaults, or stops a touch, so stick/pinch/inspect claiming rules
  // are untouched; it only notes "a finger touched the screen" so hidden
  // controls can come back on a shared couch device.
  const caps = detectTouchCaps(navigator, (q) => window.matchMedia(q))
  let vis = initialVisibility()
  let touchSeen = false
  window.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.pointerType === 'touch') touchSeen = true
    },
    { capture: true, passive: true },
  )

  let acc = 0
  let last = performance.now()
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.25)
    acc += dt
    last = now
    while (acc >= SIM_DT) {
      session.tick()
      debug?.afterTick() // stream this tick's events + drain queued debug mutations
      inspect.afterTick() // buffer this tick's events for backseat.events()
      acc -= SIM_DT
    }
    const alpha = acc / SIM_DT
    const view = session.renderView()
    inspect.frame(view) // cache the view for backseat reads (+ client event harvest)
    if (view.level !== currentLevel) {
      currentLevel = view.level
      renderer.setLevel(view.level)
    }
    if (view.self) {
      const px = view.self.prevPos.x + (view.self.pos.x - view.self.prevPos.x) * alpha
      const py = view.self.prevPos.y + (view.self.pos.y - view.self.prevPos.y) * alpha
      // Objective focus: while live, the camera glides to the link target and
      // back (focusPanRate < normal → an animated pan, never a cut). The focus
      // dies on its own timer, when the player moves, or if the target despawns.
      const focusPos = focus ? resolveLink(focus.target, view.entities) : undefined
      focus = tickFocus(focus, dt, view.self.pos, focusPos)
      const rate = focusPanRate(focus)
      if (focus) {
        const t = focusCameraTarget(focus, { x: px, y: py }, focusPos)
        renderer.camera.follow(t.x, t.y, dt, rate)
      } else {
        renderer.camera.follow(px, py, dt, rate)
      }
    }
    renderer.draw(view, alpha, dt)
    hud.update(view)
    const pads = coop.debug()
    // Twin-stick aim reticles: one per joined pad with a deflected right stick,
    // anchored to that pad's player entity. Presentation only.
    const anchors: ReticleAnchor[] = []
    for (const e of view.entities)
      if (e.playerCtl) anchors.push({ pos: e.pos, playerId: e.playerCtl.playerId, dead: e.dead })
    renderer.setReticles(padAimReticles(pads, anchors))
    // Exposed-but-unjoined pad: nudge the player that any input joins.
    showPadHint(pads.some((p) => p.slot === null))
    vis = stepVisibility(vis, {
      padJoined: anyPadActive(pads),
      padActivity: anyPadProducing(pads),
      touchActivity: touchSeen,
    })
    touchSeen = false
    touch?.setVisible(sticksVisible(vis, caps))
    touch?.update(view)
    coop.update(view) // cache inventory so the pad can resolve weapon-cycle presses
    screens.update(view)
    missionPanel.update(view)
    commOverlay.update(view)
    overlay.update(pads)
    showPause(session.isPaused ?? false)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void boot()
