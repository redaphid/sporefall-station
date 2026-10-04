import { describe, expect, it } from 'vitest'
import {
  BETAS_PREFIX,
  MAX_SLUG_LENGTH,
  betaSlugForPr,
  betaSlugFromBase,
  isBetaSlug,
  namespaceRoom,
  resolveBetaSlug,
  slugifyBranch,
} from './betaSlug'

// The slug is the single value that four independent programs must agree on —
// vite.config.ts (bakes it into the bundle's asset base), scripts/publish-beta.mts
// (the KV prefix), src/worker/betas.ts (the route) and the running game (room
// namespacing). A disagreement between any two of them does NOT produce an error:
// it produces a page that loads, looks right, and is the wrong build. So this
// suite is deliberately exhaustive about the edges rather than the happy path.

describe('slugifyBranch', () => {
  it.each([
    ['feat/sequenced-mods', 'sequenced-mods'],
    ['preview/betas-path', 'betas-path'],
    ['main', 'main'],
    ['fix/foo/bar', 'bar'],
    ['feat/Sequenced Mods', 'sequenced-mods'],
    ['preview/Betas Path!', 'betas-path'],
    ['feat/ALLCAPS', 'allcaps'],
    ['feat/under_score', 'under-score'],
    ['feat/dots.in.name', 'dots-in-name'],
    ['feat/--leading-and-trailing--', 'leading-and-trailing'],
    ['feat/a___b', 'a-b'],
    ['release/v1.2.3', 'v1-2-3'],
    ['feat/123', '123'],
  ])('%s -> %s', (branch, slug) => {
    expect(slugifyBranch(branch)).toBe(slug)
  })

  it.each([
    ['', 'an empty branch name'],
    ['feat/', 'an empty final segment'],
    ['feat/___', 'a segment with nothing alphanumeric in it'],
    ['---', 'dashes only'],
    ['/', 'a bare slash'],
    ['feat/!@#$', 'punctuation only'],
  ])('refuses %s (%s)', (branch) => {
    expect(slugifyBranch(branch)).toBeNull()
  })

  it('truncates a very long branch and never leaves a trailing dash behind', () => {
    // The cut lands mid-word here, and a naive slice would be able to end on the
    // dash it just exposed — which would not match BETA_SLUG_RE and would be
    // refused downstream after the build had already run.
    const slug = slugifyBranch(`feat/${'ab-'.repeat(40)}`)
    expect(slug).not.toBeNull()
    expect(slug!.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH)
    expect(slug!.endsWith('-')).toBe(false)
    expect(isBetaSlug(slug!)).toBe(true)
  })

  it('is idempotent — re-slugging a slug yields the same slug', () => {
    for (const branch of ['feat/sequenced-mods', 'preview/Betas Path!', 'release/v1.2.3', 'main']) {
      const once = slugifyBranch(branch)!
      expect(slugifyBranch(once)).toBe(once)
    }
  })

  it('only ever produces slugs the Worker will accept', () => {
    // Anything slugifyBranch returns has to survive isBetaSlug, or a build would
    // publish under a prefix the route refuses to read back.
    const branches = [
      'feat/x',
      'feat/X Y',
      'a/b/c/d',
      'feat/0',
      'feat/-a-',
      `feat/${'z'.repeat(200)}`,
      'feat/ünïcödé-name',
      'feat/emoji-🎮-name',
    ]
    for (const branch of branches) {
      const slug = slugifyBranch(branch)
      if (slug !== null) expect(isBetaSlug(slug)).toBe(true)
    }
  })
})

describe('isBetaSlug', () => {
  it.each(['a', 'main', 'sequenced-mods', 'v1-2-3', '0'])('accepts %s', (slug) => {
    expect(isBetaSlug(slug)).toBe(true)
  })

  it.each([
    ['', 'empty'],
    ['-lead', 'a leading dash'],
    ['UPPER', 'uppercase'],
    ['has.dot', 'a dot — it would break the extension test that picks SPA fallback'],
    ['has/slash', 'a slash — it would forge a second path segment'],
    ['has space', 'a space'],
    ['%2e', 'a percent escape'],
    ['a'.repeat(MAX_SLUG_LENGTH + 1), 'over the length cap'],
  ])('rejects %s (%s)', (slug) => {
    expect(isBetaSlug(slug)).toBe(false)
  })
})

