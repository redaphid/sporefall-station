"""Large generated weapon render -> pack-grid pixel frames, palette-locked.

All geometry is tracked in the LARGE render's coordinates (grip, muzzle) and
mapped through the same crop + scale for every frame of a view, so frames of
one view register to one grip pixel."""
import sys
from collections import deque
import numpy as np
from PIL import Image
sys.path.insert(0, '/home/hypnodroid/Worktrees/sporefall-station/lore-weapons-1106/scripts/assets')
from post import kcentroid, to_palette
OUTLINE = (8, 8, 12, 255)

def key_border(im, tol=34):
    """Flood-fill the near-background region connected to the image border -> transparent.
    Interior light pixels (glass highlights) stay."""
    a = np.asarray(im.convert('RGB')).astype(np.int32)
    h, w = a.shape[:2]
    corners = np.array([a[0, 0], a[0, -1], a[-1, 0], a[-1, -1]])
    bg = np.median(corners, axis=0)
    near = (np.abs(a - bg).sum(-1) < tol * 3) & (a.sum(-1) > 3 * 150)
    seen = np.zeros((h, w), bool)
    q = deque([(y, x) for x in range(w) for y in (0, h - 1)] + [(y, x) for y in range(h) for x in (0, w - 1)])
    while q:
        y, x = q.popleft()
        if seen[y, x] or not near[y, x]:
            continue
        seen[y, x] = True
        if y > 0: q.append((y - 1, x))
        if y < h - 1: q.append((y + 1, x))
        if x > 0: q.append((y, x - 1))
        if x < w - 1: q.append((y, x + 1))
    rgba = np.dstack([a, np.where(seen, 0, 255)]).astype(np.uint8)
    out = Image.fromarray(rgba, 'RGBA')
    # drop specks: keep the largest component only + components touching it within 6px
    return out

def key_grow(im, step=7, min_lum=110):
    """Region-grow the background from the border: move to a neighbour whose colour
    is within `step` of the current pixel (follows soft gradients, vignettes and
    contact shadows) and is not dark. Stops at the object's edge."""
    a = np.asarray(im.convert('RGB')).astype(np.int32)
    h, w = a.shape[:2]
    lum = a.sum(-1) / 3
    seen = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1): q.append((y, x))
    for y in range(h):
        for x in (0, w - 1): q.append((y, x))
    for y, x in list(q): seen[y, x] = True
    while q:
        y, x = q.popleft()
        c = a[y, x]
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and lum[ny, nx] > min_lum and np.abs(a[ny, nx] - c).max() <= step:
                seen[ny, nx] = True; q.append((ny, nx))
    rgba = np.dstack([a, np.where(seen, 0, 255)]).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA')

def largest_blob(im, min_frac=0.02):
    a = np.asarray(im).copy(); al = a[..., 3] > 0
    from scipy import ndimage
    lab, n = ndimage.label(al)
    if n <= 1: return im
    sizes = ndimage.sum(al, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= sizes.max() * min_frac
    a[..., 3] = np.where(keep[lab], a[..., 3], 0)
    return Image.fromarray(a, 'RGBA')

def outline(px):
    a = np.asarray(px).copy(); al = a[..., 3] > 0
    pad = np.pad(al, 1)
    nb = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
    ring = nb & ~al
    a[ring] = OUTLINE
    return Image.fromarray(a, 'RGBA')

def frames_to_pixels(frames, pts, scale):
    """frames: list of large RGBA (same size, registered). pts: dict name->(x,y) large coords.
    Returns list of pixel frames (padded 1px for outline) and pts in pixel coords."""
    boxes = [f.getbbox() for f in frames]
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    # include points
    for (px, py) in pts.values():
        x0, y0, x1, y1 = min(x0, int(px)), min(y0, int(py)), max(x1, int(px) + 1), max(y1, int(py) + 1)
    tw, th = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
    out = []
    for f in frames:
        c = f.crop((x0, y0, x1, y1))
        p = to_palette(kcentroid(c, tw, th))
        canvas = Image.new('RGBA', (tw + 2, th + 2), (0, 0, 0, 0)); canvas.paste(p, (1, 1))
        out.append(outline(canvas))
    sx, sy = tw / (x1 - x0), th / (y1 - y0)
    ppts = {k: [int(min(tw, max(0, (x - x0) * sx))) + 1, int(min(th, max(0, (y - y0) * sy))) + 1] for k, (x, y) in pts.items()}
    return out, ppts

def rotate(im, pts, deg, center):
    """Rotate RGBA im by deg (counter-clockwise, PIL convention) about center, expanding.
    Returns new image and transformed points."""
    import math
    w, h = im.size
    r = im.rotate(deg, resample=Image.BICUBIC, expand=True, center=None)
    # PIL rotates about image centre; map points accordingly
    cx, cy = w / 2, h / 2; ncx, ncy = r.width / 2, r.height / 2
    t = math.radians(deg)
    out = {}
    for k, (x, y) in pts.items():
        dx, dy = x - cx, y - cy
        out[k] = (ncx + dx * math.cos(t) + dy * math.sin(t), ncy - dx * math.sin(t) + dy * math.cos(t))
    return r, out

def levels(im, mul=1.0, gamma=1.0):
    a = np.asarray(im).astype(np.float32)
    rgb = np.clip(((a[..., :3] / 255.0) ** gamma) * mul, 0, 1) * 255
    return Image.fromarray(np.dstack([rgb, a[..., 3]]).astype(np.uint8), 'RGBA')

def find_grip_muzzle(px):
    """Grip: the handle hanging below the body; the fist sits on its top. Muzzle:
    the furthest-right opaque pixel row of the top half (profile view)."""
    a = np.asarray(px)[..., 3] > 0
    h, w = a.shape
    rows = [np.where(a[y])[0] for y in range(h)]
    widths = [len(r) for r in rows]
    # walk up from the bottom while the row stays narrow (the handle)
    y = h - 1
    while y > 0 and widths[y] == 0: y -= 1
    hw = max(1, widths[y])
    bottom = y
    while y > 0 and widths[y - 1] <= max(hw + 3, hw * 1.8): y -= 1
    handle_top = y
    gy = min(bottom, handle_top + 1)
    gx = int(np.median(rows[gy])) if len(rows[gy]) else w // 3
    xs = np.where(a.any(0))[0]; mx = xs.max()
    mys = np.where(a[:, mx])[0]
    return [gx, gy], [int(mx), int(np.median(mys))]
