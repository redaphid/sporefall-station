#!/usr/bin/env python3
"""Selftest for packs.py. Exit 0 = pass, nonzero = number of failures.

Judged by EXIT CODE, not by the absence of the word FAIL: a harness that aborts
prints no failures and no verdict, so "everything passed" and "nothing ran" read
identically. This prints a count and a verdict, and returns the count.

Every case is a real thing that happened on 2026-08-23, or a real thing that
must never happen.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import packs  # noqa: E402

FAILS = []
RAN = 0
KEY = "char.brute.s-idle"


def check(name, cond):
    global RAN
    RAN += 1
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}")
        FAILS.append(name)


def raises_shadowed(pack, keys):
    try:
        packs.assert_writable(pack, keys)
        return False
    except packs.ShadowedWrite:
        return True


# --- the bug of 2026-08-23, reproduced exactly ------------------------------
check("base-pack write of a key hires already has is reported as shadowed",
      packs.shadows("swampspace", {KEY}).get(KEY) == "swampspace-hires")

check("assert_writable RAISES on that write (a warning would be ignored at 3am)",
      raises_shadowed("swampspace", {KEY}))

# --- the refusal must be actionable -----------------------------------------
msg = ""
try:
    packs.assert_writable("swampspace", {KEY})
except packs.ShadowedWrite as e:
    msg = str(e)
check("the refusal names the shadowing pack", "swampspace-hires" in msg)
check("the refusal names the offending key", KEY in msg)

# --- legitimate writes must still be allowed (or the guard is useless) ------
check("writing into the pack the game loads is NOT shadowed",
      packs.shadows(packs.default_pack(), {KEY}) == {})
check("a genuinely new key in the base pack is allowed",
      packs.shadows("swampspace", {"char.nonexistent-archetype.s-idle"}) == {})
check("a legitimate write does NOT raise",
      not raises_shadowed(packs.default_pack(), {KEY}))

# --- a pack outside the chain is entirely dead art --------------------------
check("art written to a pack outside the chain is all shadowed",
      packs.shadows("city", {KEY}).get(KEY) == packs.default_pack())

# --- the default must be READ from theme.ts, never copied -------------------
check("default pack is read from theme.ts and matches the app",
      packs.default_pack() == "swampspace-hires")
check("chain is highest-priority first, base last",
      packs.chain()[-1] == packs.BASE_PACK and len(packs.chain()) == 2)

print()
print(f"{RAN} checks, {len(FAILS)} failed")
if FAILS:
    print("FAILURES: " + ", ".join(FAILS))
    sys.exit(len(FAILS))
print("all checks passed")
sys.exit(0)
