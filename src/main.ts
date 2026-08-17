import { HostSession } from './app/hostSession'
import { createInspect, installInspect, type Inspect } from './app/inspect'
import { NetClientSession } from './app/netClient'
import { NetHostSession } from './app/netHost'
import type { RenderView, Session } from './app/session'
import { pickNewSeed } from './app/newSeed'
import { createLoadoutPanel, type WeaponThumb } from './ui/loadoutPanel'
import { buildLoadout } from './ui/loadoutModel'
import { markUiChrome } from './ui/chrome'
import { hostFailureMessage } from './app/hostError'
import { joinFailureMessage } from './app/joinError'
import { APP_VERSION } from './app/version'
import { createDebugApi } from './game/debug'
import type { DebugLink } from './debug/channel'
import { loadFixtureJson } from './game/fixtures'
import { applyScenario } from './game/scenarios'
import { deserializeWorld, type WorldJson } from './game/serialize'
import type { World } from './game/world'
import { createPersister, readSave, type KeyValueStore, type Persister } from './app/persistence'
import { loadSettings } from './app/settings'
import {
  canRequestFullscreen,
  enterFullscreen,
  fullscreenSupported,
  isFullscreen,
  shouldHideCursor,
} from './ui/fullscreenModel'
import { SIM_DT } from './game/types'
import { padAimReticles, pointerAim, type Aim, type ReticleAnchor } from './input/aim'
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
import { registerPwa } from './app/pwa'
import { BleClientTransport, BleHostTransport } from './net/transport/bleTransport'
import { BroadcastChannelTransport } from './net/transport/broadcastChannelTransport'
import { isWebBluetoothAvailable, WebBluetoothClientTransport } from './net/transport/webBluetoothTransport'
import { resolveWsBaseUrl, WsTransport } from './net/transport/wsTransport'
import type { Transport } from './net/types'
import { createRenderer, type GameRenderer } from './render/renderer'
import type { ZoomSink } from './render/zoomModel'
import { wireWheelZoom } from './input/wheelZoom'
import { createHud } from './ui/hud'
import { createDebugLog } from './ui/debugLog'
import { createLobbyUi, pickHost, pickJoinTransport, pickMode, type GameMode } from './ui/menu'
import { createScreens } from './ui/screens'
import { createOverlay } from './ui/overlay'
import { installStage, lockLandscape, toStage } from './ui/orientation'
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

  // Install the offline service worker (web only — no-op inside the APK, where
  // the bundled dist/ + OTA already provide offline). This is what makes the
  // browser / home-screen install boot with the radio off.
  registerPwa()

  const mount = document.getElementById('app')!
  const uiMount = document.getElementById('ui')!
  // ── Landscape always (src/ui/orientation.ts) ──────────────────────────────
  // Take ownership of the rotating stage BEFORE the renderer exists: pixi sizes
  // itself from #app (`resizeTo`), and #app fills the stage box, so the stage
  // must already carry the swapped dimensions when the renderer first measures.
  // On a phone stuck in portrait (rotation lock on, or iOS Safari where
  // `screen.orientation.lock` does not exist) this turns the WHOLE presentation
  // 90° — canvas, HUD, touch controls, menus, overlays — because they all live
  // inside #stage. Input is corrected at the DOM event boundary rather than per
  // control; see the orientation.ts header for why that is the safe shape.
  const stageEl = document.getElementById('stage') ?? mount.parentElement!
  const stage = installStage(stageEl, detectTouchCaps(navigator, (q) => window.matchMedia(q)))
  // UI chrome (settings gear/panel) mounts on #ui: it must hit-test ABOVE the
  // touch layer's stick zones (also on #ui) — chrome on #app is unreachable by
  // touch (see src/ui/chrome.ts).
  const renderer = await createRenderer(mount, uiMount)
  // A portrait↔landscape flip changes the stage box; pixi's own resize observer
  // would catch it a frame later, so nudge it in the same turn as the transform.
  stage.onChange = (): void => renderer.app.resize()

  const params = new URLSearchParams(location.search)
  const seed = Number(params.get('seed')) || ((Math.random() * 0xffffffff) >>> 0)
  const room = params.get('room') ?? 'car'
  const name = params.get('name') ?? `Player-${(Math.random() * 90 + 10) | 0}`

  // Browser fullscreen on run-start: the Fullscreen API needs a live user
  // gesture, so we request it from INSIDE the Solo/Host/Join button click (the
  // `onPick` hook), gated by the player's setting + feature detection. The
  // native Capacitor shell is already fullscreen, so it's skipped there. Whole
  // page (documentElement) so the #ui HUD/overlay layer is included. `?mode=`
  // (dev/e2e) bypasses the picker and simply doesn't request — that's fine.
  const nativeApp = Capacitor.isNativePlatform()
  const requestFullscreenOnGesture = (): void => {
    if (
      canRequestFullscreen({
        enabled: loadSettings().fullscreen,
        supported: fullscreenSupported(),
        native: nativeApp,
        alreadyFullscreen: isFullscreen(),
      })
    )
      enterFullscreen()
    lockLandscape() // already-fullscreen case; the listener below covers the rest
  }
  // `screen.orientation.lock()` only SUCCEEDS in fullscreen, and the request
  // above resolves asynchronously — so the lock that actually lands is this one,
  // fired the moment fullscreen arrives. It is a silent no-op on iOS Safari,
  // which exposes `screen.orientation` but implements no `lock()`; those players
  // get landscape from the stage rotation instead. The native Android shell
  // needs none of this (AndroidManifest `screenOrientation="sensorLandscape"`).
  document.addEventListener('fullscreenchange', () => {
    if (isFullscreen()) lockLandscape()
  })
  const mode = (params.get('mode') as GameMode | null) ?? (await pickMode(uiMount, requestFullscreenOnGesture))

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
  // Mouse aim (desktop/keyboard): track the cursor in canvas space and hand the
  // keyboard a provider that turns it into a CONTINUOUS aim vector from the local
  // player toward the cursor — so a keyboard player's bullet follows the mouse to
  // any angle instead of snapping to one of the 8 WASD headings. Mouse pointers
  // only; touch keeps its own on-screen aim stick. The provider reads the live
  // container transform via renderer.worldToScreen, so it agrees pixel-for-pixel
  // with what's drawn. Nothing here touches the sim — aimX/aimY already ride the
  // InputCmd (and the wire) as a continuous heading.
  let pointerScreen: { x: number; y: number } | null = null
  window.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch') return
    // STAGE coordinates — the same space renderer.worldToScreen reports in
    // (pixi globals are canvas-local, and the canvas fills the stage). Using
    // the canvas's bounding rect would be the ROTATED element's axis-aligned
    // box, which is not the origin we want. See ui/orientation.ts.
    pointerScreen = toStage(ev.clientX, ev.clientY)
  })
  const readPointerAim = (): Aim | null => {
    if (!pointerScreen) return null
    const self = session?.renderView().self
    if (!self) return null
    const ps = renderer.worldToScreen(self.pos.x, self.pos.y)
    return pointerAim(ps.x, ps.y, pointerScreen.x, pointerScreen.y)
  }
  let touch: TouchInput | undefined
  let input: InputSource = script ? createScriptedInput(script) : createKeyboard(readPointerAim)
  if (!script && navigator.maxTouchPoints > 0) {
    touch = createTouch(uiMount, zoomSink)
    input = mergeInputs(input, touch)
  }
  const coop = createGamepadCoop()

  const session = await createSession(mode, { seed, room, name, input, coop, uiMount, renderer })
  if (!session) return

  // ── Save-game persistence (feat/localstorage-resume) ──────────────────────
  // Persist the AUTHORITATIVE world to localStorage so a full-page reload
  // seamlessly rejoins the in-progress run. SOLO/host only (HostSession owns the
  // authoritative world); a NetClient rejoins via the host, and we never persist
  // a client-predicted world as authoritative. Explicit dev world-injection flows
  // (`?world=`, `?scenario=`, `?script=`) take precedence over auto-resume.
  const store = browserStore()
  const persister: Persister | undefined = store && session instanceof HostSession ? createPersister(store) : undefined
  const scenario = params.get('scenario')
  const explicitWorldOverride = !!scenario || !!params.get('world') || !!params.get('script')
  let resumed = false
  if (persister && store && session instanceof HostSession && !explicitWorldOverride) {
    const saved = readSave(store) // null on no/corrupt/version-mismatched save → fresh game
    if (saved) {
      session.world = saved
      session.self = saved.entities.find((e) => e.playerCtl) ?? session.self
      renderer.setLevel(saved.level)
      resumed = true
      console.log(`sporefall: resumed in-progress run (floor ${saved.floor}, tick ${saved.tick})`)
    }
  }

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
  // + `window.sporefall` in EVERY build, including release. Reads are harmless
  // (the world is plain serializable objects — the AI-native design) and let an
  // agent driving the browser answer "what is happening right now?" against the
  // deployed site with no debug-hub infrastructure. Mutation (`sporefall.verb`)
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
  console.log(`sporefall build ${APP_VERSION}: window.world + window.sporefall.help() for inspection`)
  // Legacy e2e hook names alias the canonical surface so existing tests keep
  // working; `__world` is a getter for the same live world `window.world` serves.
  const aliasWorldHook = (): void => {
    Object.defineProperty(window, '__world', { configurable: true, get: () => inspect.ns.world })
  }
  if (params.has('e2e')) {
    ;(window as unknown as { __sporefall: Session }).__sporefall = session
    if (session instanceof HostSession) {
      const hostWorld = session.world
      ;(window as unknown as { __debug: unknown }).__debug = createDebugApi(hostWorld)
      aliasWorldHook()
      // Headless hooks for the screenshot e2es, now thin aliases over the
      // canonical `window.sporefall` surface: `sporefall.verb` drives the same
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
      // GROUND TRUTH projection: where the world container ACTUALLY drew a
      // world point this frame (post edge-clamp + shake). e2es assert the DOM
      // overlays (mission 🎯, locator) against THIS, so any drift between the
      // overlay math and the render transform fails loudly.
      ;(window as unknown as { __renderedProject: (wx: number, wy: number) => { x: number; y: number } }).__renderedProject =
        (wx, wy) => renderer.worldToScreen(wx, wy)
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
  // A rebindable link (not a bare channel): New-Seed / play-again swaps the
  // session's World object in place, and the link's `rebind` re-dials the hub
  // against the fresh world (see runLoop) so the reset re-registers exactly like a
  // page reload — no frozen zombie, no blind observer. See DebugLink in channel.ts.
  let debug: DebugLink | undefined
  if (params.has('debug') && 'world' in session) {
    const { startDebugLink } = await import('./debug/channel')
    const { hubUrl, DEFAULT_HUB_PORT } = await import('./debug/protocol')
    const port = Number(params.get('debugPort')) || DEFAULT_HUB_PORT
    // `?debug=<name>` labels this game in the hub's registry so multiple games on
    // one hub stay distinguishable/selectable; bare `?debug` falls back to order.
    const name = params.get('debug') || undefined
    debug = startDebugLink((session as HostSession).world, hubUrl(location.hostname || '127.0.0.1', port), console.log, {
      name,
      setTheme: (id) => void renderer.setTheme(id),
    })
  }
  runLoop(session, renderer, uiMount, coop, inspect, touch, debug, persister, resumed)
}

/** localStorage as a `KeyValueStore`, or `undefined` where it is unavailable
 * (SSR / privacy-locked WebView) — persistence then silently no-ops. */
const browserStore = (): KeyValueStore | undefined => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined
  } catch {
    return undefined // access itself can throw in locked-down webviews
  }
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
  // `?transport=ws` joins over the Cloudflare Worker relay (Durable Object) —
  // the WebSocket multiplayer path (no Bluetooth, works across networks).
  if (pref === 'ws') return new WsTransport('client', deps.room, resolveWsBaseUrl(location.search))
  if (pref !== 'tabs' && isWebBluetoothAvailable()) {
    const webBle = new WebBluetoothClientTransport()
    const choice = await pickJoinTransport(deps.uiMount, () => webBle.requestDevice())
    if (choice === 'ble') return webBle
  }
  return new BroadcastChannelTransport('client', deps.room)
}

