# Animation libraries and pipelines for many-action, 8-way sprite characters

**Question:** is there an existing library, tool or pipeline we could use to give
Sporefall's characters Flashback-style fluid animation (weapon draw, aim, aim-walk,
turn, skid, holster, hurt, death tumbles, fidgets) across all facings?
**Evidence age:** every source was opened on 2026-11-06 unless marked
*(search snippet, not opened)*. This is research, not settled fact. Prices and
maintenance status change, so check them again before you spend money.

Repo context it was judged against: `src/render/animState.ts` (6 states, max 8 frames,
tick-pure), `src/render/motion.ts` (procedural lean/bob/squash layer),
`src/render/weaponPose.ts` (weapon overlay), `docs/art-direction.md` (generated, never
hand-drawn; rigs and mocap only as structure input; display physics is render-only),
`docs/cast-walks/RUNBOOK.md` (Qwen keyframe + Wan video per direction, palette lock).

## Recommendation

No off-the-shelf runtime solves our problem. Skeletal runtimes (Spine and the rest) fix
consistency and the number of actions, but they break the pixel grid and do not suit
generated art. AI sprite services produce sprites at our size, but not in our style or
palette. The best option is a change to the pipeline: the runtime stays a frame player.

1. **3D proxy rig as the structure source for our existing restyle (the Dead Cells
   pipeline with a generative skin).** Build one rigged 3D stand-in per character
   (image-to-3D from the anchor, then auto-rig), drive it with library mocap, and
   render each action for all 5 facings in Blender as pose, depth and flat-ID control
   video for the Wan Fun-Control step we already run. The weapon is a prop
   parented to the hand bone. It appears in every frame with correct occlusion,
   which fixes the overlay problem at its root.
   - **Build first:** mycologist only. TRELLIS.2 (MIT, runs on the 4090) from the
     768 px anchor, then UniRig (MIT) or Mixamo to rig it. Retarget Quaternius UAL
     (CC0, 8-way locomotion and gun animations) plus Mixamo draw/aim clips. Write a
     headless `blender -b -P render_dirs.py` that writes 5 facings x N actions as
     control MP4s, plus per-frame hand and muzzle socket JSON. Feed those to
     `spritesheet.py --method video` in place of the hand-keyed skeletons. Gate with
     `judge-sprite-mp4` at 3-4x zoom.
   - **Cost:** about 3-5 days of scripting plus about 1 GPU-day for the first
     character. Each further action is a retarget plus the same GPU time per
     character we spend today. Hand-keying a skeleton per action and direction goes
     away. **Main risk:** the generative restyle can still drift between facings.
     Palette lock and a flat-colour part-ID pass reduce it but do not remove it.
2. **Socketed paperdoll plus a transition graph plus render-only verlet (engine work,
   no new runtime dependency).** `HAND_RIG` in `weaponPose.ts` has one grip point per
   facing, so the gun stays still while the drawn hand bobs through the walk. This is
   most of why overlays look wrong. Give every frame its own socket metadata (grip x/y,
   weapon angle, in front of or behind the body) and draw the weapon as its own
   generated per-facing layer at that socket. Grow `animState.ts` from a priority
   ladder into a typed transition table: `draw`, `holster`, `turn`, `skid`,
   `aim-enter` and `aim-exit` as one-shot bridges between loops. Add a small verlet
   module for death tumbles and secondary motion (hoses, jars, coat tails).
   - **Build first:** add a `sockets` field to the manifest frame keys, written by
     option 1's Blender script or picked by hand for existing frames. Add a `draw` →
     `aim` → `aimwalk` → `holster` path in the table.
   - **Cost:** about 2-4 days. Mobile cost is near zero: one extra sprite and a few
     dozen verlet points per character.
