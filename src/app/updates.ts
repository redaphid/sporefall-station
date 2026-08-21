// One entry point for "stay up to date", across both platforms.
//
// The browser gets it from the service worker (pwa.ts + webUpdate.ts); the
// installed Android app gets it from Capgo (ota.ts). Exactly one of the two is
// ever active. They share the endpoint (/ota/check), the version number (the
// git commit count baked by vite.config.ts and written into the manifest by
// deploy-web.yml) and — the part that matters here — the SAME answer to "is now
// a good time" (updatePolicy.ts).
//
// main.ts therefore knows nothing about service workers, bundles or policy. It
// says where the player is; this decides the rest.

import { startNativeUpdates } from './ota'
import { registerPwa } from './pwa'
import type { UpdateMoment } from './updatePolicy'

export interface Updates {
  /** Tell the updater where the player is. Cheap; safe to call every frame. */
  reportMoment(moment: UpdateMoment, peers: number): void
}

/**
 * Start the background update loop for whichever platform this is.
 *
 * Never throws and never blocks boot. On an unsupported platform (dev server,
 * no service worker) both halves are null and `reportMoment` is a no-op — the
 * game simply never updates itself, which is exactly what it did before.
 */
export const startUpdates = (): Updates => {
  const web = registerPwa()
  const native = startNativeUpdates()
  return {
    reportMoment(moment: UpdateMoment, peers: number): void {
      web?.reportMoment(moment, peers)
      native?.reportMoment(moment, peers)
    },
  }
}
