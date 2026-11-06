#!/usr/bin/env python3
"""Rename the mundane weapon ids to the lore weapons, everywhere code names them.

Idempotent: run it on any branch after merging art/lore-weapons-1106 and it
converts that branch's own new uses of the old ids (a test that arms someone
with a 'pistol', a fixture holding "pickup.wrench"). `src/game/data/
loreWeapons.test.ts` fails while any old id survives, so a missed semantic
conflict is a red test, not a silent unknown item.

Rewrites quoted ids ('pistol', "pistol"), dotted forms (pickup.pistol,
WEAPONS.pistol, item.pistol) and object keys (`pistol: {`), in src/, e2e/ and
scripts/ (.ts .mts .mjs .json). Comments and prose are left alone. The net
ARCHETYPES list is skipped: old pickup names stay there as RETIRED entries so
wire indices never shift.

    python3 scripts/rename-weapon-ids.py [--check]
"""
import re
import sys
from pathlib import Path

RENAMES = {
    "pistol": "decanter",
    "wrench": "pressureLance",
    "knife": "siphonSpike",
    "sledgehammer": "cageRam",
    "shotgun": "scatterFunnel",
    "machinegun": "coilRepeater",
    "flamethrower": "phosphorHose",
    "freezeRay": "frostCondenser",
    "tranquilizer": "lullDarter",
    "stunGun": "sparkCoil",
}
ROOT = Path(__file__).resolve().parent.parent
SKIP = {
    "src/net/protocol/messages.ts",  # ARCHETYPES: append-only wire table, edited by hand
    "scripts/rename-weapon-ids.py",
    "src/game/data/loreWeapons.test.ts",  # names the old ids on purpose
    "scripts/codemods/lore-names.json",  # an earlier codemod's own old->new map
}
SKIP_DIRS = ("scripts/assets/",)
OLD = "|".join(sorted(RENAMES, key=len, reverse=True))
QUOTED = re.compile(rf"(['\"`])({OLD})(['\"`])")
DOTTED = re.compile(rf"\b(pickup|WEAPONS|item|weapons|weapon)\.({OLD})\b")
KEY = re.compile(rf"(^|[\s{{,])({OLD})(\s*:)")


def code_part(line: str) -> tuple[str, str]:
    """Split a line into code and trailing // comment (naive but fine for this repo)."""
    s = line.lstrip()
    if s.startswith(("//", "*", "/*")):
        return "", line
    i = line.find(" //")
    return (line, "") if i < 0 else (line[:i], line[i:])


def rewrite(text: str, is_json: bool) -> str:
    out = []
    for line in text.splitlines(keepends=True):
        code, comment = (line, "") if is_json else code_part(line)
        code = QUOTED.sub(lambda m: m.group(1) + RENAMES[m.group(2)] + m.group(3), code)
        code = DOTTED.sub(lambda m: m.group(1) + "." + RENAMES[m.group(2)], code)
        if not is_json:
            code = KEY.sub(lambda m: m.group(1) + RENAMES[m.group(2)] + m.group(3), code)
        else:
            code = re.sub(rf'"pickup\.({OLD})"', lambda m: f'"pickup.{RENAMES[m.group(1)]}"', code)
        out.append(code + comment)
    return "".join(out)


def main() -> int:
    check = "--check" in sys.argv
    changed = []
    for base in ("src", "e2e", "scripts"):
        for p in (ROOT / base).rglob("*"):
            rel = p.relative_to(ROOT).as_posix()
            if p.suffix not in (".ts", ".mts", ".mjs", ".json") or rel in SKIP or "node_modules" in rel:
                continue
            if rel.startswith(SKIP_DIRS):
                continue
            src = p.read_text()
            new = rewrite(src, p.suffix == ".json")
            if new != src:
                changed.append(rel)
                if not check:
                    p.write_text(new)
    print(("would change " if check else "changed ") + f"{len(changed)} files")
    for c in changed:
        print("  " + c)
    return 1 if (check and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
