"""Generate the lore weapons in ComfyUI (127.0.0.1:8188). Structure comes from the
design sketches (sketches.py) as a ControlNet input only; the art is generated.

  python3 gen.py profile WEAPON --seeds 1,2,3,4 [--cn 0.6] [--lora 0]
  python3 gen.py qwen SRC.png OUTPREFIX "edit prompt" --seeds 1,2
  python3 gen.py inpaint SRC.png MASK.png OUTPREFIX "prompt" --seeds 1,2 --denoise 0.6
"""
import argparse, json, os, sys
sys.path.insert(0, '/home/hypnodroid/Worktrees/sporefall-station/lore-weapons-1106/scripts/assets')
import comfy
from PIL import Image, ImageFilter, ImageOps
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sketches import sketch, WEAPONS
OUT = '/mnt/d/tmp/cast-walks/weapons/lore/gen'
CKPT = 'SDXL1.0\\juggernautXL_juggXIByRundiffusion.safetensors'
NEG = ('steampunk, gears, cogs, clockwork, victorian, ornate, filigree, brass, gold, polished copper, decorative engraving, '
       'person, hand, fingers, text, watermark, signature, multiple objects, scenery, background, drop shadow, cast shadow, floor, reflection, '
       'firearm, rifle, revolver, magazine, trigger guard, scope, blurry, lowres')
STYLE = ('side view, a single object centered and isolated on a plain flat white background, detailed painted 2D video game item art, '
         'bold dark outlines, chunky readable shapes, gritty weathered salvaged swamp-colony equipment, chipped paint, hex bolts, rust streaks, '
         'worn scratched dark gunmetal steel with darker shading, worn black rubber, faded canvas tape, muted industrial colours, the glowing liquid is the only bright colour')
DESC = {
    'rivetDriver': 'a heavy salvaged pneumatic rivet driver used as a sidearm: a chunky boxy worn grey steel receiver, a thick reinforced steel barrel with clamp bands and a heavy muzzle collar pointing right, a rounded compressed-air cylinder slung under the barrel, a rubber pistol grip wrapped in canvas tape, one small glowing green charge vial set into the side of the receiver, scuffed industrial tool, heavy and solid',
    'pressureLance': 'a long heavy salvaged pneumatic ram pole: grey steel pipe shaft, canvas-wrapped grip at the left end, a small glowing teal charge vial clamped mid-shaft, at the right end a big heavy steel piston cylinder and a thick blunt steel piston head',
    'siphonSpike': 'a short hand-held sampling probe: rubber taped grip on the left, a clear glass tube barrel holding glowing teal liquid and bubbles, a long thin steel needle tip pointing right',
    'cageRam': 'a heavy two-handed pole: long grey steel shaft with canvas grip wrap on the left, at the right end a big heavy wire cage holding a glowing yellow glass bulb, thick steel end plates',
    'scatterFunnel': 'a heavy two-handed salvaged pneumatic scatter cannon: a thick grey steel body, a wide flared steel funnel bore at the right end, a canvas-wrapped shoulder stock on the left, a compressed-air tank slung underneath, one small glowing teal charge vial on the side, rubber grip',
    'coilRepeater': 'a heavy two-handed salvaged rapid-fire rivet repeater: a dark grey steel receiver, a long thick barrel pointing right wrapped along its whole length in very visible thick copper wire coil, a few coil turns glowing hot teal, no scope, a straight steel box magazine of rivets underneath, a canvas-wrapped shoulder stock on the left, rubber pistol grip, industrial and punchy',
    'phosphorHose': 'a hand-held spray wand: a long thin grey steel wand pointing right with a small nozzle tip glowing orange, a small glass jar of glowing orange liquid on top, a thick black rubber hose curling down from the back, rubber grip',
    'frostCondenser': 'a hand-held salvaged essence tool: grey steel valve block with rubber grip, a glass jar of pale icy cyan glowing liquid on top, a short nozzle pointing right surrounded by a stack of thin pale cooling fins, rime frost',
    'lullDarter': 'a slim hand-held tube launcher: a long thin grey steel tube pointing right ending in a small needle dart tip, a small glass vial of glowing violet liquid on top, rubber grip',
    'sparkCoil': 'a hand-held salvaged essence tool: grey steel body with rubber grip, a glass jar of glowing yellow liquid on top, two steel prongs forking forward to the right with copper wire coil between them, small yellow electric sparks',
}
W, H = 1216, 640

