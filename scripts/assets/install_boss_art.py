#!/usr/bin/env python3
"""Take a generated BOSS sprite into the two shipping theme packs.

WHY THIS IS A SCRIPT AND NOT A CHECKLIST. Installing a boss touches FIVE places,
and every single one of them is SILENT when forgotten — the art lands, nothing
errors, and the boss still draws as a procedural blob. The Mireclaw Alpha
(commit 3d94177) moved all five by hand, and the commit message is mostly a list
of the ways that could have gone wrong. Three more bosses are coming, so the
sequence is written down here instead of being rediscovered:

  1. `swampspace-hires/chars/<kind>-s-<state>.png` at 96px. The hi-res pack is
     the game's DEFAULT theme (theme.ts DEFAULT_THEME_ID) and it does NOT
     `extend` the base pack — it carries its own full sprite table. Art that
     stops at the 48px pack is art the player never sees (that shipped once:
     nine sprites written to base only, every check green, nobody saw them —
     see themePackParity.test.ts).
  2. `swampspace/chars/<kind>-s-<state>.png` at 48px. Still load-bearing even
     though hires answers first: it is the BASE of every resolution chain, and
     it is the only pack `charConsistency.test.ts` and `consistency.py` measure.
  3. BOTH manifests gain the ten `char.<arch>.<dir>-<frame>` keys. The engine
     reads the MAPPING, not the filename, so the four other directions borrow
     the `s` art (theme.ts DIR_FALLBACK) exactly as every other non-player NPC
     does.
  4. `curation.json` gains a lineage row and the source raw is copied into the
     committed `raws/` dir. Recording a pick by its /tmp path is how the pack
     lost the ability to reproduce its own sprites once already.
  5. `consistency-spec.json` gains the character's silhouette envelope. This one
     is the newest trap: `charConsistency.test.ts` asserts a committed spec
     exists for EVERY character kind with files in the base pack, so dropping
     PNGs in without a spec turns the suite red on a file it has never seen.

WHAT THIS SCRIPT DELIBERATELY DOES NOT DO: pick seeds, or judge art. `CURATED`
in install_props.py is a hand-edited list chosen off a contact sheet at game
size, and boss art is chosen the same way — by eye, by the owner. This script is
the plumbing that runs AFTER that decision.

THE CANONICAL-KEY TRAP, which is the one that costs a whole art pass. A
`char.<arch>.*` key whose archetype is not in `theme.ts CHAR_NAMES` is NOT a
canonical sprite key, so `validateManifest` DROPS the mapping with a warning and
the PNG is discarded however correct the file is. `boss` had to be added to
CHAR_NAMES for exactly this reason before the Alpha could load. This script
refuses to run for an archetype that is not listed there rather than writing
files that cannot work — see `assert_canonical` below.

NEVER DELETES. A shipped frame that is about to be overwritten is copied into
`raws/archive/<pack>/` first. Generated assets in this project get archived,
never removed.

Usage:
    python3 install_boss_art.py vigil --idle RAW.png --dry-run
    python3 install_boss_art.py vigil --idle RAW.png --step RAW-step.png \\
        --seed 900123 --ckpt juggernautXL --note "fused into the bulkhead"
    python3 install_boss_art.py echo --idle RAW.png        # step is synthesized

Re-runnable: identical sources produce identical bytes, the manifest keys are
set rather than appended, and a frame whose bytes have not changed is not
re-archived.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import consistency as C  # noqa: E402
import generate as G  # noqa: E402
import post as P  # noqa: E402
from manifest import BOSS_KINDS, CHAR_FILES  # noqa: E402
from palette_metrics import CAST, band, measure  # noqa: E402

ROOT = HERE.parents[1]
THEMES = ROOT / "public" / "themes"
ARCHIVE = HERE / "raws" / "archive"
THEME_TS = ROOT / "src" / "render" / "theme.ts"

# (pack, canvas px, content px, manifest indent).
#
# The two content figures are NOT invented: they are what the shipped Mireclaw
# Alpha actually measures. `generate.py final` posts characters at
# `content = px - 2` (48 -> 46) and `hires_chars.py` posts at 96/92, and the
# Alpha's frames come back with a 44px and a 90px content bbox respectively —
# the extra pixel each side is `kcentroid` dropping a mostly-transparent edge
# column. Post a new boss at these numbers and it lands at the same scale as the
# cast it stands next to.
#
# The INDENT is per pack on purpose. `manifest.py` writes the base manifest with
# indent=2 and `hires_chars.py` writes the hi-res one with indent=1. Matching
# each file's existing style keeps this script's diff to the keys it actually
# changed instead of reformatting four hundred lines of unrelated manifest.
TARGETS = [
    ("swampspace", 48, 46, 2),
    ("swampspace-hires", 96, 92, 1),
]

# The five drawn directions and their borrow order (theme.ts DIR_FALLBACK).
# Only `s` is ever drawn for a boss; the other four MAP to the s art. The engine
# mirrors the west half at runtime, so sw/w/nw are never authored.
DIRS5 = ("s", "se", "e", "ne", "n")
STATES = ("idle", "step")


def assert_canonical(arch: str) -> None:
    """Refuse to install art for an archetype `theme.ts` has not declared.

    This is the whole reason the Alpha's art pass needed a code change before it
    could land: `char.<arch>.*` is only a canonical sprite key when `<arch>` is
    in CHAR_NAMES, and `validateManifest` silently drops everything else. Failing
    here — loudly, before a single byte is written — is the difference between a
    five-second fix and an afternoon spent wondering why correct PNGs do nothing.
    """
    src = THEME_TS.read_text(encoding="utf8")
    m = re.search(r"export const CHAR_NAMES\s*=\s*\[(.*?)\]\s*as const", src, re.S)
    if not m:
        raise SystemExit(f"could not find CHAR_NAMES in {THEME_TS} — has it moved?")
    names = set(re.findall(r"'([^']+)'", m.group(1)))
    if arch not in names:
        raise SystemExit(
            f"'{arch}' is NOT in theme.ts CHAR_NAMES, so char.{arch}.* is not a\n"
            f"canonical sprite key: validateManifest would DROP every mapping this\n"
            f"script writes and the art would never load. Add '{arch}' to\n"
            f"CHAR_NAMES first (src/render/theme.ts), then re-run."
        )


def kind_for(arch: str) -> str:
    """The theme's file stem ("kind") for an archetype.

    Single-sourced from `manifest.py` so the filenames this script writes and the
    filenames a full manifest regeneration looks for can never disagree — that
    disagreement is exactly how `char.boss.*` would have silently reverted to the
    bog mutant.
    """
    if arch in BOSS_KINDS:
        return BOSS_KINDS[arch]
    if arch in CHAR_FILES:
        return CHAR_FILES[arch]
    raise SystemExit(
        f"unknown archetype '{arch}'. Known bosses: {', '.join(sorted(BOSS_KINDS))}.\n"
        f"Add it to BOSS_KINDS in manifest.py (and to theme.ts CHAR_NAMES) first."
    )


def archive_existing(dst: Path, incoming: bytes, dry: bool) -> Path | None:
    """Copy a frame we are about to overwrite into raws/archive/. Never deletes.

    Skipped when the bytes are identical, which is what keeps a re-run from
    filling the archive with copies of the same sprite.
    """
    if not dst.exists() or dst.read_bytes() == incoming:
        return None
    pack = dst.parent.parent.name
    out_dir = ARCHIVE / pack
    n = 0
    while True:
        cand = out_dir / f"{dst.stem}-{n}{dst.suffix}"
        if not cand.exists():
            break
        n += 1
    if not dry:
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dst, cand)
    return cand


def post_frame(src: Image.Image, px: int, content: int) -> Image.Image:
    """Raw -> keyed -> shadow-stripped -> bbox -> k-centroid -> palette -> canvas.

    `post.sprite` is the same call `generate.py final` and `hires_chars.py` make,
    so a boss goes through the identical pipeline as the rest of the cast: same
    locked palette, same hard alpha, same feet-on-the-bottom anchoring the engine
    expects (docs/themes.md "Character art convention").
    """
    return P.sprite(src, px, content=content, anchor="bottom")


def build_frames(idle_src: Path, step_src: Path | None, px: int, content: int
                 ) -> dict[str, Image.Image]:
    """The two posted frames for one pack.

    With no `--step` raw the step frame is SYNTHESIZED from the posted idle by
    `post.derive_step` — the same deterministic 1-2px gait shuffle the rest of
    the cast uses when GPU budget rules out a second diffusion pose. The engine
    alternates idle/step while a character moves, so a boss with no step frame
    reads as sliding rather than walking.
    """
    idle = post_frame(Image.open(idle_src), px, content)
    step = (post_frame(Image.open(step_src), px, content) if step_src
            else P.derive_step(idle))
    return {"idle": idle, "step": step}


def update_manifest(pack: str, arch: str, kind: str, indent: int, dry: bool) -> int:
    """Point all ten `char.<arch>.<dir>-<frame>` keys at the new art.

    Every direction key is written explicitly, borrowing the `s` art, because
    sprite keys resolve PER KEY against the theme chain: a direction this pack
    omits falls through to whatever the next pack in the chain says, which is how
    a boss could end up facing south as itself and east as a bog mutant.
    """
    mpath = THEMES / pack / "manifest.json"
    raw = mpath.read_text(encoding="utf8")
    man = json.loads(raw)
    sprites = man["sprites"]
    before = len(sprites)
    for d in DIRS5:
        for state in STATES:
            sprites[f"char.{arch}.{d}-{state}"] = f"chars/{kind}-s-{state}.png"
    if not dry:
        # Reproduce the file's existing trailing-newline state along with its
        # indent. `manifest.py` and `hires_chars.py` both write via `json.dump`,
        # which ends the file without one; silently adding it here would put a
        # whole-file whitespace change in the diff of every art drop, which is
        # exactly the noise the per-pack indent above exists to avoid.
        eol = "\n" if raw.endswith("\n") else ""
        mpath.write_text(json.dumps(man, indent=indent) + eol, encoding="utf8")
    return len(sprites) - before


def record_lineage(arch: str, kind: str, srcs: dict[str, Path], args, dry: bool) -> None:
    """Archive each source raw and record where it came from.

    Delegates to `generate.persist_raw`, which is "the one true way to approve a
    pick": it copies the raw into the committed `raws/` dir and writes the
    curation row with a RELATIVE path, so the pick survives the machine it was
    made on. curation.json rows recorded by absolute /tmp path all died with
    their session — that is what migrate_curation.py exists to clean up.
    """
    for state, src in srcs.items():
        job = f"char.{kind}.s-{state}"
        size = Image.open(src).size[0]
        note = args.note or f"{arch} boss sprite, s-{state}"
        if dry:
            print(f"  (dry) curation row {job}: seed={args.seed} size={size} "
                  f"ckpt={args.ckpt} note={note!r}")
            continue
        G.persist_raw(job, str(src), seed=args.seed, index=args.index,
                      note=note, size=size, ckpt=args.ckpt)


def write_spec(kind: str, dry: bool) -> None:
    """Commit the character's silhouette envelope, derived from its s-idle.

    Required, not optional: `charConsistency.test.ts` fails on any character kind
    present in the base pack with no committed spec. Tolerances come from
    `consistency.DEFAULT_TOL` and an existing hand-tuned `tol` is preserved, so
    re-running this after a re-render updates the reference without discarding a
    tolerance somebody widened on purpose.
    """
    if dry:
        print(f"  (dry) consistency-spec.json <- {kind}=s-idle")
        return
    C.write_spec([f"{kind}=s-idle"])


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Install a boss sprite into both shipped theme packs.")
    ap.add_argument("archetype", help=f"one of: {', '.join(sorted(BOSS_KINDS))}")
    ap.add_argument("--idle", required=True, type=Path, help="source PNG for s-idle")
    ap.add_argument("--step", type=Path,
                    help="source PNG for s-step (synthesized from idle if omitted)")
    ap.add_argument("--seed", type=int, help="generation seed, for the lineage row")
    ap.add_argument("--index", type=int, default=0, help="index within the batch")
    ap.add_argument("--ckpt", help="checkpoint name, for the lineage row")
    ap.add_argument("--note", help="one-line note for the lineage row")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run

    arch = args.archetype
    assert_canonical(arch)
    kind = kind_for(arch)
    for p in (args.idle, args.step):
        if p is not None and not p.exists():
            raise SystemExit(f"missing source: {p}")

    srcs = {"idle": args.idle}
    if args.step:
        srcs["step"] = args.step

    print(f"{'(dry) ' if dry else ''}installing {arch} as '{kind}'"
          f"{'' if args.step else '  (step frame SYNTHESIZED from the idle)'}")

    # The cast band the rest of the pack sits in, so a boss that lands outside it
    # is visible here rather than in a screenshot three weeks later. Same floors
    # install_props.py prints against.
    chars = THEMES / "swampspace" / "chars"
    b = band({n: measure(chars / f"{n}.png") for n in CAST})

    for pack, px, content, indent in TARGETS:
        frames = build_frames(args.idle, args.step, px, content)
        outdir = THEMES / pack / "chars"
        print(f"\n{'(dry) ' if dry else ''}{pack}  ({px}px canvas, {content}px content)")
        print(f"  {'frame':<26}{'sat_frac':>10}{'chroma_p90':>12}"
              f"{'value_range':>13}{'palette_n':>11}   vs cast floor")
        for state, im in frames.items():
            dst = outdir / f"{kind}-s-{state}.png"
            tmp = ROOT / ".install-boss-tmp.png"
            im.save(tmp)
            incoming = tmp.read_bytes()
            m = measure(tmp)
            flags = [k for k in ("sat_frac", "chroma_p90", "value_range", "palette_n")
                     if m[k] < b[k]["min"]]
            print(f"  {dst.name:<26}{m['sat_frac']:>10.3f}{m['chroma_p90']:>12.0f}"
                  f"{m['value_range']:>13.3f}{m['palette_n']:>11d}   "
                  + (("UNDER: " + ", ".join(flags)) if flags else "all clear"))
            kept = archive_existing(dst, incoming, dry)
            if kept:
                print(f"    archived the frame it replaces -> "
                      f"{os.path.relpath(kept, ROOT)}")
            if not dry:
                outdir.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(incoming)
            tmp.unlink(missing_ok=True)
        n = update_manifest(pack, arch, kind, indent, dry)
        print(f"  manifest: 10 char.{arch}.* keys written ({n} new)")

    print(f"\n  cast floors: sat {b['sat_frac']['min']:.3f}  "
          f"chroma {b['chroma_p90']['min']:.0f}  value {b['value_range']['min']:.3f}  "
          f"palette_n {b['palette_n']['min']}")

    print("\nlineage")
    record_lineage(arch, kind, srcs, args, dry)
    print("silhouette spec")
    write_spec(kind, dry)

    if dry:
        print("\nDRY RUN — nothing written. Drop --dry-run to install.")
    else:
        print(f"\ninstalled {arch}. Run the gate:\n"
              f"  python3 scripts/assets/consistency.py --check\n"
              f"  corepack pnpm exec vitest run src/render")
    return 0


if __name__ == "__main__":
    sys.exit(main())
