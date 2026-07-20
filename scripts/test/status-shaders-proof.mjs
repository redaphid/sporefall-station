// Visual proof harness for the status-effect shaders (src/render/statusShaders.ts).
// It renders the EXACT `FRAGMENT` GLSL from that file in a headless WebGL canvas
// — no re-implementation — driving the per-quad uniforms directly, so the stills
// are the genuine shader output. Grid: rows = effects (lightning/fire/frost/
// poison/wet), columns = intensity levels the uniform layer produces at 0 / 1 / 3
// driving-mod stacks. This demonstrates the marquee ask: the SAME effect at low
// vs high mod-stack, driven purely by the intensity float + the mod's hue.
//
// Output: docs/assets/status-shaders/{grid.png, lightning-low-vs-high.png} and
// an animated GIF (all effects crackling over sim time) via ffmpeg.
//
// Run: node scripts/test/status-shaders-proof.mjs

import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(root, 'docs', 'assets', 'status-shaders')
mkdirSync(outDir, { recursive: true })

// --- Extract the real FRAGMENT source (single source of truth). ---
const src = readFileSync(join(root, 'src', 'render', 'statusShaders.ts'), 'utf8')
const m = src.match(/const FRAGMENT = \/\* glsl \*\/ `([\s\S]*?)`/)
if (!m) throw new Error('could not extract FRAGMENT from statusShaders.ts')
const FRAGMENT = m[1]

// statusIntensity(0/1/3) from statusUniforms.ts (base 0.5, saturating gain 0.6).
const saturating = (sum) => 1 - 1 / (1 + Math.max(0, sum))
const intensity = (stacks) => 0.5 + 0.5 * saturating(stacks * 0.6)
const LEVELS = [0, 1, 3].map((s) => ({ stacks: s, value: intensity(s) }))

// Effect rows: index matches EFFECT in statusUniforms.ts. `hue0` = canonical
// (no mod), `hueMod` = the driving mod's pickup colour (modColors.ts).
const EFFECTS = [
  { name: 'Lightning (electrified)', effect: 0, hue0: 0xbcd8ff, hueMod: 0xffe119, mod: 'shock' },
  { name: 'Fire (burning)', effect: 1, hue0: 0xff6a1a, hueMod: 0xf58231, mod: 'incendiary' },
  { name: 'Frost (frozen)', effect: 2, hue0: 0x9fe0ff, hueMod: 0x42d4f4, mod: 'frost' },
  { name: 'Poison / spore', effect: 3, hue0: 0x8cff5a, hueMod: 0x8cff5a, mod: '—' },
  { name: 'Wet', effect: 4, hue0: 0x5aa8ff, hueMod: 0x5aa8ff, mod: '—' },
]

const rgb = (c) => [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255]

const cells = []
EFFECTS.forEach((e, r) => {
  LEVELS.forEach((lv, c) => {
    cells.push({
      row: r,
      col: c,
      effect: e.effect,
      intensity: lv.value,
      color: c === 0 ? e.hue0 : e.hueMod,
    })
  })
})

