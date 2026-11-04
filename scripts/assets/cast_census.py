#!/usr/bin/env python3
"""Census of the cast's walk frames: which archetype has what, where. Reads git and the run dirs; writes only --out.

    python3 scripts/assets/cast_census.py --out census.tsv --ref origin/wip/stalker-ship --ref rnd/multileg-walk

census.tsv         archetype, speed, character per pack, walk frames per direction on --main and on
                   --branch, the best assembled run, the --ref branches holding walk frames --branch
                   lacks, and the QUEUE.md row.
census-refs.tsv    per --ref: commits it adds, PNGs, text lines and walk frames --branch lacks, whether it
                   merges into --branch cleanly, the gate hash the merge would have, and off-theme words
                   (the lore-rename mapping) in the lines it would add.
"""
import argparse
import glob
import json
import os
import re
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIRS = ("s", "se", "e", "ne", "n")
PACKS = ("swampspace-hires", "swampspace")
WALK = re.compile(r"^(?P<kind>.+)-(?P<dir>s|se|e|ne|n)-walk-\d+\.png$")
HEAD_NAME = re.compile(r"chars/(.+)-s-idle\.png$")


def off_theme_words():
    with open(os.path.join(REPO, "scripts/codemods/lore-names.json")) as f:
        return re.compile(r"\b(" + "|".join(json.load(f)["terms"]) + r")\b", re.I)


def git(*args, check=True):
    r = subprocess.run(("git", "-C", REPO) + args, capture_output=True, text=True, errors="replace")
    if check and r.returncode:
        raise SystemExit(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r


def show(rev, path):
    return git("show", f"{rev}:{path}").stdout


def blobs(rev, pack):
    out = git("ls-tree", rev, f"public/themes/{pack}/chars/").stdout
    return {os.path.basename(l.split("\t")[1]): l.split()[2] for l in out.splitlines()}


def npcs(rev):
    """(archetype, speed) from the NPCS table, in file order."""
    rows, current, inside = [], None, False
    for line in show(rev, "src/game/data/npcs.ts").splitlines():
        inside = inside or line.startswith("export const NPCS")
        key = re.match(r"^  (\w+): \{", line) if inside else None
        if key:
            current = key.group(1)
        speed = re.match(r"^    speed: ([\d.]+)", line) if inside else None
        if speed and current:
            rows.append((current, float(speed.group(1))))
            current = None
    return rows


def aliases(rev):
    body = show(rev, "src/render/art.ts").split("CHARSET_ALIAS_BASE", 1)[1].split("\n}", 1)[0]
    return dict(re.findall(r"^\s+(\w+): '(\w+)',", body, re.M))


class Tree:
    """One revision's manifests and frames, per pack."""

    def __init__(self, rev):
        self.rev = rev
        self.sprites = {p: json.loads(show(rev, f"public/themes/{p}/manifest.json"))["sprites"] for p in PACKS}
        self.files = {p: blobs(rev, p) for p in PACKS}

    def character(self, arch, pack):
        m = HEAD_NAME.search(self.sprites[pack].get(f"char.{arch}.s-idle", ""))
        return m.group(1) if m else None

    def walk_counts(self, arch):
        """Per direction, frames with a manifest key whose file exists; the lower of the two packs,
        marked with * when the packs disagree."""
        per_pack = {}
        for pack in PACKS:
            per_pack[pack] = {
                d: sum(1 for k, v in self.sprites[pack].items()
                       if re.fullmatch(rf"char\.{arch}\.{d}-walk-\d+", k) and os.path.basename(v) in self.files[pack])
                for d in DIRS
            }
        low = {d: min(per_pack[p][d] for p in PACKS) for d in DIRS}
        text = " ".join(f"{d}{low[d]}" for d in DIRS) if any(low.values()) else "0"
        return text + ("*" if per_pack[PACKS[0]] != per_pack[PACKS[1]] else "")


def best_run(runs, kind):
    root = os.path.join(runs, kind)
    if not os.path.isdir(root):
        return "no run dir"
    if not os.listdir(root):
        return "empty run dir"
    takes = sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, "take*")) if os.path.isdir(p))
    sheet = os.path.join(root, "best-pal", "sheet.json")
    if not os.path.exists(sheet):
        return f"no assembled run; {len(takes)} take dirs" if takes else "input or concept only"
    with open(sheet) as f:
        loops = json.load(f).get("loops", {})
    seams = " ".join(f"{d} {loops[d]['seam']:.2f}" for d in DIRS if d in loops and "seam" in loops[d])
    others = sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, "*-pal")) if not p.endswith("best-pal"))
    also = f"; also {' '.join(others)}" if others else ""
    return f"best-pal seams {seams}; {len(takes)} take dirs{also}"


def queue_rows(path):
    rows = {}
    with open(path) as f:
        for line in f:
            cells = [c.strip() for c in line.split("|")]
            if len(cells) > 4 and re.fullmatch(r"\d+b?", cells[1]):
                for arch in re.split(r",\s*", cells[3]):
                    rows.setdefault(arch, f"#{cells[1]} {cells[2]}")
    return rows


def walk_frames_vs(ref_files, branch_files):
    """Per kind: walk frames the branch lacks, and walk frames both hold with other bytes."""
    lacks, differs = {}, {}
    for name, blob in ref_files.items():
        m = WALK.match(name)
        if m and name not in branch_files:
            lacks[m["kind"]] = lacks.get(m["kind"], 0) + 1
        elif m and branch_files[name] != blob:
            differs[m["kind"]] = differs.get(m["kind"], 0) + 1
    return lacks, differs


