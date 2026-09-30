#!/usr/bin/env python3
"""The cast ship gate's version: one hash over exactly the content that decides PASS or FAIL.

    python3 scripts/assets/gate_hash.py              # print the current gate hash
    python3 scripts/assets/gate_hash.py --check      # exit 1 unless it is the head of GATE-CHANGES.md
    python3 scripts/assets/gate_hash.py --rev c0c1e77  # the hash of the gate at a git revision
    python3 scripts/assets/gate_hash.py --parts      # one hash per component, to see which moved

Hashed (the gate definition):
  cast-gate-spec.json    every value; keys starting with "_" are notes and are left out
  consistency-spec.json  per kind, everything but the measured `ref` (export re-derives it); a
                         tol value equal to consistency.DEFAULT_TOL and ref_frame "s-idle" are
                         left out, so a new kind written with the defaults moves nothing
  cast_walk.py           the module minus NON_GATE (export, sheet, embed, assemble, argparse)
                         and its top-level imports
  verify.py              the whole module: prompts, model, votes, num_predict, job rules
  consistency.py         the module minus NON_GATE (report, write_spec)
Python is compared as its syntax tree, so comments, docstrings, blank lines, indentation and
spacing do not move the hash; a changed number, string, name or branch does. JSON is compared
parsed, so its whitespace and key order do not move it either.

Changing the gate: docs/cast-walks/GATE-CHANGES.md, and Aaron approves it first.
"""
import argparse
import ast
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
LEDGER = os.path.join(REPO, "docs", "cast-walks", "GATE-CHANGES.md")
ASSETS = "scripts/assets"

NON_GATE = {
    "cast_walk.py": ("FLOWS", "out_dir", "archetypes", "cmd_export", "_frames", "_tEXt", "_with_flow", "save_flows",
                     "cmd_embed", "cmd_assemble", "_flow_of", "_row", "cmd_sheet", "main"),
    "verify.py": (),
    "consistency.py": ("report", "write_spec"),
}
FIELDS = ("Hash", "Commit", "Kind", "Changed", "Why the old rule was wrong", "Old gate vs new on the shipped cast",
          "Negative controls", "Approved-by")
# Entries up to and including this one were written after the fact, on 2026-09-29, and may say
# "Approved-by: none (...)". Every later entry quotes Aaron.
LAST_RETROACTIVE = 7
APPROVAL = re.compile(r'^Aaron "[^"]{3,}" \(\d{4}-\d{2}-\d{2}[^)]*\)')


def _strip_notes(v):
    if isinstance(v, dict):
        return {k: _strip_notes(x) for k, x in v.items() if not k.startswith("_")}
    if isinstance(v, list):
        return [_strip_notes(x) for x in v]
    return v


def _tree(node):
    """A syntax tree as plain data: node types, fields and constants; no positions. Fields that are
    None or empty are dropped, so a field a newer Python adds (type_params) hashes like its absence."""
    if isinstance(node, ast.AST):
        fields = {}
        for f in node._fields:
            v = getattr(node, f, None)
            if v is not None and v != []:
                fields[f] = _tree(v)
        return [type(node).__name__, fields]
    if isinstance(node, list):
        return [_tree(x) for x in node]
    return [type(node).__name__, repr(node)]


def _without_docstrings(tree):
    for n in ast.walk(tree):
        body = getattr(n, "body", None)
        if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and body \
                and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                and isinstance(body[0].value.value, str):
            n.body = body[1:] or [ast.Pass()]
    return tree


def _names(node):
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return {"import"}
    targets = getattr(node, "targets", None) or [getattr(node, "target", None)]
    return {getattr(node, "name", None)} | {getattr(t, "id", None) for t in targets}


def python_def(src, skip):
    """A module's gate content: its syntax tree without docstrings, module-level imports and the
    top-level defs or assignments named in skip. A gate function that calls a new helper hashes the
    helper too, because only names listed in NON_GATE are left out."""
    tree = _without_docstrings(ast.parse(src))
    tree.body = [n for n in tree.body if not _names(n) & {"import", *skip}]
    return _tree(tree)


def default_tol(consistency_src):
    for n in ast.parse(consistency_src).body:
        if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "DEFAULT_TOL" for t in n.targets):
            return ast.literal_eval(n.value)
    return {}


def consistency_def(spec, defaults):
    out = {}
    for kind, entry in spec.items():
        e = {k: v for k, v in entry.items() if k != "ref"}
        if e.get("ref_frame") == "s-idle":
            del e["ref_frame"]
        tol = {k: v for k, v in e.pop("tol", {}).items() if defaults.get(k) != v}
        if tol:
            e["tol"] = tol
        if e:
            out[kind] = e
    return out


def parts(read):
    """read(relative path) -> text. The gate definition as {component: canonical data}."""
    cons_src = read(f"{ASSETS}/consistency.py")
    return {
        "cast-gate-spec.json": _strip_notes(json.loads(read(f"{ASSETS}/cast-gate-spec.json"))),
        "consistency-spec.json": consistency_def(json.loads(read(f"{ASSETS}/consistency-spec.json")),
                                                 default_tol(cons_src)),
        **{f: python_def(read(f"{ASSETS}/{f}"), skip) for f, skip in NON_GATE.items()},
        "non-gate": {f: sorted(skip) for f, skip in NON_GATE.items()},
    }


def _digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def gate_hash(read=None):
    return _digest(parts(read or _read_file))