const COLS = LEVELS.length
const ROWS = EFFECTS.length
const CW = 300
const CH = 170
const PADL = 210 // room for row labels
const PADT = 46 // room for column headers
const W = PADL + COLS * CW
const H = PADT + ROWS * CH

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0b12;font-family:monospace;color:#dfe6f2}
  #wrap{position:relative;width:${W}px;height:${H}px}
  canvas{position:absolute;left:${PADL}px;top:${PADT}px}
  .lbl{position:absolute;font-size:13px;line-height:1.2}
  .row{left:8px;width:${PADL - 16}px;text-align:right;font-weight:bold;color:#eaf0fb}
  .col{top:14px;text-align:center;width:${CW}px;color:#9fb0cc}
  .sub{font-size:11px;color:#7f8ba3}
</style></head><body><div id="wrap">
  <canvas id="c" width="${COLS * CW}" height="${ROWS * CH}"></canvas>
  ${EFFECTS.map((e, r) => `<div class="lbl row" style="top:${PADT + r * CH + CH / 2 - 16}px">${e.name}<br><span class="sub">mod: ${e.mod}</span></div>`).join('')}
  ${LEVELS.map((lv, c) => `<div class="lbl col" style="left:${PADL + c * CW}px">${lv.stacks} mod${lv.stacks === 1 ? '' : 's'}<br><span class="sub">intensity ${lv.value.toFixed(2)}</span></div>`).join('')}
</div>
<script>
const cells = ${JSON.stringify(cells)};
const CW=${CW}, CH=${CH}, COLS=${COLS}, ROWS=${ROWS};
const FRAG = ${JSON.stringify(FRAGMENT)};
const VERT = \`attribute vec2 aPos; attribute vec2 aLocal;
uniform vec3 uColor; uniform vec4 uData;
varying vec2 vLocal; varying vec3 vColor; varying vec4 vData;
void main(){ vLocal=aLocal; vColor=uColor; vData=uData; gl_Position=vec4(aPos,0.0,1.0);}\`;
const cv = document.getElementById('c');
const gl = cv.getContext('webgl', { alpha:false, preserveDrawingBuffer:true, antialias:true });
function sh(type, s){ const o=gl.createShader(type); gl.shaderSource(o,s); gl.compileShader(o);
  if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const quad = new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]);
const posB = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posB); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
const locB = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, locB); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog,'aPos'); const aLocal = gl.getAttribLocation(prog,'aLocal');
const uColor = gl.getUniformLocation(prog,'uColor'); const uData = gl.getUniformLocation(prog,'uData');
const uTime = gl.getUniformLocation(prog,'uTime');
const rgb = (c)=>[((c>>16)&255)/255,((c>>8)&255)/255,(c&255)/255];
window.renderAt = (t) => {
  gl.viewport(0,0,cv.width,cv.height); gl.clearColor(0.043,0.043,0.07,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);
  gl.uniform1f(uTime, t);
  for(const c of cells){
    const x = c.col*CW, y = (ROWS-1-c.row)*CH; // WebGL y is bottom-up
    gl.viewport(x, y, CW, CH); gl.scissor(x, y, CW, CH);
    gl.bindBuffer(gl.ARRAY_BUFFER, posB); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER, locB); gl.enableVertexAttribArray(aLocal); gl.vertexAttribPointer(aLocal,2,gl.FLOAT,false,0,0);
    const col = rgb(c.color); gl.uniform3f(uColor, col[0], col[1], col[2]);
    gl.uniform4f(uData, c.effect, c.intensity, c.intensity, 0.37);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.SCISSOR_TEST);
};
window.renderAt(12.0);
window.__ready = true;
</script></body></html>`

const tmp = mkdtempSync(join(tmpdir(), 'statusfx-'))
const htmlPath = join(tmp, 'proof.html')
writeFileSync(htmlPath, page)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.error('PAGE ERROR:', e.message))
await p.goto('file://' + htmlPath)
await p.waitForFunction('window.__ready === true', { timeout: 15000 })

// --- Still: the full grid at a representative tick. ---
await p.evaluate('window.renderAt(12.0)')
await p.waitForTimeout(60)
await p.screenshot({ path: join(outDir, 'grid.png') })
console.log('wrote grid.png')

// --- Lightning-only low vs high crop (top row of the grid). ---
await p.screenshot({
  path: join(outDir, 'lightning-low-vs-high.png'),
  clip: { x: 0, y: 0, width: W, height: PADT + CH },
})
console.log('wrote lightning-low-vs-high.png')

// --- Animated GIF: advance sim time so lightning crackles + flames lick. ---
const frames = 30
const framesDir = join(tmp, 'frames')
mkdirSync(framesDir)
for (let i = 0; i < frames; i++) {
  const t = 12.0 + i * 0.4 // ~1.2s of sim time (30 ticks/s)
  await p.evaluate(`window.renderAt(${t})`)
  await p.waitForTimeout(16)
  await p.screenshot({ path: join(framesDir, `f${String(i).padStart(3, '0')}.png`) })
}
console.log('captured', frames, 'frames')
await browser.close()

const gifOut = join(outDir, 'status-shaders.gif')
try {
  // Palette-optimised GIF at quarter size — keeps the repo asset small.
  const vf = 'scale=iw/4:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer'
  execFileSync(
    'ffmpeg',
    ['-y', '-framerate', '15', '-i', join(framesDir, 'f%03d.png'), '-vf', vf, gifOut],
    { stdio: 'pipe' },
  )
  console.log('wrote status-shaders.gif')
} catch (e) {
  console.error('ffmpeg gif failed:', e.message)
}
rmSync(tmp, { recursive: true, force: true })
console.log('done →', outDir)