/**
 * Hand the radio back when the page goes away.
 *
 * `Transport.stop()` existed but had NO call site anywhere in the app, so a
 * reload (or the OTA updater swapping the bundle) left the BLE advertiser and
 * the GATT service registered against a dead JS context. The stack keeps
 * advertising a host nobody is simulating: joiners see the phantom in their
 * Nearby Games list, connect, and wait forever for a lobby that no longer
 * exists — and the fresh context's addGattService can collide with the
 * already-registered service from the old one.
 *
 * `pagehide` rather than `unload`: it is the event that actually fires in
 * mobile WebViews (and it fires for bfcache/backgrounding too, which is the case
 * that matters on a phone).
 */
const stopTransportOnPagehide = (transport: Transport): void => {
  window.addEventListener('pagehide', () => void transport.stop().catch(() => {}), { once: true })
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
    // (issue #35). No "Spore " tag: the scan already filters by service UUID, and
    // the ~8-char advertisement budget is too tight to waste on a prefix.
    const wsHost = new URLSearchParams(location.search).get('transport') === 'ws'
    const transport = wsHost
      ? new WsTransport('host', deps.room, resolveWsBaseUrl(location.search))
      : native
        ? new BleHostTransport(deps.name, dbg.log)
        : new BroadcastChannelTransport('host', deps.room)
    dbg.log(`host: mode start, native=${native}, name="${deps.name}"`)
    stopTransportOnPagehide(transport)
    const session = new NetHostSession(deps.seed, deps.name, deps.input, transport)
    const lobby = createLobbyUi(deps.uiMount, true)
    lobby.setStatus('Waiting for players…')
    lobby.setPlayers(session.lobbyPlayers())
    session.onLobbyChange = (players) => {
      dbg.log(`host: lobby now ${players.length} player(s)`)
      lobby.setPlayers(players)
    }
    // Hosting could not report its own failure. createSession is awaited at the
    // call site WITHOUT a catch (the join path has one, this did not), so a
    // rejected session.start() became an unhandled rejection and the player was
    // left staring at "Waiting for players…" while nothing was on the air —
    // indistinguishable from a healthy host that nobody has joined yet.
    //
    // That is the difference between a friend saying "it says Bluetooth
    // permission denied" and "it just doesn't work", which is the difference
    // between a fixable evening and a ruined one. Show the plugin's own words.
    try {
      await session.start()
    } catch (err) {
      console.error('host: start failed', err)
      dbg.log(`host: START FAILED — ${err instanceof Error ? err.message : String(err)}`)
      lobby.setStatus(hostFailureMessage(err))
      return null
    }
    await lobby.waitForStart()
    session.beginGame()
    lobby.close()
    deps.renderer.setLevel(session.world.level)
    return session
  }

  // join
  dbg.log(`join: mode start, native=${native}`)
  const transport = native ? new BleClientTransport(dbg.log) : await pickBrowserJoinTransport(deps)
  stopTransportOnPagehide(transport)
  // The rejoin claim rides the same localStorage seam as the save game. Without
  // it the token lives only in memory, so killing the app (or the OS killing the
  // webview in the background — routine on Android) turned every reconnect into
  // a fresh late-join that burned another slot and left another un-driven body.
  // `browserStore()` returns undefined where storage is unavailable, and the
  // session then behaves exactly as it did before this existed.
  const session = new NetClientSession(deps.name, deps.input, transport, { store: browserStore() })

  // The lobby is built BEFORE the connect attempt, not after it.
  //
  // It owns the only status line the joining player has, so creating it after
  // connect() meant a failed join had nowhere to put the bad news: the pick-a-host
  // overlay removed itself the instant you tapped a host, and the next screen was
  // never created, leaving the player on a dead black rectangle. With the plugin's
  // connect() also never settling on refusal (see withTimeout), that dead screen
  // was permanent and indistinguishable from a slow-but-working join.
  //
  // Ordering is safe: both are opaque `inset:0` overlays in the same mount, so the
  // later-appended pick-a-host screen paints ON TOP of this one and hands over to
  // it when it removes itself.
  const lobby = createLobbyUi(deps.uiMount, false)

  if (transport instanceof BleClientTransport) {
    // BLE needs an explicit pick-a-host step before the lobby.
    const scanCtl: { stop: (() => Promise<void>) | null } = { stop: null }
    try {
      await transport.start() // throws early and legibly if Bluetooth is off
      const deviceId = await pickHost(deps.uiMount, (onFound) => {
        void transport.scan(onFound).then((stop) => (scanCtl.stop = stop))
      })
      await scanCtl.stop?.()
      lobby.setStatus('Connecting over Bluetooth…')
      await transport.connect(deviceId)
    } catch (err) {
      console.error('join: start/connect failed', err)
      dbg.log(`join: JOIN FAILED — ${err instanceof Error ? err.message : String(err)}`)
      lobby.setStatus(joinFailureMessage(err))
      // Hand the radio back: a failed join must not leave us scanning forever.
      await scanCtl.stop?.().catch(() => {})
      await transport.stop().catch(() => {})
      return null
    }
  }

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