describe('betaSlugFromBase', () => {
  it('reads the slug back out of the base path Vite baked in', () => {
    expect(betaSlugFromBase('/betas/sequenced-mods/')).toBe('sequenced-mods')
  })

  it('round-trips every slug slugifyBranch can mint', () => {
    for (const branch of ['feat/sequenced-mods', 'preview/Betas Path!', 'main', 'release/v1.2.3']) {
      const slug = slugifyBranch(branch)!
      expect(betaSlugFromBase(`${BETAS_PREFIX}${slug}/`)).toBe(slug)
    }
  })

  it.each([
    ['/', 'a production build'],
    ['', 'no base at all'],
    ['/betas/', 'the index, which is not a beta'],
    ['/betas', 'the prefix without a slug'],
    ['/betasmith/x/', 'a path that only looks like the prefix'],
    ['/betas/Bad Slug/', 'a base that could not have come from slugifyBranch'],
    ['/other/x/', 'some unrelated base'],
  ])('returns null for %s (%s)', (base) => {
    expect(betaSlugFromBase(base)).toBeNull()
  })
})

describe('namespaceRoom', () => {
  it('leaves production rooms exactly as they are', () => {
    expect(namespaceRoom('car', null)).toBe('car')
    expect(namespaceRoom('default', null)).toBe('default')
  })

  it('puts a beta in its own room space', () => {
    expect(namespaceRoom('car', 'sequenced-mods')).toBe('sequenced-mods~car')
  })

  it('keeps two DIFFERENT betas apart, and two players on the SAME beta together', () => {
    // The whole point: beta players must meet each other and nobody else. The
    // Durable Object is keyed by idFromName(room), so string equality here IS
    // "do these two players land in the same simulation".
    expect(namespaceRoom('car', 'alpha')).not.toBe(namespaceRoom('car', 'beta'))
    expect(namespaceRoom('car', 'alpha')).toBe(namespaceRoom('car', 'alpha'))
    expect(namespaceRoom('car', 'alpha')).not.toBe(namespaceRoom('car', null))
  })

  it('cannot be forged by a ?room= value from the other side', () => {
    // A production player typing ?room=alpha~car must NOT land in beta `alpha`'s
    // room — production never prefixes, so its room name is the literal string
    // and the separator is only meaningful because the beta side adds it.
    // (This is a documentation test: it pins the asymmetry so nobody "helpfully"
    // makes production strip or interpret the prefix later.)
    expect(namespaceRoom('alpha~car', null)).toBe('alpha~car')
    expect(namespaceRoom('car', 'alpha')).toBe('alpha~car')
    // ...which does collide. Say so out loud rather than pretending otherwise:
    // the beta rooms are a DESYNC guard for honest players, not a security
    // boundary, and nothing in the relay is authenticated anyway.
  })

  it('survives the URL encoding the WebSocket transport applies', () => {
    // WsTransport builds `${base}/${encodeURIComponent(room)}`; `~` is an
    // unreserved character, so the room name stays readable in the URL and the
    // Worker's decodeURIComponent hands back exactly what we namespaced.
    const room = namespaceRoom('car', 'sequenced-mods')
    expect(encodeURIComponent(room)).toBe(room)
    expect(decodeURIComponent(encodeURIComponent(room))).toBe(room)
  })
})

// --- The PR slug ------------------------------------------------------------
// `pr-<number>` exists because .github/workflows/preview-web.yml now publishes
// a beta for EVERY open pull request. Under the branch rule, two PRs on
// `feat/tiles` and `art/tiles` would both slug to `tiles`, silently overwrite
// each other, and each PR's sticky comment would link to the other's build —
// a 200, the right URL, the wrong code, which is the failure mode this whole
// feature is built to make impossible.

