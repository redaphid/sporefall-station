"""CPU tests for the cast pipeline: `python3 scripts/assets/cast/cast.py selftest`.

No GPU, no Ollama, no pytest (WSL python3 does not have it). Each test_* function
raises on failure. The engine-pin test needs the engine checkout, and is skipped
without it.
"""
import contextlib
import io
import json
import os
import tempfile
import traceback

import numpy as np
from PIL import Image, PngImagePlugin

import cast
import pack


def _png(arr, text=None):
    info = None
    if text:
        info = PngImagePlugin.PngInfo()
        info.add_text("prompt", text)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG", pnginfo=info)
    return buf.getvalue()


def committed_chars():
    return sorted(d for d in os.listdir(cast.HERE)
                  if os.path.exists(os.path.join(cast.HERE, d, "recipe.json")))


# ------------------------------------------------------------------ recipes
def test_committed_recipes_are_complete_and_consistent():
    chars = committed_chars()
    assert chars, "no committed character recipe"
    for c in chars:
        r = cast.load(c)
        assert r["engine"]["commit"] and len(r["engine"]["commit"]) == 40, c
        for d in cast.DIRS:
            kd, wd, cd = r["keyframes"]["dirs"][d], r["walk"]["dirs"][d], r["cut"]["dirs"][d]
            for text in (kd["prompt"], wd["prompt"]):
                assert "TODO" not in text, f"{c}/{d}: TODO prompt committed"
            kf = os.path.join(cast.char_dir(c), "keyframes", f"{d}.png")
            assert cast.sha_file(kf) == kd["sha256"], f"{c}/{d}: keyframe differs from the recipe"
            prov = cast.read_json(kf[:-4] + ".json")
            assert prov["seed"] == kd["seed"] and prov["png_sha256"] == kd["sha256"], f"{c}/{d}: provenance"
            assert prov["graph"]["170:169"]["inputs"]["seed"] == kd["seed"], f"{c}/{d}: graph seed"
            assert Image.open(kf).size == (1280, 720), f"{c}/{d}: keyframe is not 1280x720"
            atlas = os.path.join(cast.char_dir(c), "atlas", f"{d}.png")
            rep = cast.read_json(atlas[:-4] + ".json")
            assert cast.sha_file(atlas) == rep["png_sha256"], f"{c}/{d}: atlas row differs from its report"
            assert rep["clip"]["frames_sha256"] == wd["frames_sha256"], f"{c}/{d}: clip digest"
            assert wd["frames"] == cast.FRAMES, f"{c}/{d}: frame count"
            assert cd["loop"]["period"] == rep["loop"]["period"], f"{c}/{d}: loop"
            assert Image.open(atlas).size[0] % 8 == 0, f"{c}/{d}: row is not 8 cells"


def test_export_reproduces_what_is_shipped():
    """The committed rows regenerate every shipped frame, and the manifests need nothing."""
    for c in committed_chars():
        r = cast.load(c)
        files, _ = pack.pack_files(r, os.path.join(cast.char_dir(c), "atlas"), cast.DIRS)
        for pk, (same, diff) in cast.compare_packs(files).items():
            assert not diff, f"{c}: {pk} differs: {diff[:4]}"
            assert same == 50, f"{c}: {pk} has {same} files"
            text, changes = pack.manifest_update(pk, c, set(files[pk]))
            assert text is None and not changes, f"{c}: {pk} manifest would change: {changes[:4]}"


# ------------------------------------------------------------------ manifest merge
def test_merge_is_a_noop_when_everything_is_present():
    sprites = {"tile.a": ["x"], "char.a.s-idle": "chars/k-s-idle.png", "char.a.s-walk-0": "chars/k-s-walk-0.png"}
    want = {k: v for k, v in sprites.items() if k.startswith("char.")}
    out, changes = pack.merge_keys(sprites, want, ("char.a.",), lambda rel: True)
    assert not changes and list(out.items()) == list(sprites.items())


