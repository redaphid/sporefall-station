import { record } from './lib.mjs'

// Mission-marker parity proof (the "icon points at empty ground" bug, fixed):
// on the REAL generated floor 1 of seed 7 the mission briefcase sits at
// (58,58) — deep in the map's SE corner, exactly where the camera's soft
// overscan clamp reshapes the view and where the old duplicated overlay clamp
// drifted by up to 0.4*half-view. The clip follows the 🎯 marker from spawn to
// the actual briefcase (teleport hops + a real final walk-on pickup), and the
// asserts compare the DOM marker against `__renderedProject` — the pixi world
// container's LIVE transform, not any re-derived camera math:
//
//   1. spawn (NW corner): edge 🎯 arrow visible, rotated toward the true
//      target bearing, with the true tile distance.
//   2. mid-map hop: same invariant holds while the clamp is inactive.
//   3. inside the objective room (SE corner, BOTH clamp axes active): the
//      caret sits ON the briefcase's rendered pixel — pre-fix it floated
//      ~(256,144)px past it, over empty ground.
//   4. walking onto the briefcase completes the mission: markers retire, the
//      chip flips to "EXIT is open", and the exit compass takes over.
//   5. near the exit tile: compass visible with a live distance readout.

const installHelpers = (page) =>
  page.evaluate(() => {
    const selfEnt = () => window.__world.entities.find((e) => e.playerCtl && !e.dead)
    const targetEnt = () => {
      const w = window.__world
      return w.entities.find((e) => e.id === w.mission.targetEntityId && !e.dead)
    }
    /** Teleport the player to the walkable tile nearest (x,y) — spiral probe on
     * the live solid layer so hops never land inside a wall. */
    window.__hopTo = (x, y) => {
      const w = window.__world
      const L = w.level
      const solid = (tx, ty) => tx < 0 || ty < 0 || tx >= L.w || ty >= L.h || L.solid[ty * L.w + tx] === 1
      let best = null
      for (let r = 0; r < 6 && !best; r++) {
        for (let dy = -r; dy <= r && !best; dy++) {
          for (let dx = -r; dx <= r && !best; dx++) {
            const tx = Math.floor(x) + dx
            const ty = Math.floor(y) + dy
            if (!solid(tx, ty)) best = { x: tx + 0.5, y: ty + 0.5 }
          }
        }
      }
      const p = selfEnt()
      return window.__verb(`teleport ${p.id} ${best.x} ${best.y}`)
    }
    window.__snapMarker = (key) => {
      const shots = (window.__shots ??= {})
      const w = window.__world
      const self = selfEnt()
      const target = targetEnt()
      const caret = document.querySelector('[data-mission-marker="target"]')
      const edge = document.querySelector('[data-mission-marker="edge"]')
      const edgeArrow = edge?.querySelector('[data-edge-arrow]')
      const edgeLabel = edge?.querySelector('[data-edge-label]')
      const exitArrow = document.querySelector('#exitArrow')
      const vis = (n) => !!n && getComputedStyle(n).display !== 'none'
      shots[key] = {
        tick: w.tick,
        missionComplete: w.mission.complete,
        exitUnlocked: w.mission.exitUnlocked,
        chipText: document.querySelector('[data-mission-chip]')?.textContent ?? '',
        self: self ? { x: self.pos.x, y: self.pos.y } : null,
        target: target ? { x: target.pos.x, y: target.pos.y } : null,
        // DOM marker truth
        caretVisible: vis(caret),
        caretLeft: caret ? parseFloat(caret.style.left) : null,
        caretTop: caret ? parseFloat(caret.style.top) : null,
        edgeVisible: vis(edge),
        edgeAngle: edgeArrow ? parseFloat((edgeArrow.style.transform.match(/rotate\(([-\d.]+)rad\)/) ?? [])[1]) : null,
        edgeLabel: edgeLabel?.textContent ?? '',
        exitCompassVisible: !!exitArrow && vis(exitArrow.parentElement),
        exitLabel: document.querySelector('#exitLabel')?.textContent ?? '',
        // RENDERED truth (live pixi container transform) + self projection,
        // to prove the corner clamp is actually engaged in the money shot.
        renderedTarget: target ? window.__renderedProject(target.pos.x, target.pos.y) : null,
        renderedSelf: self ? window.__renderedProject(self.pos.x, self.pos.y) : null,
      }
    }
    // Keep the demo about geometry, not survival: this is a VIEW-layer proof.
    window.__world.hostile = false
  })

const snap = (label) => (page) => page.evaluate((k) => window.__snapMarker(k), label)
const hop = (x, y) => (page) => page.evaluate(([hx, hy]) => window.__hopTo(hx, hy), [x, y])
const seq =
  (...acts) =>
  async (page) => {
    for (const a of acts) await a(page)
  }
const settle = (ms) => (page) => page.waitForTimeout(ms)

