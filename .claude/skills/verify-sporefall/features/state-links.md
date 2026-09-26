# State links

In a `?debug` session, `await sporefallShare('<label>')` uploads the current world plus about 1 s of rewind and returns `{ id, url }`. Opening `?state=<id>` replays the run-up under a REPLAY banner, lands on the captured tick, checks itself, and hands control to the player (LIVE).

## Sub-features

- `capture`: `sporefallShare` stores a payload at `/state/<id>`, served as JSON.
- `replay`: `[data-role=state-replay-banner]` shows REPLAY, then LIVE.
- `self-check`: `window.__stateReplay.ok === true` at the landed tick.

## How to get to it (user POV)

- The owner taps a `?state=` link from a PR body or report.

## Driving it with Playwright

Preconditions: this feature needs the Worker, not `vite preview`. Build, then run `pnpm exec wrangler dev --port 8787` in the background, record its pid, and wait for `curl -sf http://127.0.0.1:8787/` to answer. Doctor does not cover port 8787.

- **Round trip (scripted).** `node e2e/state-link-roundtrip.mjs http://127.0.0.1:8787`.
- **Lane B.** `$S/drive.mjs --port 8787 --open '/?mode=solo&seed=7&debug' --until-tick 90 --eval "sporefallShare('verify')"`. Record the returned `id`, then `--open '/?state=<id>' --until "window.__stateReplay" --assert "window.__stateReplay.ok"`.
- **Links for the owner.** Capture these against `https://sporefall.hypnodroid.com/?debug` after merge and deploy, as the repo `CLAUDE.md` requires. A link captured locally replays against whatever code the live site serves, so it diverges.

Not yet driven through this skill.

## Gotchas

- `drive.mjs` assumes `127.0.0.1:<port>`. The Worker on 8787 fits that shape.
- A red `__stateReplay` means the snapshot missed state. Do not hand that link over.