def test_merge_inserts_after_predecessor_updates_in_place_and_drops_only_dead_keys():
    sprites = {"char.a.s-idle": "chars/old.png", "char.a.s-step": "chars/k-s-step.png",
               "char.a.se-idle": "chars/k-se-idle.png", "char.a.s-walk-9": "chars/gone.png",
               "char.a.s-attack-0": "chars/k-s-attack-0.png", "other": "x"}
    want = {"char.a.s-idle": "chars/k-s-idle.png", "char.a.s-step": "chars/k-s-step.png",
            "char.a.s-walk-0": "chars/k-s-walk-0.png", "char.a.se-idle": "chars/k-se-idle.png"}
    out, changes = pack.merge_keys(sprites, want, ("char.a.",), lambda rel: rel != "chars/gone.png")
    assert list(out) == ["char.a.s-idle", "char.a.s-step", "char.a.s-walk-0", "char.a.se-idle",
                         "char.a.s-attack-0", "other"], list(out)
    assert out["char.a.s-idle"] == "chars/k-s-idle.png"
    assert "char.a.s-walk-9" not in out, "a key whose file is gone must go"
    assert "char.a.s-attack-0" in out, "a key the rule does not know, with a live file, must stay"
    assert len(changes) == 3, changes


def test_merge_of_a_brand_new_archetype_appends_after_its_family_or_at_the_end():
    out, _ = pack.merge_keys({"x": 1, "char.b.s-idle": "p", "y": 2}, {"char.b.n-idle": "q"},
                             ("char.b.",), lambda rel: True)
    assert list(out) == ["x", "char.b.s-idle", "char.b.n-idle", "y"]
    out, _ = pack.merge_keys({"x": 1}, {"char.z.s-idle": "q"}, ("char.z.",), lambda rel: True)
    assert list(out) == ["x", "char.z.s-idle"]


def test_manifest_update_restores_a_deleted_key_to_the_exact_shipped_bytes():
    c = committed_chars()[0]
    r = cast.load(c)
    arch = pack.archetypes(c)[0]
    with tempfile.TemporaryDirectory() as tmp:
        saved = pack.THEMES
        try:
            for spec in r["export"]["packs"]:
                pk = spec["pack"]
                src = os.path.join(saved, pk)
                os.makedirs(os.path.join(tmp, pk))
                os.symlink(os.path.join(src, "chars"), os.path.join(tmp, pk, "chars"))
                text = open(os.path.join(src, "manifest.json"), encoding="utf-8").read()
                m = json.loads(text)
                del m["sprites"][f"char.{arch}.ne-walk-3"]
                m["sprites"][f"char.{arch}.e-idle"] = "chars/wrong.png"
                open(os.path.join(tmp, pk, "manifest.json"), "w").write(pack.dump_like(text, m))
                pack.THEMES = tmp
                new, changes = pack.manifest_update(pk, c, set())
                pack.THEMES = saved
                assert new == text, f"{pk}: restored manifest is not byte-identical"
                assert len(changes) == 2, changes
        finally:
            pack.THEMES = saved


def test_dump_like_keeps_each_manifest_format_and_refuses_unknown_ones():
    for pk in ("swampspace", "swampspace-hires"):
        text = open(os.path.join(pack.THEMES, pk, "manifest.json"), encoding="utf-8").read()
        assert pack.dump_like(text, json.loads(text)) == text, pk
    try:
        pack.dump_like('{"a":1,  "b":2}', {"a": 1})
    except SystemExit:
        return
    raise AssertionError("an unrecognised format was rewritten")


