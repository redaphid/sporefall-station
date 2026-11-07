# Running long GPU jobs on the owner's PC

Facts learned on Aaron's Windows box (RTX 4090, WSL2) during the cast-walk art runs.
Read before an unattended ComfyUI/Wan run. Art-run procedure lives in
`docs/cast-walks/RUNBOOK.md`; this file is the machine.

## The box hard-crashes during art runs

- **11-06 telemetry finding:** 5 of the 7 abrupt resets since 09-26 came with the CPU
  at 97-100% and 88-101 GB of RAM in use; GPU power in the last minute was a moderate
  230-322 W (the GPU hit 400 W+ often without crashing). Suspect CPU/memory saturation
  or CPU-side power (EPS cables, VRM), not GPU peaks or the wall outlet. Art runs
  saturate the CPU: parallel agents each running the full vitest suite, ComfyUI, WSL.
  Avoid stacking full-suite runs; run one file when that proves the change. Before one
  full `vitest run`, wait for others with `while pgrep -f '[v]itest run' >/dev/null; do
  sleep 15; done` (the bracket matters: plain `pgrep -f "vitest run"` matches the
  waiting shell itself and never returns empty). Logger and
  reader: `D:\mechs\windows-crash\telemetry\` (task `SOUL-CrashLogger1Hz`; after a
  crash run `crash-reader.ps1 -Last 1`), notes in `D:\mechs\windows-crash\CLAUDE.md`.

- Windows logged 24 Kernel-Power 41 events (sudden power loss, no bugcheck) between
  2026-09-14 and 2026-11-06, clustered on heavy ComfyUI/Wan days: 7 on 09-29, then
  11-04 16:35 and 18:32, 11-05 17:27, 11-06 00:30 and 10:12.
  List them: `powershell.exe -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='System'; Id=41} | Select TimeCreated"`.
- Ruled out: a GPU power cap (Aaron tried it, no change) and mindmeld's Ollama load
  (the 10:12 crash happened with it stood down). Aaron's hypothesis (11-06): too much
  draw from the wall outlet or the PSU (a 1000 W gold unit). Crash telemetry and the
  prior investigation: `D:\mechs\windows-crash` (or the folder the telemetry worker
  names there).
- A crash zeroes uncommitted files and writes NUL bytes into open logs. **Commit and
  push after every step.** Save WIP with `/mnt/d/tmp/cast-walks/crash-save.sh <tag>`,
  which refuses to commit files truncated to 0 bytes. After a crash follow
  `docs/cast-walks/PROTOCOL.md` "After a crash" (check `.git/objects` for empty files
  first).
- Auto-resume: at Windows login, `Startup\claude-crash-resume.cmd` resumes the session
  named in `D:\tmp\claude-resume\active` (`SESSION=`, `CWD=`, `EXPIRES=` epoch) after a
  15-minute cancellable countdown. Write the marker when a run starts, archive it when
  the run ends. A resumed session forks: check the repo and PROGRESS for what the
  resumed copy already did before acting on stale context.

## Who is using the GPU

- WSL's `nvidia-smi` cannot see Windows processes. Use the Windows counter, whose
  instance names carry the pid:
  `powershell.exe -NoProfile -Command "(Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples | ? CookedValue -gt 3 | sort CookedValue -desc | select -first 8 InstanceName,CookedValue"`.
- On 11-06 the long-"unexplained" ~350 W baseline was mindmeld's Ollama
  (`llama-server` under `ollama.exe`: bge-m3 + qwen3:4b). Stand it down for a run:
  `curl -X POST localhost:3847/api/stand-down -H 'content-type: application/json' -d '{"minutes":240,"reason":"art run"}'`
  (1-240 min, self-expiring; `POST /api/stand-down/resume` ends it early).

## Services