def control_image(wid):
    sk = sketch(wid, w=280, h=130, bg=(255, 255, 255, 255))
    sk = sk.convert('RGB')
    s = min((W - 80) / sk.width, (H - 80) / sk.height)
    sk = sk.resize((int(sk.width * s), int(sk.height * s)), Image.LANCZOS)
    canvas = Image.new('RGB', (W, H), (255, 255, 255)); canvas.paste(sk, ((W - sk.width) // 2, (H - sk.height) // 2))
    edges = canvas.convert('L').filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 40 else 0)
    os.makedirs(f'{OUT}/{wid}', exist_ok=True)
    p = f'{OUT}/{wid}/control.png'; edges.convert('RGB').save(p); canvas.save(f'{OUT}/{wid}/control-src.png')
    return p

def profile_graph(wid, seed, cn, lora):
    ctrl = comfy.upload(control_image(wid))
    g = {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': CKPT}},
        '2': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': DESC[wid] + ', ' + STYLE}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': NEG}},
        '4': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': 'xinsir-controlnet-union-sdxl-1.0-promax.safetensors'}},
        '5': {'class_type': 'SetUnionControlNetType', 'inputs': {'control_net': ['4', 0], 'type': 'canny/lineart/anime_lineart/mlsd'}},
        '6': {'class_type': 'LoadImage', 'inputs': {'image': ctrl}},
        '7': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {'positive': ['2', 0], 'negative': ['3', 0], 'control_net': ['5', 0], 'image': ['6', 0], 'strength': cn, 'start_percent': 0.0, 'end_percent': 0.75, 'vae': ['1', 2]}},
        '8': {'class_type': 'EmptyLatentImage', 'inputs': {'width': W, 'height': H, 'batch_size': 1}},
        '9': {'class_type': 'KSampler', 'inputs': {'model': ['1', 0], 'positive': ['7', 0], 'negative': ['7', 1], 'latent_image': ['8', 0], 'seed': seed, 'steps': 30, 'cfg': 5.0, 'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': 1.0}},
        '10': {'class_type': 'VAEDecode', 'inputs': {'samples': ['9', 0], 'vae': ['1', 2]}},
        '11': {'class_type': 'SaveImage', 'inputs': {'images': ['10', 0], 'filename_prefix': f'lore-weapons/{wid}-s{seed}'}},
    }
    if lora:
        g['12'] = {'class_type': 'LoraLoader', 'inputs': {'model': ['1', 0], 'clip': ['1', 1], 'lora_name': comfy.LORA, 'strength_model': lora, 'strength_clip': lora}}
        g['2']['inputs']['clip'] = ['12', 1]; g['3']['inputs']['clip'] = ['12', 1]; g['9']['inputs']['model'] = ['12', 0]
    return g

def qwen_graph(src, prompt, seed, w=1024, h=1024):
    name = comfy.upload(src)
    return {
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'qwen_image_edit_2511_fp8_e4m3fn.safetensors', 'weight_dtype': 'default'}},
        '2': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', 'strength_model': 1.0}},
        '3': {'class_type': 'ModelSamplingAuraFlow', 'inputs': {'model': ['2', 0], 'shift': 3.1}},
        '4': {'class_type': 'CFGNorm', 'inputs': {'model': ['3', 0], 'strength': 1.0}},
        '5': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'type': 'qwen_image', 'device': 'default'}},
        '6': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'qwen_image_vae.safetensors'}},
        '7': {'class_type': 'LoadImage', 'inputs': {'image': name}},
        '8': {'class_type': 'TextEncodeQwenImageEditPlus', 'inputs': {'clip': ['5', 0], 'vae': ['6', 0], 'image1': ['7', 0], 'prompt': ''}},
        '9': {'class_type': 'FluxKontextMultiReferenceLatentMethod', 'inputs': {'conditioning': ['8', 0], 'reference_latents_method': 'index_timestep_zero'}},
        '10': {'class_type': 'EmptySD3LatentImage', 'inputs': {'width': w, 'height': h, 'batch_size': 1}},
        '11': {'class_type': 'TextEncodeQwenImageEditPlus', 'inputs': {'clip': ['5', 0], 'vae': ['6', 0], 'image1': ['7', 0], 'prompt': prompt}},
        '12': {'class_type': 'FluxKontextMultiReferenceLatentMethod', 'inputs': {'conditioning': ['11', 0], 'reference_latents_method': 'index_timestep_zero'}},
        '13': {'class_type': 'KSampler', 'inputs': {'model': ['4', 0], 'positive': ['12', 0], 'negative': ['9', 0], 'latent_image': ['10', 0], 'seed': seed, 'steps': 4, 'cfg': 1.0, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1.0}},
        '14': {'class_type': 'VAEDecode', 'inputs': {'samples': ['13', 0], 'vae': ['6', 0]}},
        '15': {'class_type': 'SaveImage', 'inputs': {'images': ['14', 0], 'filename_prefix': 'lore-weapons/qwen'}},
    }