# ------------------------------------------------------------------ export maths
def test_row_frames_share_one_bbox_sit_on_the_floor_and_inpaint_backdrop_white():
    cell = np.zeros((40, 20, 4), np.uint8)
    atlas = np.concatenate([cell] * 8, axis=1)
    for i in range(8):
        y0 = 10 if i != 3 else 6              # frame 3 hops: the row bbox must still hold
        atlas[y0:y0 + 24, i * 20 + 6:i * 20 + 14] = (60, 120, 40, 255)
    atlas[20, 9] = (250, 249, 248, 255)       # a backdrop speck inside frame 0
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "row.png")
        Image.fromarray(atlas).save(p)
        frames, killed = pack.row_frames(p, 48, 46, "lanczos")
    assert killed == 1, killed
    assert len(frames) == 8 and all(f.size == (48, 48) for f in frames)
    a = [np.asarray(f) for f in frames]
    bottoms = [np.nonzero(x[..., 3])[0].max() for x in a]
    assert bottoms[0] == 46, bottoms          # canvas - 1 - 1: one row of air under the feet
    assert bottoms[3] < bottoms[0], "the hop was flattened: frames were framed one by one"
    assert not ((a[0][..., :3].min(axis=2) >= 225) & (a[0][..., 3] > 0)).any(), "white speck survived"
    assert set(np.unique(a[0][..., 3])) <= {0, 255}, "alpha is not hard"


# ------------------------------------------------------------------ digests + io
def test_pixel_digest_ignores_png_metadata_but_not_pixels():
    arr = np.full((4, 5, 3), 128, np.uint8)
    with tempfile.TemporaryDirectory() as tmp:
        for name, blob in (("a", _png(arr, "prefix 170317")), ("b", _png(arr, "prefix 175424"))):
            os.makedirs(os.path.join(tmp, name))
            open(os.path.join(tmp, name, "0000.png"), "wb").write(blob)
        assert open(os.path.join(tmp, "a", "0000.png"), "rb").read() != open(
            os.path.join(tmp, "b", "0000.png"), "rb").read()
        assert cast.frames_digest(os.path.join(tmp, "a")) == cast.frames_digest(os.path.join(tmp, "b"))
        arr[0, 0, 0] = 129
        open(os.path.join(tmp, "b", "0000.png"), "wb").write(_png(arr))
        assert cast.frames_digest(os.path.join(tmp, "a")) != cast.frames_digest(os.path.join(tmp, "b"))


def test_write_bytes_is_atomic_and_leaves_identical_files_alone():
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "sub", "f.bin")
        assert cast.write_bytes(p, b"one") is True
        os.utime(p, (1, 1))
        assert cast.write_bytes(p, b"one") is False and os.stat(p).st_mtime == 1
        assert cast.write_bytes(p, b"two") is True and open(p, "rb").read() == b"two"
        assert os.listdir(os.path.dirname(p)) == ["f.bin"], "a .partial file was left behind"


def test_resume_keys_recognise_only_identical_inputs():
    with tempfile.TemporaryDirectory() as tmp:
        k = cast.key_of({"frames": "abc", "args": ["--min-period", "30"]})
        assert not cast.fresh(tmp, k)
        cast.mark(tmp, k)
        assert cast.fresh(tmp, k)
        assert not cast.fresh(tmp, cast.key_of({"frames": "abc", "args": ["--min-period", "40"]}))


def test_picture_references_parse():
    assert cast.parse_ref("anchor") == "anchor" and cast.parse_ref("n") == "n"
    assert cast.parse_ref("file:/mnt/d/x.png") == {"file": "/mnt/d/x.png"}
    assert cast.parse_ref(f"file:{cast.REPO}/scripts/assets/anchors/a.png") == {
        "file": "scripts/assets/anchors/a.png"}
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            cast.parse_ref("west")
    except SystemExit:
        return
    raise AssertionError("an unknown reference was accepted")


# ------------------------------------------------------------------ the engine pin
def test_engine_pin_refuses_the_wrong_commit():
    if not os.path.isdir(os.path.join(cast.ENGINE, ".git")):
        print("    (skipped: no engine checkout)")
        return
    r = cast.load(committed_chars()[0])
    r["engine"] = dict(r["engine"], commit="0" * 40)
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            cast.engine_ready(r)
    except SystemExit:
        return
    raise AssertionError("engine_ready accepted a commit the engine is not at")


def main():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except BaseException as e:  # noqa: BLE001 - SystemExit from die() is a failure here too
            failed += 1
            print(f"FAIL {name}: {e!r}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0