- ComfyUI `http://127.0.0.1:8188` (never 8189, another project's). Start:
  `cd /mnt/d/tools/comfy && powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\tools\comfy\scripts\start.ps1' -Only default -Background`.
- Private Ollama for the VLM gate and local-LLM tooling on `127.0.0.1:18436` (allowed;
  models in `D:\tmp\cast-walks\ollama-models`; start command in `docs/cast-walks/RUNBOOK.md`
  Environment). **Forbidden: ComfyUI on port 8189** (another project's instance; Aaron,
  2026-11-06: "Just not the 8189 comfyui"). Use ComfyUI on 8188 only.
- `/usr/bin/node` is broken here: `export PATH=~/.local/node22/bin:$PATH`, then
  `corepack pnpm ...`.
- Images for Aaron's phone: `~/.local/bin/2cb <files>` prints `https://2cb.pw/<code>`
  links. For PR bodies use `pnpm run review:image`.

## Sharing the GPU between workers

One rule: **every GPU batch runs under `scripts/gpu/gpu-run`.** ComfyUI jobs (Wan,
Fun-Control, SDXL, Qwen), the VLM gate (`cast_walk.py gate`, `verify.py`) and probes
that call either all take the same lock; mindmeld's Ollama is stood down for them.

```
~/Projects/sporefall-station/scripts/gpu/gpu-run --label "<char> <what>" -- python3 scripts/assets/cast_walk.py take ...
~/Projects/sporefall-station/scripts/gpu/gpu-run --status   # holder, age, command, queue; or "free"
```

Call it by that main-checkout path: it works from any worktree, including branches cut
before it existed (keep `~/Projects/sporefall-station` on current `main`).

- **Wrap the whole GPU batch, never a CPU step.** One command that submits every
  direction and waits (a `cast_walk.py` call, or a batch script) holds the lock across
  its own between-direction CPU work. Assemble, export, loopscan and lint run outside
  `gpu-run`, so the next worker gets the GPU the moment your batch ends.
- **No one creates, deletes or waits on a lock file by hand.** The lock is an `flock`
  on `/tmp/sporefall-gpu.flock` (local Linux; drvfs locks are unreliable). The kernel
  releases it when the batch ends by any route: exit, error, SIGTERM, SIGKILL, crash.
  Nothing can go stale, so nothing needs a watchdog to release it.
- Waiters queue in arrival order and print the holder every 30 s. `--wait SECONDS` gives
  up with exit 75 without running the command. Without it, `gpu-run` waits as long as
  it takes: run it with a long `timeout` or in the background.
- While it holds the lock, `gpu-run` writes the holder to `/tmp/sporefall-gpu.status`
  and mirrors it to `/mnt/d/tmp/cast-walks/GPU-WAN.lock` **as information only** (first
  line `gpu-run | <label> | pid N | since T | worktree`) for the dashboard, the watchdog
  and people. Both disappear when the batch ends. `gpu-run --who` prints the status
  JSON, or exits 1 when the GPU is free.
- Before the command it extends mindmeld's stand-down to at least 60 minutes (it warns
  and continues if mindmeld is down). After it, it POSTs ComfyUI `/free` to unload
  models; pass `--keep-models` only when the same worker's next batch follows at once.
- A `gpu-run` inside a `gpu-run` (a batch script that calls it per step) just runs.
- A coordinator hold is a queued batch like any other:
  `gpu-run --label "hold: <reason>" -- sleep 600` runs before everyone who queues after it.
- To stop a batch, `kill <pid>` (SIGTERM) the `gpu-run` pid that `--status` shows. It
  passes the signal to the whole job. After a SIGKILL of `gpu-run` alone, the next
  holder waits for the orphaned job's process group to end before it starts.
- A worker that still writes `GPU-WAN.lock` by hand (a brief from before 11-06) blocks
  `gpu-run` until that file goes; `--status` names it.
- Why (11-06): hand-made lock files were held through 15 minutes of CPU work, left
  stale by crashes, and raced by hand-written take/release code. The idle watchdog
  that deleted them released one in a between-direction CPU gap: two Wan jobs shared
  the 4090 (23.6 GB VRAM) and a 3-minute gate crawled past 30 minutes.
- `/mnt/d/tmp/cast-walks/gpu-watchdog.sh` only alerts on an idle GPU. It never deletes
  the lock file. An alert means "stage the next batch", not "release someone".
- Tests (dummy commands, no GPU): `bash scripts/gpu/gpu-run.test.sh`.

## Showing progress while Aaron is away

He reads on a phone and wants a picture of the state that survives a crash: keep the
draw board current (`https://draw.hypnodroid.com/b/<board>`). `scripts/dashboard/`
holds the tools: `montage.py` stitches the newest contact sheet per workstream,
`push_dash.py` places it, a timestamped history copy and the PROGRESS tail on the board
through the draw MCP's HTTP endpoint (send a `user-agent` header or Cloudflare answers
403; a model cannot reliably paste a large base64 image into a tool call, a script can).
Edit `BOARD` and `STREAMS` for a new run.