def added_lines(ref, branch):
    """What the ref adds since it forked and the branch does not hold: per path, the added text lines
    missing from the branch's copy, and the added or changed PNGs. A crash snapshot that only zeroed
    files adds nothing."""
    base = git("merge-base", branch, ref).stdout.split()[0]
    ours = {l.split("\t")[1]: l.split()[2] for l in git("ls-tree", "-r", branch).stdout.splitlines()}
    theirs = {l.split("\t")[1]: l.split()[2] for l in git("ls-tree", "-r", ref).stdout.splitlines()}
    text, pngs = {}, 0
    for path in git("diff", "--name-only", "--no-renames", base, ref).stdout.splitlines():
        if path not in theirs or ours.get(path) == theirs[path]:
            continue
        if path.endswith(".png"):
            pngs += 1
            continue
        held = set(show(branch, path).splitlines()) if path in ours else set()
        diff = git("diff", "--unified=0", "--no-renames", base, ref, "--", path).stdout.splitlines()
        new = [l[1:] for l in diff if l.startswith("+") and not l.startswith("+++") and l[1:] not in held]
        if new:
            text[path] = new
    return text, pngs


def gate_hash(rev):
    r = subprocess.run(("python3", os.path.join(REPO, "scripts/assets/gate_hash.py"), "--rev", rev),
                       capture_output=True, text=True)
    return r.stdout.strip().splitlines()[-1] if r.returncode == 0 and r.stdout.strip() else f"rc={r.returncode}"


def ref_row(ref, branch, branch_files, off_theme):
    sha = git("rev-parse", "--short", ref).stdout.strip()
    behind, ahead = git("rev-list", "--left-right", "--count", f"{branch}...{ref}").stdout.split()
    lacks, differs = walk_frames_vs(blobs(ref, PACKS[0]), branch_files)
    text, pngs = added_lines(ref, branch)
    merge = git("merge-tree", "--write-tree", "--name-only", branch, ref, check=False)
    lines = merge.stdout.splitlines()
    conflicts = []
    if merge.returncode == 1:
        for line in lines[1:]:
            if not line:
                break
            conflicts.append(line)
    off = sum(1 for new in text.values() for l in new if off_theme.search(l))
    return {
        "ref": ref, "sha": sha, "ahead": ahead, "behind": behind,
        "pngs_branch_lacks": pngs,
        "text_lines_branch_lacks": " ".join(f"{p}={len(new)}" for p, new in sorted(text.items())) or "none",
        "walk_frames_branch_lacks": " ".join(f"{k}={v}" for k, v in sorted(lacks.items())) or "none",
        "walk_frames_other_bytes": " ".join(f"{k}={v}" for k, v in sorted(differs.items())) or "none",
        "merges_clean": "yes" if merge.returncode == 0 else f"no: {len(conflicts)} conflicted",
        "conflicts": ",".join(conflicts),
        "gate_hash_after_merge": gate_hash(lines[0]) if merge.returncode == 0 else "n/a",
        "added_lines_off_theme": str(off),
    }, lacks


def tsv(path, header, rows):
    with open(path, "w") as f:
        f.write("\t".join(header) + "\n")
        for row in rows:
            f.write("\t".join(str(row[h]) for h in header) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--main", default="origin/main")
    ap.add_argument("--branch", default="HEAD")
    ap.add_argument("--runs", default="/mnt/d/tmp/cast-walks/runs")
    ap.add_argument("--ref", action="append", default=[])
    a = ap.parse_args()

    main_tree, branch_tree = Tree(a.main), Tree(a.branch)
    alias = aliases(a.branch)
    queue = queue_rows(os.path.join(REPO, "docs/cast-walks/QUEUE.md"))

    ref_rows, wip, off_theme = [], {}, off_theme_words()
    for ref in a.ref:
        row, lacking = ref_row(ref, a.branch, branch_tree.files[PACKS[0]], off_theme)
        ref_rows.append(row)
        for kind, n in lacking.items():
            wip.setdefault(kind, []).append(f"{ref.removeprefix('origin/')}={n}")

    rows = []
    for arch, speed in npcs(a.branch) + [("player", "n/a (not in npcs.ts)")]:
        sets = arch if f"char.{arch}.s-idle" in branch_tree.sprites[PACKS[0]] else alias.get(arch, arch)
        kinds = [branch_tree.character(sets, p) for p in PACKS]
        kind = kinds[0] or kinds[1]
        rows.append({
            "archetype": arch,
            "speed": speed,
            "character": (kind or "NONE") if kinds[0] == kinds[1] else f"{kinds[0]} | {kinds[1]}",
            "uses_set_of": "" if sets == arch else sets,
            "walk_frames_main": main_tree.walk_counts(sets),
            "walk_frames_branch": branch_tree.walk_counts(sets),
            "best_run": best_run(a.runs, kind) if kind else "n/a",
            "wip_refs": "; ".join(wip.get(kind, [])) or "none",
            "queue_row": queue.get(arch, "NO ROW"),
        })
    tsv(a.out, list(rows[0]), rows)
    if ref_rows:
        tsv(os.path.splitext(a.out)[0] + "-refs.tsv", list(ref_rows[0]), ref_rows)
    print(f"{len(rows)} archetypes -> {a.out}; {len(ref_rows)} refs")


if __name__ == "__main__":
    main()
