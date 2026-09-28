# Sprite sheet from one character image

`scripts/assets/spritesheet.py` takes any character image and returns a pixel
sprite sheet: 5 directions × idle + step at 48 px by default, which is the
pack's character contract (§3 of `sprite-generation.md`). It drives your local
ComfyUI. The same graph ships as flows you can import and edit.

```bash
pnpm run sprite:sheet -- hero.png                       # qwen, s se e ne n × idle step, 48 px
python3 scripts/assets/spritesheet.py doctor            # run this first: what's installed, what it'll use
python3 scripts/assets/spritesheet.py hero.png --frames walk --seeds 1004 1005 1006
python3 scripts/assets/spritesheet.py hero.png --method grid                 # one pass, ~15 s preview
python3 scripts/assets/spritesheet.py hero.png --method sdxl --describe "a frog settler in a green cloak"
python3 scripts/assets/spritesheet.py repack sprite-sheets/hero/s1004 --size 32 --palette swampspace
```

Needs `pip install pillow numpy` and ComfyUI at `http://127.0.0.1:8188`
(`COMFY=http://host:port` to override).

## What you get

`./sprite-sheets/<name>/s<seed>/` (`--out` to change):

| File | What |
|---|---|
| `sheet.png` | rows = directions, columns = poses, transparent |
| `sheet@4x.png` | nearest-neighbour ×4 on a dark floor, for looking at |
| `preview.png` | every raw with its pixel frame under it. Judge from this file |
| `anim-<dir>.gif` | the walk frames per direction (all poses when there's no walk) |
| `frames/<kind>-<dir>-<pose>.png` | the pack's `chars/` naming, ready to copy into a theme |
| `sheet.json` | every frame rect, seed, models, palette mode |
| `raw/` | the 1024 px ComfyUI outputs; `repack` rebuilds everything from these |
| `flow_api.json`, `flow.json` | the exact graph that ran, API and editor format |

## Methods

**`qwen` (default).** This is cyber-puck's Qwen-Image-Edit recipe (fp8 +
Lightning 4-step, CFG 1, shift 3.1, `index_timestep_zero`, about 15 s a frame
on the 4090). Each direction's idle is one edit of your image. Every other pose
is an edit of that direction's idle, with your image as image 2 for identity.
In cyber-puck's prototype (`docs/comfyui-pixel-art.md` there, 2026-09-13),
per-frame edits of an on-model frame kept sides and identity 8/8. A whole sheet
in one pass gave random poses. The model is auto-detected: an `Edit-2` release
is preferred over 2511, and 2511 over 2509. The Lightning LoRA is matched to
the model's version. If no matching LoRA is found, the tool falls back to 20
steps at CFG 2.5. `--unet`, `--lightning none` and the other model flags
override the detection. `--angles` adds the Multiple-Angles LoRA. On Puck it
turned a robot leg into a cannon 8/8, so it is off by default.

**`grid`.** One Qwen pass draws the whole turnaround in one image, and the CLI
cuts it into cells. Use it as a fast preview. Identity holds, but spacing and
poses drift.

**`sdxl`.** The pack's proven SDXL base: juggernautXL, the skormino pixel LoRA
and IP-Adapter on your image, with per-direction weights from §4.5. Pose frames
are img2img from the idle at denoise 0.38 (§4.6). The output is more
pixel-native, but identity is weaker, so pass `--describe`.

`--frames`: `basic` (idle, step), `walk` (idle + 4 walk phases), `all`, or a
list from `idle step walk1 walk2 walk3 walk4 attack hurt`. `--dirs` accepts any
of `s se e ne n sw w nw`. The pack draws only the first five, because the engine
mirrors the west half.

## The post (no GPU)

1. **Key.** A border-connected flood of the backdrop colour. A plain colour key
   would also punch holes in pale interiors, such as cream fur or a white chest.
2. **One scale for the whole sheet**, so the character keeps the same size
   between frames. Each pose is registered to its direction's idle centre, so
   a stride moves the legs and not the body. Feet sit on the pack's foot row
   (`canvas-2`, the same as `post.sprite`).
3. k-centroid downscale (`post.kcentroid`), then a palette snap and hard alpha.
   `--palette input` (the default) uses the character's own colours
   (median-cut, `--colors 24`). `swampspace` uses the pack's locked 34 colours,
   and `none` leaves the colours as they are.

## Facing

Drawn side art must face **right**. Models don't reliably obey that. Check `e`,
`se` and `ne` in `preview.png`. If a seed came back facing left, re-run it with
`--mirror e,ne` (the raws are cached in ComfyUI, so this is quick), or run
`repack` after mirroring the raws yourself.

## The flows

`scripts/assets/flows/`, each file in two formats:

| Flow | Import this (editor) | Queue this (API) |
|---|---|---|
| Qwen, 5 dirs × idle + step | `sprite-sheet-qwen.json` | `sprite-sheet-qwen_api.json` |
| SDXL, 5 dirs × idle + step | `sprite-sheet-sdxl.json` | `sprite-sheet-sdxl_api.json` |
| Qwen one-pass turnaround | `sprite-sheet-grid.json` | `sprite-sheet-grid_api.json` |

Drag the editor file into ComfyUI. Load your character into the node titled
**character**, then queue. The input must be square and on white: a transparent
PNG loads with a black background. `spritesheet.py prep hero.png` writes a
suitable input. Each direction sits in its own group. The stitched raw sheet
comes out of "sheet preview (raw)".

To get a tweaked flow through the pixel post, use Workflow → Export (API),
then run:

```bash
python3 scripts/assets/spritesheet.py hero.png --flow my-tweaked_api.json
```

The CLI feeds your image into the `character` LoadImage node. It finds frames
by the SaveImage titles `frame <dir> <pose>`, so keep those titles; anything
else can change. The flow's own seeds are kept unless you pass `--seeds`. For
a different frame set, run `spritesheet.py flows --frames walk --dirs e` to
write a flow for it.

`flows` builds the editor files from the live server's `/object_info` when it
can reach one, so the widget order is exact for that server. Otherwise it uses
the table in `comfy_ui.py`. A node that is in neither is an error, not a guess.

## Tests

`python3 scripts/assets/spritesheet_selftest.py` runs 73 checks against a fake
ComfyUI in about 90 s, with no GPU. It checks graph validity, editor-format
link integrity, model detection, keying, scale and foot registration, palette,
mirroring, repack, `--flow` and the committed flows. The exit code is the
number of failures.
