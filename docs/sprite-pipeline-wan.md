# The Wan sprite pipeline — and why the better one sat unused for a month

**Status: the technique is proven; the wiring is not.** This documents the
pipeline that supersedes per-frame SDXL for character animation, the settings
that were bought expensively, and — the part that actually matters — **why the
project kept shipping the worse approach for a month while this one existed.**

If you read only one section, read the last one.

---

## 1. What it is

**Wan 2.2 Animate 14B** (GGUF **Q5_K_M** quant), driven by a Blender mannequin
render, judged, then pixel-downscaled.

It lives in **`D:\projects\sporefall-art`** — a *separate repo* from the game:

| piece | path |
|---|---|
| 8-facing turnaround + atlas packing | `sprites/make_8way.py` |
| mannequin driving videos (Blender) | `sprites/run_wan_prep.py --clip idle --dirs all` |
| character reference images | `assets/identity/station/*.png` |
| motion clips | `assets/motion/<char>_<clip>_made.fbx` |
| experiment record | `findings/2026-07-2*/` (12 dated findings) |
| current status | `SESSION_LOG.md` (`NIGHT_LOG.md` is the retired SDXL era) |

Stage order: **mannequin dense render → driving video → Wan 2.2 Animate →
art-director judge → pixel downscale → atlas**.

The station cast already has identities there: `bog-mutant`, `derelict-bot`,
`frog-settler`, `mycologist`, `spore-drone`, `vine-ranger`, `bubbler`.

## 2. Why it replaces per-frame SDXL

**Independent SDXL seeds have no temporal coherence by construction.** Each frame
is a separate sample, so shading and palette drift between frames that are
supposed to be the same character one tick apart.

Measured on the r2 cast — the fraction of shared-opaque pixels whose colour
changes between a character's idle and its step frame:

| set | mean drift | range |
|---|---|---|
| r2 cast, generated 2026-08-23 | **45.6%** | 32 – 54% |
| **art already shipped in the game** | **36.0%** | 28 – 45% |

A 2-frame bob should only change the pixels that *move* — roughly 10–15%. Half
the body recolouring is a flicker.

Three things worth carrying:

- **The user saw this by eye before any check caught it.** He said some of them
  change colour significantly. He was right, and the measurement backed him.
- **It is not new damage.** Shipped art has the same characteristic. Any
  threshold strict enough to fail the new frames also fails what is in the game
  today. This is a *pipeline property*, not a bad run.
- **Palette-locking does not fix it.** Quantising frame 2 to frame 1's exact
  palette moved 45.6% to **44.9%**. The colours already share a palette; the
  *surface* is genuinely re-rendered. Measured, not assumed.

A video model emits frames that are coherent *with each other*. That fixes the
cause instead of gating the symptom.

## 3. Settings, and the trap in them

**`cfg 2.5`, `steps 8`** — the defaults in `make_8way.py`, and they are not
arbitrary. From `findings/2026-07-24-exp723-cfg-fix/`:

> **`cfg=1` makes classifier-free guidance mathematically unable to apply
> negative conditioning at all.**

The stock ComfyUI template ships `cfg=1`. Anyone who takes that default **loses
every negative prompt silently** — no error, no warning, just prompts that do
nothing. exp 722 tried to fix a hallucination with negatives alone and was a
complete no-op for exactly this reason.

Also recorded, from a later commit: *"stop using fast Wan settings; they were the
quality regression."* Fast settings are a trap that looks like a win.

## 4. The known limitation — stated honestly

From `sprites/make_8way.py`'s own header:

> *"Wan gets ONE reference image and it is a FRONT view. For the rear facings it
> has to invent the back of a character it has never seen. Expect the back rows
> to be the weak ones."*

This is real and it is not a bug in the script. `docs/RESEARCH-2026-07-24-sota.md`
in that repo suggests **per-direction references** as the fix.

**Independently rediscovered on 2026-08-23**, four hours before anyone found the
July note: the SDXL cast sweep anchors every facing on the character's own
front-view `s-idle` at full IPAdapter weight, so the anchor fights the turn.
Measured silhouette overlap with the front view — high means *it did not turn*:

| character | se | e | ne |
|---|---|---|---|
| mycologist | 83% | 78% | 80% |
| bog-mutant | 73% | 74% | 75% |

Same root cause, same conclusion, paid for twice.

## 5. Output MUST target `swampspace-hires`

**The game loads `swampspace-hires` (96x96), not `swampspace` (48x48).**
See `src/render/theme.ts` `DEFAULT_THEME_ID` and `src/app/settings.ts`.

Theme resolution takes the **first manifest that MENTIONS a key**. Since hires
mentions all 180 character keys, **zero characters render from the base pack**.
Art written to base is silently shadowed: correct merge, green deploy, green
gates, fresh browser — and nothing visible.

`scripts/assets/packs.py` (`assert_writable`) now refuses a shadowed write and
names the pack doing the shadowing. Use it; do not re-learn this.

## 6. Environment: it runs in WSL, not Git Bash

`sprites/blenderio.py` hardcodes `BLENDER = /mnt/d/tools/blender/blender.exe` — a
**WSL path**. Invoked from Git Bash on Windows it raises `FileNotFoundError`, and
then — this is the dangerous part — **`make_8way.py` treats every missing driving
video as a skip and exits 0.** The whole run reports success in under a second
having produced nothing.

Run it as `wsl -d survivor -e bash <script>`.

## 7. WHY IT NEVER LANDED — the part that matters

**`sporefall-station` references `sporefall-art` nowhere.** No import, no path
constant, no note in its docs, no check. Verified by grep across `scripts/` and
`docs/`: the only hit is an unrelated line in `LORE.md`.

So a pipeline that its own authors described as replacing the SDXL approach
**entirely** sat unused for a month while the retired one kept shipping — and
nothing anywhere reported a problem, because nothing was watching for one.

**This is the third measured-recorded-inert failure in a single night:**

1. **juggernautXL for props** — measured 8/8 vs 1/8, written down, and still
   inert because `generate.py` ignored `PROP_CKPT` and the branch never merged.
2. **The shadowed theme pack** — art written to a pack the game does not read.
   Every check green, nothing visible.
3. **This.** A superseding pipeline, proven and documented, in a repo the
   shipping project does not know exists.

**Name the pattern, because it is the actual defect: the knowledge existed, the
system kept using the worse path, and every check stayed green.** A document
that records a technique but not why the last technique was ignored gets ignored
in exactly the same way. Writing it down is not adoption.

### What would make it stick

A recorded conclusion is not a fix. Concretely, any of these would have caught it:

- **An import or a path constant** in `scripts/assets/` pointing at the
  sporefall-art pipeline, so the dependency is real code rather than folklore.
- **A line in `docs/sprite-generation.md`** — the manual people actually read —
  saying the per-frame path is superseded and pointing here. A note in the *other*
  repo is a note nobody in this one will see.
- **A check that fails when the two repos disagree** about which pipeline is
  current — the same shape as `themePackParity.test.ts`, which now fails when art
  lands in a pack the game does not load.

The third is the only one that cannot rot, because it is the only one that
*fails* when it stops being true.