/** The pause overlay: the big PAUSED title plus the shared gun+mods loadout
 * panel and the Resume / New Seed / Run-it-back actions. `onResume` unpauses,
 * `onNewSeed`/`onRestart` are wired only on host/solo (undefined hides the
 * button). Reachable via Escape (main.ts) or the pad's Start button. */
interface PauseOverlay {
  update(paused: boolean, view: RenderView): void
}
const createPauseOverlay = (
  mount: HTMLElement,
  actions: { onResume: () => void; onNewSeed?: () => void; onRestart?: () => void; weaponThumb?: WeaponThumb },
): PauseOverlay => {
  const el = document.createElement('div')
  markUiChrome(el)
  el.style.cssText =
    'position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:16px;z-index:60;background:#0009;pointer-events:auto;text-align:center;padding:20px;box-sizing:border-box'
  el.innerHTML = `<div style="font:800 40px system-ui;color:#fff;letter-spacing:6px;text-shadow:0 2px 8px #000">PAUSED</div>`
  const panel = createLoadoutPanel(actions.weaponThumb)
  el.appendChild(panel.el)
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center'
  const btn = (label: string, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = primary
      ? 'font:600 16px system-ui;padding:10px 24px;border-radius:8px;border:0;background:#7fd17f;color:#0b0b12;cursor:pointer'
      : 'font:600 16px system-ui;padding:10px 24px;border-radius:8px;border:1px solid #ffd76a;background:#1b1e28;color:#ffd76a;cursor:pointer'
    return b
  }
  const resumeBtn = btn('Resume', true)
  resumeBtn.addEventListener('click', actions.onResume)
  row.appendChild(resumeBtn)
  if (actions.onNewSeed) {
    const nsBtn = btn('🎲 New Seed', false)
    nsBtn.addEventListener('click', actions.onNewSeed)
    row.appendChild(nsBtn)
  }
  if (actions.onRestart) {
    const rbBtn = btn('Run it back', false)
    rbBtn.addEventListener('click', actions.onRestart)
    row.appendChild(rbBtn)
  }
  el.appendChild(row)
  mount.appendChild(el)
  let wasPaused = false
  return {
    update(paused, view) {
      // Never over the death/game-over overlay — that screen owns its own panel.
      const show = paused && !view.gameOver && !view.self?.dead
      if (show && !wasPaused) panel.update(buildLoadout(view.self)) // refresh on open
      wasPaused = show
      el.style.display = show ? 'flex' : 'none'
    },
  }
}

