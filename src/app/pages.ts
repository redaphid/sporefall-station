// The HTML pages Vite builds, as data so a unit test can hold the one rule
// that is easy to break. Each key names its entry chunk:
// `assets/<key>-<hash>.js`. The e2e runners and verify-sporefall's doctor.sh
// find "this checkout's build" by grepping the served page for
// `assets/index-*.js`, so the game's key must stay `index`.

export const PAGES = {
  /** The game. */
  index: 'index.html',
  /** The scene gallery; its cards link back into the game at /?world=<name>. */
  scenes: 'scenes.html',
} as const
