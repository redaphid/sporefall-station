// Per-branch beta builds: the slug, and everything that has to agree about it.
//
// A beta build of this game is served at `https://<origin>/betas/<slug>/` —
// see src/worker/betas.ts for the route and docs/deploy.md § "Betas" for the
// pipeline. THREE separate programs have to derive the same `<slug>` from the
// same branch name or the build silently points at the wrong bytes:
//
//   1. vite.config.ts — bakes `base: /betas/<slug>/` into the bundle, so the
//      built index.html asks for `/betas/<slug>/assets/…` and NOT `/assets/…`.
//   2. scripts/publish-beta.mts — writes the built files to KV under that slug.
//   3. src/worker/betas.ts — reads them back out again.
//
// so the sanitizer lives here, in ONE place, and all three import it.
//
// WHY THIS FILE IS IN src/app AND NOT src/worker: tsconfig.json `exclude`s
// src/worker (the Worker type-checks separately against workers-types, with no
// DOM lib), so anything the browser bundle imports may not live there. This
// module is deliberately pure — no DOM, no Workers globals, no vite globals —
// so the app, the Worker, the build config and a node script can all import it.
// Same reason src/app/swConfig.ts is imported by vite.config.ts.

/** The one public path prefix betas are served under. Trailing slash included. */
export const BETAS_PREFIX = '/betas/'

/** Longest slug we will mint. Long enough to stay readable, short enough that a
 * `/betas/<slug>/assets/<hash>.js` URL is still typable onto a phone. */
export const MAX_SLUG_LENGTH = 40

/** Exactly the slugs the Worker will serve. Lowercase alphanumerics and inner
 * dashes only: no dots (they would collide with the extension test that decides
 * SPA fallback), no slashes (they would forge a second path segment), no
 * percent escapes (one bundle must have exactly one URL). */
export const BETA_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

/** True for a string this module would itself have produced. */
export const isBetaSlug = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_SLUG_LENGTH && BETA_SLUG_RE.test(value)

/**
 * The slug shape CI mints for a PULL REQUEST's beta: `pr-<number>`.
 *
 * WHY A SECOND SCHEME EXISTS AT ALL. slugifyBranch keeps only the branch's last
 * segment, so `feat/x` and `preview/x` are the same beta — documented, accepted,
 * and fine while a human chooses when to publish. It stops being fine the moment
 * EVERY open PR publishes automatically: two PRs whose branches happen to end in
 * the same word would silently overwrite each other's beta, and the loser would
 * be a PR comment pointing at somebody else's build. A GitHub PR number is
 * unique within a repo and is never reused, so `pr-<number>` cannot collide with
 * another PR no matter what the branches are called. It also survives a force
 * push and a branch rename, which is what lets ONE sticky comment keep the same
 * URL for the PR's whole life.
 */
export const PR_SLUG_RE = /^pr-[0-9]+$/

/** PR number → the slug its beta is published under. */
export const betaSlugForPr = (prNumber: number | string): string | null => {
  const digits = String(prNumber).trim()
  if (!/^[0-9]+$/.test(digits) || Number(digits) <= 0) return null
  const slug = `pr-${Number(digits)}`
  return isBetaSlug(slug) ? slug : null
}

/**
 * Branch name → beta slug, or null when nothing usable survives.
 *
 * THE RULE: take the branch's LAST `/`-separated segment, lowercase it, turn
 * every run of non-alphanumerics into a single `-`, trim leading/trailing `-`,
 * and cut to MAX_SLUG_LENGTH (re-trimming any dash the cut exposed).
 *
 *   feat/sequenced-mods   → sequenced-mods
 *   preview/Betas Path!   → betas-path
 *   fix/foo/bar           → bar
 *   main                  → main
 *   feat/___              → null   (nothing left; caller must refuse to publish)
 *
 * KNOWN AND ACCEPTED COLLISION: only the last segment is kept, so
 * `feat/sequenced-mods` and `preview/sequenced-mods` slug to the SAME beta and
 * the second publish overwrites the first. That is the deliberate trade for a
 * URL a human can type. The publish script records the full branch name in the
 * beta's index entry, so `/betas/` always shows which branch the bytes came
 * from — if two branches are fighting over one slug, the listing says so.
 *
 * ONE SLUG IS NOT AVAILABLE TO A BRANCH: `pr-<digits>` is reserved for the
 * PR-triggered betas (PR_SLUG_RE). A branch called `preview/pr-7` would
 * otherwise overwrite PR #7's beta and make its sticky comment a lie about
 * whose code is at that URL, with no error anywhere — so this refuses instead,
 * and the publish fails loudly with a name the author can change.
 */
export const slugifyBranch = (branch: string): string | null => {
  const last = branch.split('/').pop() ?? ''
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  if (PR_SLUG_RE.test(slug)) return null
  return isBetaSlug(slug) ? slug : null
}

/**
 * The ONE resolver every publisher goes through: a PR number wins, a branch
 * name is the fallback, and nothing else mints a slug.
 *
 * Vite (which bakes the base path into the bundle) and scripts/publish-beta.mts
 * (which decides the KV prefix) both call this with the same two environment
 * inputs, so the path the HTML asks for and the path the bytes are stored under
 * cannot disagree — the same reason slugifyBranch itself lives in one file.
 */
export const resolveBetaSlug = (input: {
  pr?: string | number | null
  branch?: string | null
}): string | null => {
  const pr = input.pr === null || input.pr === undefined ? '' : String(input.pr).trim()
  if (pr !== '') return betaSlugForPr(pr)
  const branch = (input.branch ?? '').trim()
  return branch === '' ? null : slugifyBranch(branch)
}

/**
 * The running bundle's own slug, read back out of the base path Vite baked into
 * it (`import.meta.env.BASE_URL`). Returns null for a production build, whose
 * base is `/`.
 *
 * Taking it from BASE_URL rather than a second build-time variable is the whole
 * point: the value that decides where the bundle FETCHES its assets from is the
 * same value that decides which multiplayer rooms it joins, so the two can
 * never drift apart.
 */
export const betaSlugFromBase = (base: string): string | null => {
  if (!base.startsWith(BETAS_PREFIX)) return null
  const rest = base.slice(BETAS_PREFIX.length)
  const slug = rest.endsWith('/') ? rest.slice(0, -1) : rest
  return isBetaSlug(slug) ? slug : null
}

/**
 * Namespace a multiplayer room name by the beta it is being played from.
 *
 * WHY: `/ws/:room` resolves to a Durable Object by `idFromName(room)`, so the
 * room name is the ONLY thing deciding who shares a session. A beta build runs
 * DIFFERENT simulation code from production; the host is authoritative and
 * clients predict-and-rewind against bit-exact snapshots, so a production peer
 * and a beta peer in room `car` do not merely see different things — they
 * desync, and the symptom (rubber-banding, ghost entities) looks like a network
 * fault rather than a version mismatch. Prefixing the slug puts every beta in
 * its own room space; two players on the SAME beta still meet, which is what
 * makes a beta testable at all.
 *
 * `~` is an unreserved URL character, so it survives encodeURIComponent
 * unchanged and the room name stays readable in the WebSocket URL.
 */
export const namespaceRoom = (room: string, slug: string | null): string =>
  slug === null ? room : `${slug}~${room}`