const SCREEN = { w: 1280, h: 720 }
const bearingOk = (s, tol = 0.2) => {
  if (!s?.self || !s?.target || s.edgeAngle === null || Number.isNaN(s.edgeAngle)) return false
  const want = Math.atan2(s.target.y - s.self.y, s.target.x - s.self.x)
  const d = Math.abs(Math.atan2(Math.sin(s.edgeAngle - want), Math.cos(s.edgeAngle - want)))
  return d < tol
}
const distOf = (s) => (s?.self && s?.target ? Math.hypot(s.target.x - s.self.x, s.target.y - s.self.y) : NaN)

const ok = await record({
  name: 'mission-marker-corner',
  params: { mode: 'solo', seed: 7, script: 'missionMarker', e2e: 1 },
  beforeTicks: installHelpers,
  stills: [
    { tick: 30, label: '01-spawn-edge-arrow', act: snap('spawn') },
    { tick: 60, label: '02-hop-mid-map', act: seq(hop(32.5, 30.5), settle(400), snap('mid')) },
    { tick: 120, label: '03-hop-se-district', act: seq(hop(52.5, 55.5), settle(400), snap('near')) },
    // Inside the objective room, 1.5 tiles west of the briefcase. The camera
    // follow needs ~a second to settle onto the corner clamp before the shot.
    { tick: 180, label: '04-caret-on-briefcase-corner-clamped', act: seq(hop(56.5, 58.0), settle(1200), snap('corner')) },
    // Script ticks 300-325 walk east onto the briefcase — real pickup path.
    { tick: 360, label: '05-mission-complete-markers-retired', act: snap('complete') },
    {
      tick: 420,
      label: '06-exit-compass-near-exit',
      // Poll for the compass (its visibility flips on a render frame, and
      // Playwright wall-clock under video recording is slow) before snapping.
      act: seq(
        hop(59.5, 62.5),
        (page) =>
          page
            .waitForFunction(
              () => {
                const a = document.querySelector('#exitArrow')
                return !!a && getComputedStyle(a.parentElement).display !== 'none'
              },
              { timeout: 8000 },
            )
            .catch(() => {}),
        snap('exit'),
      ),
    },
  ],
  readState: () => window.__shots,
  expect: (s) => {
    const f = []
    // 1) Spawn: steal mission live, target far off-screen → edge arrow with
    // true bearing + true distance readout.
    if (!/Steal the briefcase/.test(s.spawn?.chipText ?? '')) f.push(`not a steal mission: "${s.spawn?.chipText}"`)
    if (!s.spawn?.edgeVisible) f.push('spawn: edge 🎯 indicator not visible')
    if (s.spawn?.caretVisible) f.push('spawn: caret should be hidden while target is off-screen')
    if (!bearingOk(s.spawn)) f.push(`spawn: edge arrow bearing wrong (angle=${s.spawn?.edgeAngle})`)
    const wantDist = Math.round(distOf(s.spawn))
    if (!(s.spawn?.edgeLabel ?? '').includes(`${wantDist}m`)) f.push(`spawn: distance label "${s.spawn?.edgeLabel}" != ~${wantDist}m`)
    // 2) Mid-map: the invariant holds en route.
    if (!s.mid?.edgeVisible || !bearingOk(s.mid)) f.push(`mid: edge arrow wrong (${JSON.stringify(s.mid)})`)
    // 3) THE MONEY SHOT — SE corner, both clamp axes engaged: the caret must
    // sit on the briefcase's RENDERED pixel (tolerance covers px rounding).
    const c = s.corner
    if (!c?.caretVisible) f.push('corner: caret not visible over the briefcase')
    if (c?.caretVisible && c.renderedTarget) {
      const dx = Math.abs(c.caretLeft - c.renderedTarget.x)
      const dy = Math.abs(c.caretTop - (c.renderedTarget.y - 18))
      if (dx > 4 || dy > 4) f.push(`corner: caret off the rendered target by (${dx.toFixed(1)},${dy.toFixed(1)})px — the regression`)
    }
    // …and the corner clamp is genuinely active: the player is NOT screen-centred.
    if (c?.renderedSelf) {
      const off = Math.hypot(c.renderedSelf.x - SCREEN.w / 2, c.renderedSelf.y - SCREEN.h / 2)
      if (off < 40) f.push(`corner: camera not clamped (self only ${off.toFixed(0)}px off centre) — shot proves nothing`)
    }
    if (c && c.missionComplete) f.push('corner: mission completed before the walk-on — timeline broken')
    // 4) Real pickup completes the mission; markers hand over to the exit flow.
    if (!s.complete?.missionComplete) f.push('walk-on pickup did not complete the mission')
    if (!s.complete?.exitUnlocked) f.push('exit did not unlock on completion')
    if (!/EXIT is open/.test(s.complete?.chipText ?? '')) f.push(`chip did not flip: "${s.complete?.chipText}"`)
    if (s.complete?.caretVisible || s.complete?.edgeVisible) f.push('mission markers must retire after completion')
    // 5) Exit compass live near the exit with a distance readout.
    if (!s.exit?.exitCompassVisible) f.push('exit compass not visible after completion')
    if (!/EXIT · \d+m/.test(s.exit?.exitLabel ?? '')) f.push(`exit label malformed: "${s.exit?.exitLabel}"`)
    return f
  },
})

process.exit(ok ? 0 : 1)
