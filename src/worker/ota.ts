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

export const handleOta = async (request: Request, env: Env): Promise<Response> => {
  // Read the published manifest from our own static assets (CI writes it into
  // dist/ota/version.json). Missing/unreadable → treat as "nothing to update to".
  let current: OtaManifest = { version: 'builtin', url: '' }
  try {
    const res = await env.ASSETS.fetch(new URL('/ota/version.json', request.url))
    if (res.ok) current = (await res.json()) as OtaManifest
  } catch {
    /* no manifest yet */
  }

  // GET is a health/debug view; POST is the plugin's real update check.
  if (request.method === 'GET') return json({ ok: true, current })
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })

  const installed = request.headers.get('cap_version_name') ?? 'builtin'
  return json(decideOta(installed, current))
}