def _read_file(rel):
    with open(os.path.join(REPO, rel), encoding="utf-8") as fh:
        return fh.read()


def _read_rev(rev):
    return lambda rel: subprocess.run(["git", "-C", REPO, "show", f"{rev}:{rel}"], capture_output=True,
                                      text=True, check=True).stdout


def ledger(text):
    """GATE-CHANGES.md -> [{n, title, fields...}] in file order, and a list of format problems."""
    entries, probs = [], []
    for m in re.finditer(r"^## G(\d+)\b(.*)$", text, re.M):
        end = text.find("\n## ", m.end())
        body = text[m.end():] if end < 0 else text[m.end():end]
        e = {"n": int(m.group(1)), "title": m.group(2).strip(" .")}
        for f in re.finditer(r"^- ([A-Za-z][A-Za-z -]*?): (.+?)(?=^- [A-Z]|\Z)", body, re.M | re.S):
            e[f.group(1)] = " ".join(f.group(2).split())
        entries.append(e)
    for i, e in enumerate(entries):
        where = f"G{e['n']}"
        if e["n"] != i:
            probs.append(f"{where}: entries are numbered G0, G1, ... in order; this one is number {i}")
        missing = [f for f in FIELDS if not e.get(f)]
        if missing:
            probs.append(f"{where}: missing {', '.join(missing)}")
            continue
        if not re.fullmatch(r"`[0-9a-f]{16}`", e["Hash"]):
            probs.append(f"{where}: Hash must be the 16-hex gate hash in backticks, got {e['Hash']!r}")
        if e["Kind"] != "all" and not re.fullmatch(r"[a-z][a-z0-9-]*", e["Kind"]):
            probs.append(f"{where}: Kind is 'all' or exactly one kind, got {e['Kind']!r}")
        approved = APPROVAL.match(e["Approved-by"])
        if not approved and not (e["n"] <= LAST_RETROACTIVE and e["Approved-by"].startswith("none (")):
            probs.append(f"{where}: Approved-by must quote Aaron with a date, as "
                         f"'Aaron \"<his words>\" (YYYY-MM-DD)'; got {e['Approved-by'][:60]!r}")
    return entries, probs


HOW = """A gate change is deliberate. It is never how a character gets shipped.
  Worker: do not change the gate. Report the failing numbers and frames to the coordinator.
  Changing it on purpose: add the next entry to docs/cast-walks/GATE-CHANGES.md with
    Hash: `{h}`, what changed, why the old rule was wrong (evidence on art the old rule
    misjudged, not "our art failed it"), the old gate and the new one on the shipped cast,
    the negative controls that still fail, and Approved-by: Aaron "<his words>" (<date>).
  An exception for one character is its own entry, and its Kind names that one kind."""


def check(read=None, ledger_text=None):
    """Problems with the current gate against the ledger; [] means the gate is the approved head."""
    read = read or _read_file
    if ledger_text is None:
        ledger_text = read("docs/cast-walks/GATE-CHANGES.md")
    h = gate_hash(read)
    entries, probs = ledger(ledger_text)
    if not entries:
        return [f"docs/cast-walks/GATE-CHANGES.md has no entries\n{HOW.format(h=h)}"]
    head = entries[-1]
    if head.get("Hash") != f"`{h}`":
        probs.append(f"the cast gate definition is {h}, but the head of docs/cast-walks/GATE-CHANGES.md "
                     f"(G{head['n']}) is {head.get('Hash', '?')}: the gate changed with no ledger entry.\n"
                     f"{HOW.format(h=h)}")
    spec = json.loads(read(f"{ASSETS}/cast-gate-spec.json"))
    kinds_with_entry = {e.get("Kind") for e in entries}
    for kind in spec.get("seam_exception", {}):
        if kind not in kinds_with_entry:
            probs.append(f"cast-gate-spec.json seam_exception.{kind} has no GATE-CHANGES.md entry with "
                         f"Kind: {kind}. An exception covers exactly the kind Aaron named.")
    for pack in ("swampspace-hires", "swampspace"):
        cur = read(f"public/themes/{pack}/CURATION.md")
        for cited in set(re.findall(r"gate `?([0-9a-f]{16})`?", cur)) - {e["Hash"].strip("`") for e in entries
                                                                           if "Hash" in e}:
            probs.append(f"public/themes/{pack}/CURATION.md cites gate {cited}, which no ledger entry has")
    return probs


def require_head():
    """For cast_walk.py gate: the current hash and its ledger entry, or exit with the reason."""
    probs = check()
    if probs:
        raise SystemExit("REFUSED: the ship gate is not an approved version.\n" + "\n".join(probs))
    entries, _ = ledger(_read_file("docs/cast-walks/GATE-CHANGES.md"))
    return gate_hash(), f"G{entries[-1]['n']}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--rev")
    ap.add_argument("--parts", action="store_true")
    a = ap.parse_args()
    read = _read_rev(a.rev) if a.rev else _read_file
    if a.check:
        probs = check(read)
        for p in probs:
            print("FAIL", p)
        if not probs:
            print(f"ok  gate {gate_hash(read)} is the head of GATE-CHANGES.md")
        sys.exit(1 if probs else 0)
    if a.parts:
        for k, v in parts(read).items():
            print(f"{_digest(v)}  {k}")
    print(gate_hash(read))


if __name__ == "__main__":
    main()