describe('betaSlugForPr', () => {
  it.each([
    [1, 'pr-1'],
    [80, 'pr-80'],
    ['123', 'pr-123'],
    [' 42 ', 'pr-42'],
    ['007', 'pr-7'], // normalized, so `7` and `007` cannot become two betas
  ])('%s → %s', (pr, expected) => {
    expect(betaSlugForPr(pr)).toBe(expected)
  })

  it('refuses anything that is not a positive whole PR number', () => {
    for (const bad of [0, -1, 1.5, '', 'abc', '1e3', '12x', '1/2', '../../etc']) {
      expect(betaSlugForPr(bad as number | string)).toBeNull()
    }
  })

  it('always produces a slug the Worker will actually serve', () => {
    // isBetaSlug is what src/worker/betas.ts gates every request on. A minted
    // slug that failed it would publish bytes to a URL that answers 404.
    for (const n of [1, 9, 10, 99, 1000, 999999]) {
      const slug = betaSlugForPr(n)
      expect(slug).not.toBeNull()
      expect(isBetaSlug(slug as string)).toBe(true)
    }
  })
})

describe('the pr-<n> namespace is reserved from branches', () => {
  it.each(['pr-7', 'preview/pr-7', 'feat/PR-7', 'x/pr-0', 'pr-12345'])(
    'refuses to slug branch %s rather than hijacking a PR beta',
    (branch) => {
      // A branch literally named `pr-7` would otherwise overwrite PR #7's beta
      // and make its sticky comment a lie about whose code is at that URL.
      // Failing the publish is recoverable (rename the branch); a silent
      // overwrite is not, because nothing in the response says it happened.
      expect(slugifyBranch(branch)).toBeNull()
    },
  )

  it('leaves branches that merely start with pr alone', () => {
    expect(slugifyBranch('feat/preview-pane')).toBe('preview-pane')
    expect(slugifyBranch('feat/pr-notes')).toBe('pr-notes')
    expect(slugifyBranch('fix/prs')).toBe('prs')
  })
})

describe('resolveBetaSlug — the one resolver vite and the publish script share', () => {
  it('lets the PR number win over the branch', () => {
    // Both are set on a `pull_request` run: the branch for the listing's label,
    // the number for the slug. If these two ever disagreed about which value
    // decides the path, the bundle would ask for its JavaScript under one slug
    // while its bytes sat under the other.
    expect(resolveBetaSlug({ pr: 80, branch: 'feat/betas-path' })).toBe('pr-80')
    expect(resolveBetaSlug({ pr: '80', branch: 'feat/betas-path' })).toBe('pr-80')
  })

  it('falls back to the branch rule when there is no PR', () => {
    for (const pr of [undefined, null, '', '  ']) {
      expect(resolveBetaSlug({ pr, branch: 'preview/sequenced-mods' })).toBe('sequenced-mods')
    }
  })

  it('returns null rather than guessing when it is given nothing usable', () => {
    expect(resolveBetaSlug({})).toBeNull()
    expect(resolveBetaSlug({ branch: '' })).toBeNull()
    expect(resolveBetaSlug({ branch: 'feat/___' })).toBeNull()
    // A malformed PR number does NOT quietly fall through to the branch: the
    // caller asked for a PR beta, and publishing under the branch slug instead
    // would put it at a URL no PR comment is pointing at.
    expect(resolveBetaSlug({ pr: 'nope', branch: 'feat/fine' })).toBeNull()
  })

  it('gives two different PRs two different betas whatever their branches are called', () => {
    const a = resolveBetaSlug({ pr: 101, branch: 'feat/tiles' })
    const b = resolveBetaSlug({ pr: 102, branch: 'art/tiles' })
    expect(slugifyBranch('feat/tiles')).toBe(slugifyBranch('art/tiles')) // the old collision, still real
    expect(a).not.toBe(b) // and no longer reachable from a PR
  })
})
