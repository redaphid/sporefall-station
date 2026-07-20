// Side-by-side OLD vs NEW pistol silhouette. Faithfully replays the `drawWeapon`
// 'gun' Graphics primitives (rects / roundrects / polys / circles) on a plain 2D
// canvas — no pixi needed — scaled up so the improved grip + slide + barrel +
// muzzle read against the old flat stub. Screenshot only; documents Problem 2.
import { chromium } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.OUT ?? join(__dirname, '../docs/assets/weapon-aim/pistol-old-vs-new.png')

const html = `<!doctype html><meta charset=utf8><body style="margin:0;background:#1a1c22">
<canvas id=c width=660 height=560></canvas>
<script>
const S=12, W=44, H=18, grip=5, my=9;
const hex=n=>'#'+(n>>>0).toString(16).padStart(6,'0');
const steel=0xb8bcc6, darkSteel=0x6d7079, gunGrip=0x33363d;
const g=document.getElementById('c').getContext('2d');
g.imageSmoothingEnabled=false;

const rr=(x0,y0,w,h,r,fill)=>{g.fillStyle=hex(fill);g.beginPath();g.roundRect(x0,y0,w,h,r);g.fill();};
const stroke=(fn,c,lw)=>{g.strokeStyle=typeof c==='number'?hex(c):c;g.lineWidth=lw;g.beginPath();fn();g.stroke();};
const rect=(x0,y0,w,h,fill,a=1)=>{g.save();g.globalAlpha=a;g.fillStyle=typeof fill==='number'?hex(fill):fill;g.fillRect(x0,y0,w,h);g.restore();};
const circ=(cx,cy,r,fill)=>{g.fillStyle=hex(fill);g.beginPath();g.arc(cx,cy,r,0,7);g.fill();};

function panel(ox, oy, draw){
  g.save(); g.translate(ox,oy); g.scale(S,S);
  // grip anchor (pivot) + the aim baseline the barrel must lie along
  g.strokeStyle='rgba(120,160,255,.55)'; g.lineWidth=.28; g.setLineDash([1.2,1]);
  g.beginPath(); g.moveTo(grip,my); g.lineTo(W,my); g.stroke(); g.setLineDash([]);
  g.fillStyle='rgba(120,160,255,.95)'; g.beginPath(); g.arc(grip,my,.7,0,7); g.fill();
  draw();
  g.restore();
}

const OY_OLD=90, OY_NEW=340;
// OLD
panel(60, OY_OLD, ()=>{
  rr(grip,my-3,W-grip-12,6,1.5,darkSteel);   // body/barrel
  rect(W-14,my-4,8,8,0x50535b);              // breech block
  rect(grip+3,my+2,5,7,0x2f3138);            // grip
  circ(W-5,my,2,0x2a2a30);                   // muzzle
});

// NEW
panel(60, OY_NEW, ()=>{
  const frameY=my-5, gx=grip;
  g.fillStyle=hex(gunGrip); g.beginPath();
  g.moveTo(gx-1,frameY+4); g.lineTo(gx+6,frameY+4); g.lineTo(gx+4,my+9); g.lineTo(gx-3,my+8); g.closePath(); g.fill();
  stroke(()=>{g.moveTo(gx-1,frameY+4); g.lineTo(gx+6,frameY+4); g.lineTo(gx+4,my+9); g.lineTo(gx-3,my+8); g.closePath();},'rgba(16,16,24,.55)',.12);
  stroke(()=>g.arc(gx+8,my+3,3,0,7), 0x2a2c33, .34);   // trigger guard ring
  rr(gx-1,frameY,22,7,1.5,steel);                       // slide/frame
  stroke(()=>g.roundRect(gx-1,frameY,22,7,1.5),'rgba(16,16,24,.5)',.12);
  rect(gx+1,frameY,1.5,7,0x101018,.32);                 // serration
  rect(gx+4,frameY,1.5,7,0x101018,.32);                 // serration
  rect(gx,frameY-1.5,3,1.5,darkSteel);                  // rear sight
  const barX=gx+20;
  rect(barX,my-2,W-barX-3,4,darkSteel);                 // barrel
  rect(barX+2,frameY+1,2,1.5,steel);                    // front sight
  circ(W-3,my,2,0x1b1c21);                              // muzzle
});

g.fillStyle='#cfd3dc'; g.font='22px monospace';
g.fillText('OLD', 60, OY_OLD - 34);
g.fillText('NEW', 60, OY_NEW - 34);
g.fillStyle='#8892a2'; g.font='14px monospace';
g.fillText('flat stub + block', 150, OY_OLD - 30);
g.fillText('grip · guard · slide · barrel · muzzle on the aim line', 150, OY_NEW - 30);
g.fillStyle='#6b7280'; g.font='12px monospace';
g.fillText('dashed = aim line (barrel points along it, where bullets exit)', 60, 545);
</script></body>`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 660, height: 560 } })
await page.setContent(html)
await page.waitForTimeout(200)
await page.screenshot({ path: OUT })
await browser.close()
console.log('wrote', OUT)
