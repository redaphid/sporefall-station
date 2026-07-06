# Streets of Rogue-ish

A top-down co-op roguelite for car rides with **zero cell service**: up to 4 players
over **Bluetooth LE**, one phone hosting the authoritative sim, everything bundled
offline in a Capacitor Android app.

Procedurally generated city floors · 4 classes (Soldier / Thief / Doctor / Hacker) ·
missions (steal the briefcase, take out the boss) · cops, crime and alarm ·
lockpicking, chloroform, grenades, downed-teammate revives.

## Play in a browser (dev)

```bash
npm install
npm run dev            # http://localhost:5173
```

- **Move** WASD/arrows · **Attack** J/Space · **Interact** K/E · **Ability** L/Shift
- URL params skip menus: `?class=thief&mode=solo&seed=7`
- **Local co-op test**: open two tabs — `?mode=host&class=soldier&room=x` and
  `?mode=join&class=thief&room=x` (BroadcastChannel transport with fake latency).

## Android build

One-time setup lives in `~/android/` (JDK 21 at `~/android/jdk-21`, SDK at `~/android`).

```bash
npm run build && npx cap sync android
cd android && JAVA_HOME=$HOME/android/jdk-21 ANDROID_HOME=$HOME/android ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 2-phone BLE test (the point of all this)

1. Install the APK on both phones, turn on airplane mode, **leave Bluetooth on**.
2. Phone A: pick class → **Host co-op** → wait in lobby.
3. Phone B: pick class → **Join co-op** → grant Bluetooth permissions → tap the host in
   the scan list → wait in lobby.
4. Phone A: **Start game**. Complete a mission, hit the exit, next floor.

Host = BLE peripheral (advertises the game service), clients = centrals.
Client inputs ride write-without-response; state comes back as directed notifications.

## Architecture (see `docs/` and the plan in git history)

- `src/game/` — pure deterministic-friendly sim: fixed 30Hz tick, seeded PRNG
  (levels regenerate bit-exact from `seed+floor` on every device — layout never
  crosses the wire), lite-ECS entities, systems as functions. No DOM/pixi/net imports
  (enforced by eslint).
- `src/net/` — transport abstraction (`BroadcastChannelTransport` dev,
  `BleHostTransport`/`BleClientTransport` device), length-prefixed stream framing,
  two-lane send queue (reliable FIFO + latest-wins snapshot slot, one packet in
  flight — BLE can't be flooded by construction), ~10-byte binary entity snapshots
  at 10Hz with per-peer interest filtering.
- `src/app/` — the solo/host/client seam: `HostSession` (solo = host with no peers),
  `NetHostSession`, `NetClientSession` (own-player prediction via the shared
  `moveAndCollide`, rewind-replay reconciliation, smoothing for remotes).
- `src/render/` — PixiJS v8, chunk-culled tilemap, sprite pool, DPR capped at 2.
  All art is generated colored shapes; swap `src/render/art.ts` for a real tileset.

## Tests

```bash
npm test                              # 38 unit/sim tests (determinism, netcode, combat)
npx tsx scripts/test/mp-smoke.ts      # 2-tab co-op end-to-end (needs `npm run dev` running)
npx tsx scripts/test/dump-level.ts 7  # eyeball a generated city as ASCII
```

## Reconnect after a drop

A mid-game link drop (BLE radios in cars do this) is survivable: the host parks
the avatar as a stunned "ghost" for 90 s and remembers a rejoin token; the client
auto-reconnects (`transport.reconnect()` on all three client transports) and
re-Hellos with `{slot, token}` to reclaim the same avatar mid-run. Proven
end-to-end by `scripts/test/reconnect-smoke.ts` (simulated drop over the dev
transport). Real-radio behavior still needs on-phone testing.

## Known gaps / next up

- BLE transports + reconnect are code-complete but not yet verified on physical
  phones (emulators have no Bluetooth).
- Remaining content ideas: shop/bribe economy, second mission per floor,
  real tileset via `art.ts` swap.
