// Deep links that name a world — `?scenario=`, `?state=`, `?world=` (and the
// e2e `?script=`) — versus the player's saved run.
//
// THE BUG THIS EXISTS FOR (2026-09-18): the owner opened
// `/?mode=solo&seed=18&scenario=armed&floor=3` on their phone minutes after the
// `armed` scenario deployed, and got an ordinary floor-1 pistol run that looked
// exactly like their own game. Three things lined up:
//
//   1. The service worker served the PREVIOUS build. That is by design — a new
//      build downloads in the background and swaps at a safe moment — but the
//      only safe moment a boot offered was the mode picker, and `?mode=solo`
//      skips it. So a link to the newest feature always ran on the build
//      before it.
//   2. That build did not know `armed`, and `applyScenario` silently ignored an
//      unknown name. The link still skipped the resume, so the player got a
//      fresh, unremarkable run instead of an error.
//   3. Every override run was autosaved over the real save, so the owner's
//      actual run was destroyed by merely opening the link.
//
// The rules below fix each one, and are pure so they are tested directly.

/** The world-naming parameters of a URL. */
export interface DeepLink {
  readonly scenario: string | null
  readonly state: string | null
  readonly world: string | null
  readonly script: string | null
}

export const readDeepLink = (params: URLSearchParams): DeepLink => ({
  scenario: params.get('scenario') || null,
  state: params.get('state') || null,
  world: params.get('world') || null,
  script: params.get('script') || null,
})

/**
 * Does this URL name the world to play? If so it ALWAYS wins over the saved
 * run: the save is neither resumed nor written.
 */
export const overridesSave = (link: DeepLink): boolean =>
  link.scenario !== null || link.state !== null || link.world !== null || link.script !== null

/**
 * Is this a link someone was SENT — worth making sure the running build is the
 * current one before honouring it? `?script=` is excluded: it is an e2e input
 * timeline, run against whatever build the harness is serving.
 */
export const wantsFreshBuild = (link: DeepLink): boolean =>
  link.scenario !== null || link.state !== null || link.world !== null

/**
 * The autosave only ever tracks a run the player started themselves. A run a
 * link built for them (a scenario, a shared state, an injected world) is a
 * visit: persisting it would overwrite their real run, and restarting or dying
 * in it would clear that run too.
 */
export const persistsRun = (link: DeepLink): boolean => !overridesSave(link)

/** Only a run the link did not name may be replaced by the saved one. */
export const resumesSave = (link: DeepLink): boolean => !overridesSave(link)

/** How long a deep link will wait for a newer build to finish downloading
 * before giving up and booting the one it has. The version probe itself is a
 * single small request; this only bites when a download is actually running. */
export const DEEP_LINK_FRESHEN_MS = 15_000

/** After handing the new build over, how long to wait for the reload before
 * concluding the swap did not land and carrying on with this build. */
export const DEEP_LINK_RELOAD_GRACE_MS = 8_000

/** The visible error for a scenario this build cannot run. */
export const unknownScenarioMessage = (name: string, known: readonly string[], version: string): string =>
  `Unknown scenario "${name}" — this build (${version}) cannot start it, so nothing was loaded and your saved run is untouched. ` +
  `If the scenario is new, this copy of the game may be out of date: reload once while online. ` +
  `Known scenarios: ${known.join(', ')}.`
