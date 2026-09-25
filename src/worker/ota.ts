// Self-hosted OTA (over-the-air) manifest endpoint, ported from the old Cloudflare
// Pages Function (functions/ota/check.ts) to a Worker route. On each launch the
// @capgo/capacitor-updater plugin POSTs here with the installed bundle version in
// a header; we compare it against the currently published bundle (the static
// /ota/version.json CI writes into dist/ on every deploy, served via the ASSETS
// binding) and tell the plugin whether to download a newer zip.

import type { Env } from './env'

export interface OtaManifest {
  version: string
  url: string
}

/**
 * What we fall back to when nothing has been published.
 *
 * `version: 'builtin'` is a SENTINEL for the health view, never something to
 * send a phone. src/app/webUpdate.ts reads it as "no published build", and on
 * the native side `version: "builtin"` in an update-check response is an
 * instruction to ROLL BACK (CapacitorUpdaterPlugin.java calls `_reset()` on it,
 * reverting the device to the bundle shipped inside the APK). Only ever hand
 * this to `decideOta`, which strips it to a plain "up-to-date" because the url
 * is empty.
 */
const NO_BUILD: OtaManifest = { version: 'builtin', url: '' }

/**
 * What reading `/ota/version.json` actually produced.
 *
 * The distinction between the last two is the whole point of this type. An
 * ABSENT manifest is legitimate — an origin that has never run deploy-web.yml
 * genuinely has nothing to update to, and saying so is the truth. A FAULT means
 * we could not read the manifest at all, so we do not know what the current
 * version is. Answering "up-to-date" there is a GUESS, and it is a guess that
 * is indistinguishable from success: every phone is told it is on the latest
 * build, forever, with no error anywhere. That was the bug this type exists to
 * make unrepresentable.
 */
export type ManifestRead =
  | { kind: 'published'; manifest: OtaManifest }
  | { kind: 'absent' }
  | { kind: 'fault'; reason: string }

/** A manifest needs BOTH fields, as strings. `{}` and `{"foo":1}` are not one,
 * and neither is `{"version":42,...}` — a numeric version would be handed
 * straight to the updater as a bundle name. Parsing is not validating. */
const isManifest = (value: unknown): value is OtaManifest =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<OtaManifest>).version === 'string' &&
  typeof (value as Partial<OtaManifest>).url === 'string'

/**
 * Classify a response from the asset store into the three outcomes above.
 *
 * CHECKS CONTENT-TYPE, NOT JUST STATUS — the same guard as `fetchState` in
 * src/app/stateShare.ts and `parseVersionPayload` in src/app/webUpdate.ts, and
 * for the same reason. wrangler.jsonc sets
 * `not_found_handling: "single-page-application"`, so an asset that is not in
 * dist/ comes back as **200 + the game's index.html**: `res.ok` is true and
 * `res.json()` then detonates on `<!doctype`. A status check alone proves
 * nothing at all here.
 */
export const readManifest = async (res: Response): Promise<ManifestRead> => {
  // The only benign miss. Note this is NOT the common way a manifest goes
  // missing on this Worker — the SPA fallback above means a missing asset is
  // normally a 200 of HTML, caught below. This branch covers a plain asset
  // store (`not_found_handling` changed, or a bare `wrangler dev`).
  if (res.status === 404 || res.status === 410) return { kind: 'absent' }

  if (!res.ok) return { kind: 'fault', reason: `/ota/version.json answered ${res.status}` }

  const type = res.headers.get('content-type') ?? ''
  if (!/\bapplication\/json\b/i.test(type))
    return {
      kind: 'fault',
      reason:
        `/ota/version.json answered 200 with ${type || 'no content-type'} instead of JSON — ` +
        `the asset is missing and the SPA fallback served the app shell instead.`,
    }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return { kind: 'fault', reason: '/ota/version.json claimed to be JSON but did not parse' }
  }

  if (!isManifest(parsed))
    return {
      kind: 'fault',
      reason: '/ota/version.json parsed but is not a {version: string, url: string} manifest',
    }

  return { kind: 'published', manifest: { version: parsed.version, url: parsed.url } }
}

/** Pure decision: given the installed version and the published manifest, what do
 * we tell the updater? Split out so it's unit-testable without a Worker runtime. */
export const decideOta = (installed: string, current: OtaManifest): { message: string } | OtaManifest => {
  if (!current.url || installed === current.version) return { message: 'up-to-date' }
  return { version: current.version, url: current.url }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/** Fetch + classify. The `catch` here means ONE thing — the subrequest itself
 * never completed — and it says so, rather than collapsing into the same
 * silence as a malformed manifest. */
const loadManifest = async (request: Request, env: Env): Promise<ManifestRead> => {
  try {
    return await readManifest(await env.ASSETS.fetch(new URL('/ota/version.json', request.url)))
  } catch (err) {
    return { kind: 'fault', reason: `/ota/version.json could not be fetched: ${String(err)}` }
  }
}

export const handleOta = async (request: Request, env: Env): Promise<Response> => {
  // GET is a health/debug view (also the WEB update check — see
  // src/app/webUpdate.ts VERSION_ENDPOINT); POST is the plugin's real check.
  if (request.method !== 'GET' && request.method !== 'POST')
    return new Response('method not allowed', { status: 405 })

  const read = await loadManifest(request, env)

  if (read.kind === 'fault') {
    // LOUD, BUT NEVER AT THE PHONE'S EXPENSE. Three deliberate choices:
    //
    // 1. console.error — `observability` is on in wrangler.jsonc, so this is a
    //    real, greppable, alertable line in Workers Logs. It is the only signal
    //    that costs a client nothing, so it is the one that always fires.
    //
    // 2. The GET health view stops claiming `ok: true`. That is the honest
    //    debug surface, and it is where a human looks.
    //
    // 3. Still HTTP 2xx, on BOTH paths. This is load-bearing, not laziness:
    //    e2e/ws-lib.mjs probes `GET /ota/check` and treats `res.ok` as "the
    //    Worker is live", and a local `wrangler dev` has no dist/ota/version.json
    //    at all — so a 5xx here would fail every ws e2e run. On the POST side a
    //    5xx buys the device nothing (the plugin turns any non-2xx into the same
    //    terminal "no update"), while turning a transient asset blip into a
    //    Worker error-rate spike indistinguishable from a real outage.
    //
    // What the phone gets is a response carrying `error`, which is the updater's
    // OWN protocol: makeJsonRequest() in CapgoUpdater.java routes any body with
    // an `error` key into its failure branch and logs a NAMED failure on the
    // device. No bundle is offered, nothing is staged, the running bundle keeps
    // running — byte for byte the same outcome as the old silent "up-to-date",
    // except that it is no longer silent and no longer a lie.
    console.error(`ota: ${read.reason}`)
    return request.method === 'GET'
      ? json({ ok: false, error: read.reason, current: NO_BUILD })
      : json({ error: 'ota-manifest-unreadable', message: read.reason })
  }

  const current = read.kind === 'published' ? read.manifest : NO_BUILD

  if (request.method === 'GET') return json({ ok: true, current })

  const installed = request.headers.get('cap_version_name') ?? 'builtin'
  return json(decideOta(installed, current))
}
