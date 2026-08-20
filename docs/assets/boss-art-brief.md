# Art brief — Mireclaw Alpha (`boss`)

**Status: ART COMPLETE (2026-08-20).**

**The custom-node blocker previously recorded here was STALE and has been struck.**
`comfyui_ipadapter_plus`, `rembg-comfyui-node` and `comfy-mtb` were installed
2026-08-08 and verified live on 2026-08-20 against ComfyUI's 942 registered nodes
(IPAdapter 28, rembg 2, mtb 80). **No owner approval is required.** The referenced
`_mycel-results/assets.md` is not in this repository.

Note for whoever generates the next creature: **do NOT IPAdapter-anchor a new
creature on an existing character sprite.** Held-seed A/B at seed 900044 gave
0 violet pixels at every anchor weight tried versus 141 unanchored — the anchor
sprites are themselves desaturated, so style transfer faithfully reproduces grey
and recreates the same-as-the-common-enemy problem the anchor was meant to
prevent. The roster is already mixed-base, so that consistency risk is overstated.

## Why it is needed

`boss` had no art of its own: `art.CHARSET_ALIAS` mapped it to `thug`, so the Mireclaw Alpha was
**pixel-identical to the commonest enemy in the game** — same body, same palette, same size. That
is the single largest reason the owner cleared roughly six boss floors and reported never having
met a boss.

Everything that can be fixed *without* art has been:

- a `bossReveal` entrance card and a pinned health bar with a phase read-out (`ui/bossModel.ts`);
- `ARCHETYPE_SCALE.boss = 1.5`, so it draws half again the size of its own brood;
- claws instead of a baseball bat, drawing no held weapon sprite at all.

The silhouette is the last piece.

## The seam is already open — no code change needed

Two changes in this branch mean the art pass is pure asset work:

1. `boss` was added to `theme.CHAR_NAMES`, so `char.boss.*` is now a **canonical manifest key**.
   Before this, `validateManifest` would have dropped a boss sprite mapping with a warning.
2. `art.characterSet` now prefers an archetype's **own** set over the one it borrows
   (`sprites.chars[archetype] ?? sprites.chars[alias] ?? procedural`). Drop the files in, map them
   in the manifest, and the Alpha promotes off the thug body automatically.

Leave `CHARSET_ALIAS.boss = 'thug'` in place as the fallback.

## Spec

| | |
|---|---|
| Manifest keys | `char.boss.<dir>-idle` and `char.boss.<dir>-step`, `dir` ∈ `s, se, e, ne, n` (10 files minimum) |
| Canvas | 48×48 logical, **feet-anchored** (the body sits its feet half a tile below centre) |
| `swampspace-hires` | same logical size authored at 96×96 — that pack declares `artScale: 2` |
| West half | mirrored from the east half at runtime; do **not** author w/sw/nw |
| Optional | the `char.boss.<dir>-<state>-<n>` state grammar (walk/attack/death) if the pipeline gets that far |

Both packs must be updated: `swampspace-hires` does not `extend` the base pack.

## The creature

From `docs/LORE.md` and the shipped names, the Alpha is the apex of a **named food chain** the
player now sees on screen: Mireclaw Brood (`sporeling`, its summoned adds) → Mireclaw Scavenger
(`stalker`) → **Mireclaw Alpha**. It must read as the *same animal lineage* as those two, scaled
up and armoured — not as a separate monster.

- Low-slung arthropod, chitin-plated, **clawed** (the claws are its weapon and must be visible in
  the silhouette — that is what replaced the baseball bat).
- Palette: the theme already assigns it violet `#a05ae0`, against the thug's dusty red `#d17f7f`.
  Lean on that — violet chitin, spore-bloom highlights.
- It lives in the spore and regenerates in it (phase 2), so wisps/growth on the carapace are on-lore.
- **Must not** read as an upright humanoid. That was the recurring failure mode in the `stalker`
  seed sweep: 3 of the first 4 seeds drifted to upright bipeds without the IPAdapter anchor.

## Gotchas carried forward from the last attempt

- Run the **silhouette-consistency gate on the posted 48px sprites, not the 1024px raws** — on an
  alpha-less raw it measures the full frame and reports a meaningless pass.
- At 48px thin arthropod legs alias out and dark chitin quantizes to grey. Author a **thicker,
  heavier** silhouette than looks right at 1024, and keep the value range off pure black.
- Existing `stalker` raws worth mining for lineage consistency:
  `D:/tmp/swampspace-stage/char.mireclaw-stalker.s-idle/` (seed `00007` fits the brief).