/** Subtle, self-dismissing "resumed" confirmation shown once when an
 * in-progress run is restored from localStorage. Presentation only. */
const showResumedToast = (mount: HTMLElement): void => {
  const el = document.createElement('div')
  el.textContent = 'Resumed your run'
  el.style.cssText =
    'position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:56;' +
    'font:600 13px system-ui;color:#fff;background:#000a;padding:6px 14px;border-radius:9px;' +
    'pointer-events:none;white-space:nowrap;transition:opacity .5s;opacity:1'
  mount.appendChild(el)
  setTimeout(() => (el.style.opacity = '0'), 2200)
  setTimeout(() => el.remove(), 2800)
}

const runLoop = (
  session: Session,
  renderer: GameRenderer,
  uiMount: HTMLElement,
  coop: ReturnType<typeof createGamepadCoop>,
  inspect: Inspect,
  touch?: TouchInput,
  debug?: DebugLink,
  persister?: Persister,
  resumed = false,
): void => {
  const hud = createHud(uiMount)
  // Hide the OS cursor during ACTIVE play so it never obscures the view. CSS
  // only (`cursor: none` on the canvas) — mouse AIM reads the cursor's ABSOLUTE
  // position (the window `pointermove` tracker → aim.pointerAim), so we must NOT
  // use Pointer Lock (relative deltas would break aiming). The cursor returns on
  // pause / death / game-over (their buttons must stay clickable) and it's a
  // harmless no-op on touch/gamepad, which have no OS cursor. Overlays live on
  // #ui (a sibling of the canvas), so their own cursor is unaffected.
  const canvas = renderer.app.canvas
  let cursorHidden = false
  // Save-game plumbing (solo/host only — `persister` is undefined otherwise).
  // The authoritative world lives on the HostSession and is REPLACED wholesale
  // by restart(); read it fresh each call so we always persist the current run.
  const hostWorld = (): World | undefined => (session instanceof HostSession ? session.world : undefined)
  if (persister) {
    const flush = (): void => {
      const w = hostWorld()
      if (w) persister.flush(w)
    }
    // pagehide + visibilitychange:hidden are the reliable "app is going away"
    // signals in BOTH desktop Chrome and the Capacitor Android WebView (Android
    // often kills the tab without ever firing beforeunload; visibility-hidden is
    // the one that reliably lands when the user backgrounds the app). beforeunload
    // is a best-effort desktop belt-and-braces. All just force a final save.
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }
  if (resumed) showResumedToast(uiMount)
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
  // `restart()` swaps `session.world` for a brand-new World object, so re-dial the
  // debug link against the fresh world (dev-only; `debug` is undefined without
  // `?debug`). Without this the in-place reset leaves the hub bound to the OLD,
  // now-frozen world — a zombie — while the live run goes un-bridged (the New-Seed
  // blind-observer bug); a full page reload re-ran boot() and never hit it.
  const rebindDebug = (): void => {
    if ('world' in session) debug?.rebind((session as { world: World }).world)
  }
  // Play-again wraps restart() so a NEW run overwrites any (possibly game-over)
  // save: clear immediately, then the rebuilt world re-saves on the normal cadence
  // — the player is never trapped resuming into a dead run with no way forward.
  const onRestart = session.restart
    ? () => {
        session.restart!()
        persister?.clear()
        rebindDebug()
      }
    : undefined
  // "New Seed": read the run's CURRENT seed off the authoritative session, pick a
  // DIFFERENT one (app-layer random — never the sim), restart into it, and clear
  // the save so a reload doesn't resume the old run. Only host/solo drive the
  // seed; a client has no restart() so it gets no New Seed button.
  const seedOf = (): number =>
    session instanceof HostSession ? session.currentSeed : session instanceof NetHostSession ? session.seed : 0
  const onNewSeed = session.restart
    ? () => {
        session.restart!(pickNewSeed(seedOf()))
        persister?.clear()
        rebindDebug()
      }
    : undefined
  const screens = createScreens(uiMount, onRestart, cameraSource, onNewSeed, renderer.weaponThumb)
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
  // Pause overlay carries the shared gun+mods panel and the Resume / New Seed /
  // Run-it-back actions. Solo/host can toggle pause with Escape (app-layer flip
  // of session.isPaused — never touches the sim); the pad's Start also pauses.
  const canPause = session instanceof HostSession
  const setPaused = (p: boolean): void => {
    if (session instanceof HostSession) session.isPaused = p
  }
  const pauseOverlay = createPauseOverlay(uiMount, {
    onResume: () => setPaused(false),
    onNewSeed,
    onRestart,
    weaponThumb: renderer.weaponThumb,
  })
  if (canPause)
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      const view = session.renderView()
      if (view.gameOver || view.self?.dead) return // death screen owns the moment
      setPaused(!(session.isPaused ?? false))
    })
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
      inspect.afterTick() // buffer this tick's events for sporefall.events()
      acc -= SIM_DT
    }
    // Throttled autosave: cheap no-op most ticks, JSON-serializes at most once per
    // ~1.5 s of advanced sim time (solo/host only; persister is undefined else).
    if (persister) {
      const w = hostWorld()
      if (w) persister.maybeSave(w)
    }
    const alpha = acc / SIM_DT
    const view = session.renderView()
    inspect.frame(view) // cache the view for sporefall reads (+ client event harvest)
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
    pauseOverlay.update(session.isPaused ?? false, view)
    const hide = shouldHideCursor({
      paused: session.isPaused ?? false,
      gameOver: view.gameOver,
      selfDead: !!view.self?.dead,
    })
    if (hide !== cursorHidden) {
      canvas.style.cursor = hide ? 'none' : ''
      cursorHidden = hide
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void boot()