3. **PixelLab as a bulk and previz generator for secondary cast and new actions.** Its
   "Create 8-directional sprite (Pro)" makes all 8 facings from one reference image,
   up to 168 px per frame. Its animation tools (text, skeleton, interpolate) cover the
   action list, and it has an API, an MCP server and an Aseprite plugin. Its style is
   not ours, so treat its output as structure input: put its frames through Qwen and
   Wan, then palette lock. Ship nothing raw from it.
   - **Build first:** a one-day bake-off. Give it the mycologist 96 px `s-idle`.
     Generate 8 rotations, a walk and a "draw weapon" clip, run palette lock and the
     judge gate, and compare the result side by side with the cast-walk output.
   - **Cost:** Tier 1 subscription or higher (I did not verify the price) plus one
     day. If the bake-off fails, drop it.

Skip for now: Spine, DragonBones, Spriter, Rive, Creature, Live2D as runtimes (reasons in
the table). Spine and PixelOver remain possible offline baking tools if option 1's 3D
route proves too far from the art.

## Comparison

| Option | What it gives | License / cost | pixi v8 | Pixel-art fit at 48-96 px | Mobile cost | Effort |
|---|---|---|---|---|---|---|
| **3D proxy + Blender renders → Wan Fun-Control restyle** | All facings from one rig; any mocap clip; weapon in the hand bone | Blender GPL (tool only); TRELLIS.2 MIT; UniRig MIT; Quaternius UAL CC0; Mixamo free, royalty-free | n/a (bakes to our PNG frames) | Good: output goes through our pixelize + 34-colour lock | None beyond today's frames | Medium (script + per-char setup) |
| Pure 3D render, no restyle (Dead Cells) | Fastest retakes; normal maps for free | as above | n/a | Fair: flicker, less detail (Dead Cells' own drawbacks) | None | Medium |
| **Socketed paperdoll + transition table** | Weapon as a per-frame socketed layer; draw/turn/skid bridges | ours | native | Good (all drawn frames) | ~1 sprite per char | Low |
| **Render-only verlet** | Tumbles, ragdoll flop, secondary motion | ours | native | Good if snapped to whole pixels | Tiny | Low |
| **PixelLab** | 8 facings from 1 image (≤168 px), skeleton/text animation, API/MCP, Aseprite plugin | Subscription, commercial use on all tiers | n/a (PNG) | Good size; style not ours | None | Low to trial |
| Retro Diffusion | Walk/idle/attack cycles, 4-angle walk, 8-dir rotation *(search snippet)* | Pay-per-use, ~$0.07-0.25 per animation *(snippet)* | n/a | Small sizes; style not ours | None | Low to trial |
| Ludo.ai sprite gen | Sprite sheets ≤64 frames, 8 camera angles, "Directional Sprites" from a 3D model, 32-384 px | Credits | n/a (TexturePacker JSON) | Has pixel models | None | Low to trial |
| God Mode AI | ~100 actions incl. 8-dir isometric from one image *(search snippet)* | ~$10/mo *(unverified)* | n/a | Unknown | None | Low to trial |
| Qwen-Image-Edit-2511 Multiple-Angles LoRA | 8 azimuths x 4 elevations re-views of one image | Apache-2.0 | n/a | Keyframes only; pixelize after | None | Low (it's a LoRA in our Comfy) |
| Wan2.2-Animate-14B | Drive the anchor image with a performer video (rotoscope) | Apache-2.0 | n/a | Via our pixelize | None | Medium |
| Spine 4.2/4.3 + `@esotericsoftware/spine-pixi-v8` | Bones, meshes, IK, physics, skins, 2D runtime | Editor $69 Essential (no meshes/IK) / $379 Pro; runtime use needs an active editor license | Yes (official, pixi ≥8.16) | Poor live: rotations leave the grid. OK baked to frames | CPU skinning per char | High (cut parts per facing) |
| DragonBones | Spine-like, free editor | MIT runtime; original vendor abandoned it *(snippet)* | Community port `dragonbones-pixijs` *(snippet)* | Poor live | CPU skinning | High, risky |
| Spriter Pro / Spriter 2 | Cutout bones, points, boxes, events | Spriter 2 still in pre-order | No maintained JS/pixi runtime found | Poor live | n/a | High |
| Rive | Vector state machines, data binding | Free plan exports with splash; Cadet $108/seat/yr | No pixi integration; own WASM canvas | Poor (vector) | Separate canvas | High |
| Creature | Mesh bones, soft body, video mocap | Paid tool; pixi runtime last seen 2017 *(snippet)* | Unknown for v8 | Poor live | Mesh deform | High, stale |
| Live2D Cubism | Deformable 2D face/bust rigs | SDK free for individuals/small businesses | No | Wrong fit (front-facing busts) | Heavy | n/a |
| PixelOver | Pixel-aware bones/IK, 3D import, auto-rotation export | Paid, Early Access (Steam) | n/a (exports sheets) | Built for it | None | Medium (GUI, no CLI documented) |
| Cascadeur | Physics-aided keyframing, AutoPosing, inbetweening; Flashback-style hand-keyed moves | Free (no FBX), Indie $96/yr (<$100k rev), Pro $396/yr | n/a (FBX → Blender) | Feeds option 1 | None | Low per clip |
| Aseprite tags + JSON | Named tags per action; CLI batch export | Paid app; CLI `-b --sheet --data --list-tags --split-layers` | Pixi parses `animations`, ignores `frameTags`: needs a converter | Native | None | Low |
| LPC Universal generator | Layered body+gear, walk/slash/thrust/shoot/cast/hurt (+run/jump/climb partial) | Code GPL-3.0; art CC0/CC-BY(-SA)/OGA-BY/GPL per asset, credits required | n/a | 64 px, 4 facings, generic fantasy look | None | Off-style; idea only |
| XState | Statecharts | MIT, zero deps; v6 in beta | Any | n/a | Small | Low, but not tick-pure out of the box |
| rapier2d | Full 2D physics (WASM) | Apache-2.0 *(not opened)*; JS build cross-platform deterministic | Any | n/a | WASM load + step | Medium; overkill for display |
| planck.js | Box2D in TS | MIT | Any | n/a | Pure JS | Low-Med |
| GSAP | Tweens/timelines | Free incl. all plugins | Any | n/a | Small | Low; wall-clock based |
| Normal-mapped sprites | Per-pixel lighting on sprites | Laigter GPL-3 (tool, has `--no-gui` CLI); `pixijs-light2d` *(snippet)* | Community only for v8 | Mixed: lighting smears the locked palette | Extra texture + shader | Medium |

## Details

### 1. Skeletal and cutout 2D runtimes

**Spine.** The official PixiJS v8 runtime is `@esotericsoftware/spine-pixi-v8`. It needs
PixiJS 8.16 or later, and its major.minor version must match the editor's. It renders on
WebGL, WebGPU and Canvas, and on v8 there is no mesh batch size limit. The older
community `pixi-spine` is unmaintained ([spine-pixi docs](https://esotericsoftware.com/spine-pixi)).
Licensing: the editor costs $69 Essential or $379 Professional. Essential cannot save
meshes or IK. Enterprise is required above $500k revenue. To integrate the runtimes you
need an active editor license
([purchase](https://esotericsoftware.com/spine-purchase)).
*Fit:* Spine solves the action count (one skeleton, unlimited clips) but not facings.
Top-down 8-way means one skeleton or skin per drawn facing, so 5 rigs per character, each
needing its art cut into parts. That is the work generation struggles with most:
consistent separated limbs. Bones rotate and scale sprites off the pixel grid. Forum
advice is to animate on whole numbers, use stepped curves and nearest filtering
*(search snippet; the thread page did not render)*. *Inference:* a workable route is
render-to-texture at 48 or 96 px, then nearest-upscale, or baking to frames offline. In
both cases we pay for Spine and still ship PNG frames, so option 1 does the same job with
free tools.

**DragonBones.** The original vendor abandoned it. A community MIT port
`dragonbones-pixijs` claims v8 support *(search snippet; npm page refused the fetch)*.
Same fit problems as Spine, plus maintenance risk.

**Spriter.** Spriter 2 is "being built from the ground up" and is still in pre-order.
Spriter Pro is sold, but the page lists no maintained JS or pixi runtime
([brashmonkey.com](https://brashmonkey.com/)).

**Rive.** Runtime exports are on the free plan with a splash screen. Cadet removes the
splash at $108/seat/year ([pricing docs](https://rive.app/docs/account-admin/pricing)).
An older 2023 post shows the scheme has changed before
([2023 post](https://rive.app/blog/new-pricing)). The web runtime is MIT and draws WebGL2
on its own (offscreen) canvas, with no PixiJS integration mentioned
([rive-wasm](https://github.com/rive-app/rive-wasm)). It is vector-first and composites
as a separate canvas. Wrong fit.

**Creature and Live2D.** The Creature pixi runtime was last updated around 2017
*(search snippet)*. Live2D rigs front-facing busts. Its SDK is free for individuals and
small businesses ([license](https://www.live2d.com/en/sdk/license/)), but it does not fit
top-down bodies.

**PixelOver** is the one cutout tool built for pixel art. It has bones, IK,
"pixel-art oriented mesh deformation", and 3D model import with automatic rotation
export to sprite sheets ([docs](https://docs.pixelover.io/manual/introduction/)). It is
in Early Access on Steam, and its docs describe no CLI. It is a manual alternative to
option 1's Blender step if we want a GUI.

### 2. Sprite-sheet systems

**Aseprite.** The CLI does batch export (`-b --sheet x.png --data x.json --list-tags
--split-layers --tag NAME --script x.lua`)
([CLI docs](https://www.aseprite.org/docs/cli/)). Checked locally: PixiJS 8.19.0's
`Spritesheet` builds `sheet.animations` only from a top-level `animations` map. It
declares `meta.frameTags` in its types but never reads it. Aseprite JSON therefore needs
a 20-line converter from tags to `animations`. Our own manifest
(`char.<kind>.<dir>-<state>-<n>`) already does what tags would do. Aseprite only matters
if a human edits frames, which the art rules forbid except for structure input.

**LPC Universal Spritesheet Character Generator.** The animations are walk, slash,
thrust, shoot, spellcast and hurt, with run, jump, climb and bow only partly drawn. The
standard frame is 64x64 with oversize frames for weapons. Code is GPL-3.0. Art is CC0,
CC-BY, CC-BY-SA, OGA-BY or GPL per asset, and crediting every non-CC0 author is required
([repo](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator)).
It has 4 facings, a generic fantasy look and share-alike terms, so it is not usable as
art. The idea worth taking: **every gear layer is drawn for every frame and facing of
every animation**, so a weapon is never an overlay. That is option 2.

### 3. 3D-to-sprite pipelines and motion capture

**Dead Cells** (Thomas Vasseur, Motion Twin, 25 Jan 2018). The team modelled and rigged
characters in 3ds Max and keyframed them like 2D, pose to pose. A homebrew tool rendered
each frame very small without antialiasing as PNG plus a normal map, with a basic toon
shader. Characters were about 50 px tall, our 48 px base. Gains: fast retakes, reused
skeletons, gear attached to existing models. Costs: less detail, flickering pixels left
uncleaned
([Game Developer](https://www.gamedeveloper.com/production/art-design-deep-dive-using-a-3d-pipeline-for-2d-animation-in-i-dead-cells-i-)).
This is the proven precedent for 50 px characters with many actions.

**Our variant (option 1).** Our rules allow rigs and mocap as structure input
(`docs/art-direction.md`), so the 3D render is not the art. It is the control signal for
the restyle we already run:

```
anchor (768 px) ─▶ TRELLIS.2 mesh ─▶ UniRig / Mixamo rig ─▶ retarget clips
   (Quaternius UAL, Mixamo, Cascadeur keyed moves, video mocap)
 ─▶ blender -b: 5 facings x action, orthographic, 3/4 top-down camera
     passes: OpenPose skeleton · depth · flat part-ID colours · socket JSON
 ─▶ Qwen-Image-Edit keyframe per facing (+ Multiple-Angles LoRA)
 ─▶ Wan Fun-Control (pose/depth) ─▶ pixelize to 96/48 ─▶ 34-colour lock ─▶ judge gate
```

- **Image-to-3D:** TRELLIS.2: code and weights MIT, textured GLB, needs at least 24 GB
  of VRAM ([repo](https://github.com/microsoft/TRELLIS.2)). The 4090 is right at that
  limit. Hunyuan3D 2.1 is an alternative under the Tencent community license, which
  excludes the EU, UK and Korea *(search snippet)*.
- **Auto-rig:** UniRig is MIT, takes OBJ/FBX/GLB/VRM, outputs a skeleton and skinning
  as a rigged GLB, handles animals as well as humans (useful for hounds), and needs
  8 GB of VRAM ([repo](https://github.com/VAST-AI-Research/UniRig)). Mixamo still works
  in 2026 for humanoids and is royalty-free for commercial use, but Adobe no longer
  develops it ([Cinevva guide, Jul/Sep 2026](https://app.cinevva.com/guides/free-character-animations-rigging)).
- **Clip libraries:** the Quaternius Universal Animation Library is CC0, 120+ clips on a
  retargetable humanoid rig, with 8-direction locomotion, death, combat and gun
  animations. The page lists no draw or holster clips
  ([Quaternius](https://quaternius.com/packs/universalanimationlibrary.html)).
- **Hand-keyed Flashback moves:** Cascadeur offers physics-aided keyframing,
  AutoPosing and inbetweening. FBX export needs Indie ($96/yr, under $100k revenue)
  or Pro ($396/yr) ([plans](https://cascadeur.com/plans)). Of these tools it is the
  best fit for anticipation, snap and settle: a draw, a skid, a stumble.
- **Video mocap (Aaron acts the move):**
  - ComfyUI-MotionCapture wraps GVHMR inside ComfyUI and outputs SMPL and skeletal
    motion. It is GPL-3.0 and marked experimental
    ([repo](https://github.com/PozzettiAndrea/ComfyUI-MotionCapture)). GVHMR's own
    weights are reported as non-commercial research only *(search snippet)*. It is fine
    for previz. Check it before shipping derived motion.
  - Rokoko Vision 3.0 takes video upload only. Its free tier gives 30 s a month with
    FBX export; Basic is $10/month for 600 s, BVH and retargeting
    ([Rokoko](https://www.rokoko.com/products/vision)).
  - FreeMoCap is AGPL-3.0 ([repo](https://github.com/freemocap/freemocap)).
  - I could not read DeepMotion's pricing page.
- **Skip 3D entirely for some moves:** Wan2.2-Animate-14B (Apache-2.0, Sep 2025) drives
  a character image with a performer video
  ([model card](https://huggingface.co/Wan-AI/Wan2.2-Animate-14B)). It is a quick
  rotoscope for one facing. Keeping facings consistent is again the problem.
- **Keyframes per facing:** the fal Qwen-Image-Edit-2511 Multiple-Angles LoRA
  (Apache-2.0) re-renders one image at 8 azimuths and 4 elevations, trained on 3D
  renders ([card](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA)).
  *Inference:* it could replace per-facing keyframe prompting, so test it on the anchor.

### 4. AI sprite tools for directional characters

- **PixelLab.** "Create 8-directional sprite (Pro)" outputs S through SW in a 3x3 grid,
  max 168x168 per frame. A 48 px job costs 10 generations, 86-113 px costs 15, and it
  needs Tier 1
  ([docs](https://www.pixellab.ai/docs/tools/create-8-rotations-pro)). Animation tools:
  animate with text, animate with skeleton, interpolate, edit animation, and automatic
  walk/run/idle/attack "in every direction". It has an MCP server
  (`animate_character`), an API and an Aseprite plugin. Commercial use is allowed on all
  tiers ([llms.txt](https://www.pixellab.ai/llms.txt)). It is the strongest dedicated
  tool at our size.
- **Ludo.ai.** Sheets up to 64 frames and 5 s. "Change View" gives 8 angles, and
  "Directional Sprites" makes up to 8 facings from a 3D model. Pixel styles from 32 to
  384 px; exports TexturePacker JSON
  ([features](https://ludo.ai/features/sprite-generator)).
- **Retro Diffusion** offers four-angle walk cycles, 8-direction rotation, and
  walk/idle/attack from a start frame, through a hosted MCP server, pay-per-use at about
  $0.07-0.25 per animation *(search snippet; site and listing did not render)*.
- **God Mode AI** offers about 100 actions including 8-direction isometric
  *(search snippet only)*.
- **Scenario:** not researched (time).
- **Shared limit (inference):** each tool has its own house style and palette. Aaron's
  bar is lore-specific generated art passing a 3-4x zoom review. Use these tools as
  structure or previz input to our restyle, not as final art.

### 5. Engine-side animation logic in JS

- **State machine.** XState is MIT with zero dependencies, and v6 is in beta
  ([repo](https://github.com/statelyai/xstate)). Its timers and actors run on wall-clock
  time. `animState.ts` has to be a pure function of `(tick, entity)` for replay and
  co-op determinism. *Recommendation:* keep the hand-rolled resolver and make it
  data-driven. Each state gets `{loop|oneshot, tpf, frames, next, interruptibleAfter}`
  plus an `enter` table keyed by `(from, to)` that inserts a bridge clip (`turn`,
  `skid`, `draw`, `holster`).
- **Display physics.** Rapier's JS/WASM build is "fully cross-platform deterministic"
  given the same version and order
  ([rapier docs](https://rapier.rs/docs/user_guides/javascript/determinism)). It is
  overkill here: display physics must not touch the sim, so determinism is not needed.
  planck.js is MIT Box2D in TS ([repo](https://github.com/piqnt/planck.js)). For
  a tumbling sprite, a 3-5 point verlet chain per corpse (head, torso, hips, feet,
  weapon) is about 150 lines. It is cheaper than either engine on Android and lets us
  snap to whole pixels. Use planck only if corpses must collide with walls.
- **Tweens.** GSAP is now free including all plugins
  ([pricing](https://gsap.com/pricing/)), but it runs on wall-clock time.
  `motion.ts` already does squash, lean and bob as pure functions of tick, which is the
  right design.

### 6. Ideas not on the list

- **Per-frame sockets** (option 2). The cause of "overlays look wrong" is that
  `HAND_RIG` has one grip per facing (`weaponPose.ts:39`) while the drawn hand moves
  every frame. Per-frame grip points, with a front or behind flag per facing, fix most
  of it. Option 1's Blender script can emit them for free from the hand bone.
- **Bake the signature weapon, layer the rest.** Generate the character holding its own
  weapon in the frames (correct grip and occlusion). Use the socketed layer only for
  pickups and swaps.
- **Smear frames and holds** (Flashback, Dead Cells VFX): one stretched frame at the
  snap of a draw or swing sells speed at 48 px better than extra inbetweens.
- **Shared transition clips across characters of one body type.** Retargeting in
  option 1 makes `draw`, `turn` and `skid` one clip for all humanoids and one for all
  beasts. Only the restyle is per character.
- **Normal-mapped sprites.** Laigter (GPL-3, `--no-gui` CLI) generates normal maps
  ([repo](https://github.com/azagaya/laigter)). Option 1 gets exact normals free from
  Blender. Pixi v8 has no built-in 2D lights; `pixijs-light2d` claims v8 support
  *(search snippet)*. *Inference:* dynamic light shifts colours off the locked 34, so
  if we try it, use it only for the essence-glow accent.

## Sources that failed to load

retrodiffusion.ai (title only), mcpservers.org Retro Diffusion listing (403),
npmjs.com dragonbones-pixijs (403), deepmotion.com/pricing (no content), the Spine
pixel-art forum thread (no body), mmpose RTMPose page (license not shown).