def inpaint_graph(src, mask, prompt, seed, denoise):
    a, m = comfy.upload(src), comfy.upload(mask)
    return {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'SDXL1.0\\juggernautXL_versionXInpaint.safetensors'}},
        '2': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': prompt + ', ' + STYLE}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': NEG}},
        '4': {'class_type': 'LoadImage', 'inputs': {'image': a}},
        '5': {'class_type': 'LoadImage', 'inputs': {'image': m}},
        '6': {'class_type': 'ImageToMask', 'inputs': {'image': ['5', 0], 'channel': 'red'}},
        '7': {'class_type': 'InpaintModelConditioning', 'inputs': {'positive': ['2', 0], 'negative': ['3', 0], 'vae': ['1', 2], 'pixels': ['4', 0], 'mask': ['6', 0], 'noise_mask': True}},
        '8': {'class_type': 'KSampler', 'inputs': {'model': ['1', 0], 'positive': ['7', 0], 'negative': ['7', 1], 'latent_image': ['7', 2], 'seed': seed, 'steps': 28, 'cfg': 5.0, 'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': denoise}},
        '9': {'class_type': 'VAEDecode', 'inputs': {'samples': ['8', 0], 'vae': ['1', 2]}},
        '10': {'class_type': 'SaveImage', 'inputs': {'images': ['9', 0], 'filename_prefix': 'lore-weapons/inpaint'}},
    }

def fx_graph(prompt, seed, w=1024, h=1024):
    return {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': CKPT}},
        '2': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': prompt + ', isolated on a pure black background, 2D video game visual effect sprite, bold shapes, no object, no gun'}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'clip': ['1', 1], 'text': 'gun, weapon, hand, person, text, watermark, frame, border, scenery, ground, smoke background, photo'}},
        '8': {'class_type': 'EmptyLatentImage', 'inputs': {'width': w, 'height': h, 'batch_size': 1}},
        '9': {'class_type': 'KSampler', 'inputs': {'model': ['1', 0], 'positive': ['2', 0], 'negative': ['3', 0], 'latent_image': ['8', 0], 'seed': seed, 'steps': 28, 'cfg': 5.5, 'sampler_name': 'dpmpp_2m', 'scheduler': 'karras', 'denoise': 1.0}},
        '10': {'class_type': 'VAEDecode', 'inputs': {'samples': ['9', 0], 'vae': ['1', 2]}},
        '11': {'class_type': 'SaveImage', 'inputs': {'images': ['10', 0], 'filename_prefix': 'lore-weapons/fx'}},
    }

def rembg(src, dst):
    name = comfy.upload(src)
    g = {'1': {'class_type': 'LoadImage', 'inputs': {'image': name}},
         '2': {'class_type': 'Image Remove Background (rembg)', 'inputs': {'image': ['1', 0]}},
         '3': {'class_type': 'SaveImage', 'inputs': {'images': ['2', 0], 'filename_prefix': 'lore-weapons/rembg'}}}
    p = comfy.run(g, os.path.dirname(dst) + '/raw')[0]
    os.replace(p, dst); return dst

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('mode'); ap.add_argument('args', nargs='*')
    ap.add_argument('--seeds', default='1,2,3,4'); ap.add_argument('--cn', type=float, default=0.6)
    ap.add_argument('--lora', type=float, default=0.0); ap.add_argument('--denoise', type=float, default=0.6)
    ap.add_argument('--size', default='1024x1024')
    a = ap.parse_args(); seeds = [int(s) for s in a.seeds.split(',')]
    for seed in seeds:
        if a.mode == 'profile':
            wid = a.args[0]; tag = f'cn{a.cn}-l{a.lora}'
            paths = comfy.run(profile_graph(wid, seed, a.cn, a.lora), f'{OUT}/{wid}/raw')
            for p in paths:
                dst = f'{OUT}/{wid}/{wid}-{tag}-s{seed}.png'; os.replace(p, dst); print(dst, flush=True)
        elif a.mode == 'qwen':
            src, prefix, prompt = a.args; w, h = map(int, a.size.split('x'))
            for p in comfy.run(qwen_graph(src, prompt, seed, w, h), os.path.dirname(prefix) + '/raw'):
                dst = f'{prefix}-s{seed}.png'; os.replace(p, dst); print(dst, flush=True)
        elif a.mode == 'fx':
            prefix, prompt = a.args
            for p in comfy.run(fx_graph(prompt, seed), os.path.dirname(prefix) + '/raw'):
                dst = f'{prefix}-s{seed}.png'; os.replace(p, dst); print(dst, flush=True)
        elif a.mode == 'rembg':
            print(rembg(a.args[0], a.args[1])); break
        elif a.mode == 'inpaint':
            src, mask, prefix, prompt = a.args
            for p in comfy.run(inpaint_graph(src, mask, prompt, seed, a.denoise), os.path.dirname(prefix) + '/raw'):
                dst = f'{prefix}-s{seed}.png'; os.replace(p, dst); print(dst, flush=True)

if __name__ == '__main__':
    main()
