// Cloudflare Pages Function — self-hosted OTA manifest endpoint.
//
// Route: POST /ota/check
// @capgo/capacitor-updater (autoUpdate mode) POSTs here on each app launch with
// headers describing the installed bundle (cap_version_name, cap_platform, ...).
// We compare the installed version against the currently published one (read
// from the static /ota/version.json that CI writes on every deploy) and:
//   - reply { version, url } when a newer bundle exists  -> plugin downloads it
//   - reply { message: 'up-to-date' } otherwise           -> plugin does nothing
//
// This is served for free on the same Cloudflare Pages project as the web build,
// so the whole OTA path is self-hosted with no extra service or cost. A static
// file can't answer the plugin's POST, which is why this tiny Function exists.

interface Manifest {
  version: string
  url: string
}

// Pages Functions are compiled by wrangler; the loose typing avoids a dependency
// on @cloudflare/workers-types (not needed to build or deploy).
export const onRequestPost = async (context: {
  request: Request
}): Promise<Response> => {
  const { request } = context

  // The published bundle manifest, written into dist/ota/version.json by CI.
  let current: Manifest = { version: 'builtin', url: '' }
  try {
    const manifestUrl = new URL('/ota/version.json', request.url).toString()
    const res = await fetch(manifestUrl, { cf: { cacheTtl: 0 } } as RequestInit)
    if (res.ok) current = (await res.json()) as Manifest
  } catch {
    // No manifest yet / fetch failed — treat as "nothing to update to".
  }

  // The installed bundle version, sent by the plugin as a request header.
  const installed = request.headers.get('cap_version_name') ?? 'builtin'

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })

  if (!current.url || installed === current.version) {
    return json({ message: 'up-to-date' })
  }
  return json({ version: current.version, url: current.url })
}

// A GET is handy for debugging / health checks and confirms the current bundle.
export const onRequestGet = async (context: {
  request: Request
}): Promise<Response> => {
  let current: unknown = { version: 'builtin', url: '' }
  try {
    const manifestUrl = new URL('/ota/version.json', context.request.url).toString()
    const res = await fetch(manifestUrl, { cf: { cacheTtl: 0 } } as RequestInit)
    if (res.ok) current = await res.json()
  } catch {
    /* ignore */
  }
  return new Response(JSON.stringify({ ok: true, current }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
