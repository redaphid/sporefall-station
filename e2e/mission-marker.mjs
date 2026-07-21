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
//   4. the final hop lands inside pickup range and the REAL autoPickup system
//      completes the mission: the chip flips to "EXIT is open" and the SAME
//      marker machinery re-points at the exit — 🏁 caret ON the exit tile's
//      rendered pixel (no legacy window-pinned compass; that element must not
//      exist at all).
//   5. hop to mid-map: exit genuinely off-screen → edge arrow pinned INSIDE
//      the canvas with the true bearing + distance; then back beside the exit
//      for the closing caret-on-exit beat.

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
    /** The final approach: land INSIDE pickup range of the briefcase (player
     * r=0.35 + item r=0.3), so the next sim tick runs the REAL autoPickup path.
     * Returns a diagnostic string either way — never throws mid-recording. */
    window.__hopOnto = () => {
      const t = targetEnt()
      const p = selfEnt()
      if (!t || !p) return `hopOnto: missing ${t ? 'player' : 'target'} (mission=${JSON.stringify(window.__world.mission)})`
      return window.__verb(`teleport ${p.id} ${t.pos.x - 0.45} ${t.pos.y}`)
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
      const vis = (n) => !!n && getComputedStyle(n).display !== 'none'
      const edgeT = edge?.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)
      const canvas = document.querySelector('canvas')?.getBoundingClientRect()
      const exitPoint = { x: w.level.exit.x + 0.5, y: w.level.exit.y + 0.5 }
      shots[key] = {
        tick: w.tick,
        missionComplete: w.mission.complete,
        exitUnlocked: w.mission.exitUnlocked,
        chipText: document.querySelector('[data-mission-chip]')?.textContent ?? '',
        self: self ? { x: self.pos.x, y: self.pos.y } : null,
        selfDowned: !!self?.playerCtl?.downed,
        target: target ? { x: target.pos.x, y: target.pos.y } : null,
        exitPoint,
        // DOM marker truth
        caretVisible: vis(caret),
        caretGlyph: caret?.textContent ?? '',
        caretLeft: caret ? parseFloat(caret.style.left) : null,
        caretTop: caret ? parseFloat(caret.style.top) : null,
        edgeVisible: vis(edge),
        edgeX: edgeT ? parseFloat(edgeT[1]) : null,
        edgeY: edgeT ? parseFloat(edgeT[2]) : null,
        edgeAngle: edgeArrow ? parseFloat((edgeArrow.style.transform.match(/rotate\(([-\d.]+)rad\)/) ?? [])[1]) : null,
        edgeLabel: edgeLabel?.textContent ?? '',
        // The legacy window-pinned exit compass must NOT exist any more.
        legacyExitCompass: !!document.querySelector('#exitArrow'),
        canvas: canvas ? { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height } : null,
        // RENDERED truth (live pixi container transform) + self projection,
        // to prove the corner clamp is actually engaged in the money shot.
        renderedTarget: target ? window.__renderedProject(target.pos.x, target.pos.y) : null,
        renderedExit: window.__renderedProject(exitPoint.x, exitPoint.y),
        renderedSelf: self ? window.__renderedProject(self.pos.x, self.pos.y) : null,
      }
    }
    // Keep the demo about geometry, not survival: this is a VIEW-layer proof.
    // `hostile=false` quiets the world-level hate, but disposition-hostile NPCs
    // (thugs) still attack — and a hop landing near one can DOWN the player,
    // and a downed player skips autoPickup (interaction.ts), deadlocking the
    // pickup beat. A mountain of HP makes the geometry demo unkillable.
    window.__world.hostile = false
    const p0 = selfEnt()
    if (p0) window.__verb(`set ${p0.id} {"health":{"hp":100000,"max":100000}}`)
  })

const snap = (label) => (page) => page.evaluate((k) => window.__snapMarker(k), label)
const hop = (x, y) => (page) => page.evaluate(([hx, hy]) => window.__hopTo(hx, hy), [x, y])
/** Wait (on rAF, in-page) until the camera glide has ACTUALLY settled — the
 * player's rendered position stops moving — so marker-vs-rendered asserts never
 * race the one-frame lag of an in-flight pan. 6s cap so a hang still snaps. */
const settleCamera = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now()
        let last = null
        let still = 0
        const step = () => {
          const w = window.__world
          const self = w.entities.find((e) => e.playerCtl && !e.dead)
          const p = self ? window.__renderedProject(self.pos.x, self.pos.y) : null
          if (performance.now() - t0 > 6000) return resolve()
          if (last && p && Math.hypot(p.x - last.x, p.y - last.y) < 0.2) {
            if (++still >= 3) return resolve()
          } else still = 0
          last = p
          requestAnimationFrame(step)
        }
        step()
      }),
  )
const seq =
  (...acts) =>
  async (page) => {
    for (const a of acts) await a(page)
  }
const settle = (ms) => (page) => page.waitForTimeout(ms)

const SCREEN = { w: 1280, h: 720 }
const bearingToOk = (s, pt, tol = 0.2) => {
  if (!s?.self || !pt || s.edgeAngle === null || Number.isNaN(s.edgeAngle)) return false
  const want = Math.atan2(pt.y - s.self.y, pt.x - s.self.x)
  const d = Math.abs(Math.atan2(Math.sin(s.edgeAngle - want), Math.cos(s.edgeAngle - want)))
  return d < tol
}
const bearingOk = (s, tol = 0.2) => bearingToOk(s, s?.target, tol)
const distOf = (s) => (s?.self && s?.target ? Math.hypot(s.target.x - s.self.x, s.target.y - s.self.y) : NaN)
const distTo = (s, pt) => (s?.self && pt ? Math.hypot(pt.x - s.self.x, pt.y - s.self.y) : NaN)
/** Caret anchored ON a rendered point: left == x, top == y - 18 (px rounding slack). */
const caretOn = (s, rendered, tol = 4) =>
  s?.caretVisible && rendered && Math.abs(s.caretLeft - rendered.x) <= tol && Math.abs(s.caretTop - (rendered.y - 18)) <= tol

const ok = await record({
  name: 'mission-marker-corner',
  params: { mode: 'solo', seed: 7, script: 'missionMarker', e2e: 1 },
  beforeTicks: installHelpers,
  stills: [
    { tick: 30, label: '01-spawn-edge-arrow', act: snap('spawn') },
    { tick: 60, label: '02-hop-mid-map', act: seq(hop(32.5, 30.5), settleCamera, snap('mid')) },
    { tick: 120, label: '03-hop-se-district', act: seq(hop(52.5, 55.5), settleCamera, snap('near')) },
    // Inside the objective room, 1.5 tiles west of the briefcase. The camera
    // follow needs ~a second to settle onto the corner clamp before the shot.
    { tick: 180, label: '04-caret-on-briefcase-corner-clamped', act: seq(hop(56.5, 58.0), settleCamera, snap('corner')) },
    // The final approach lands inside pickup range → the REAL autoPickup system
    // grabs the briefcase on the next sim tick; wait for the completion, don't
    // guess a tick (every beat here is act-sequenced, immune to wall-clock).
    // The exit (62,62) is on-screen from there: the 🏁 caret must sit on ITS
    // rendered pixel — same rigor as the briefcase money shot.
    {
      tick: 210,
      label: '05-exit-caret-takes-over',
      act: seq(
        async (page) => console.log('hopOnto:', await page.evaluate(() => window.__hopOnto())),
        // NOTE Playwright signature: (fn, ARG, options) — options is third.
        (page) =>
          page
            .waitForFunction(() => window.__world.mission.complete, undefined, { timeout: 10000 })
            .catch(async () => {
              const diag = await page.evaluate(() => {
                const w = window.__world
                const self = w.entities.find((e) => e.playerCtl && !e.dead)
                const t = w.entities.find((e) => e.id === w.mission.targetEntityId)
                return { tick: w.tick, mission: w.mission, self: self?.pos, target: t && { pos: t.pos, dead: t.dead } }
              })
              console.log('pickup never completed, diag:', JSON.stringify(diag))
            }),
        settleCamera,
        snap('complete'),
      ),
    },
    // Hop back to mid-map: the exit is genuinely off-screen now, so the SAME
    // edge-arrow machinery must pin inside the CANVAS with the true bearing.
    { tick: 240, label: '06-exit-edge-arrow-mid-map', act: seq(hop(32.5, 30.5), settleCamera, snap('exitEdge')) },
    // Back beside the exit for the closing beat: caret on the exit tile.
    { tick: 270, label: '07-exit-caret-closeup', act: seq(hop(59.5, 62.5), settleCamera, snap('exitNear')) },
  ],
  readState: () => window.__shots,
  expect: (s) => {
    const f = []
    // 1) Spawn: steal mission live, target far off-screen → edge arrow with
    // true bearing + true distance readout.
    if (!/Extract the specimen canister/.test(s.spawn?.chipText ?? '')) f.push(`not a steal mission: "${s.spawn?.chipText}"`)
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
    // 4) Real pickup completes the mission; the SAME marker machinery hands
    // over to the exit: 🏁 caret ON the exit's rendered pixel (it is on-screen
    // from the pickup spot), no edge arrow, and NO legacy compass element.
    const done = s.complete
    if (!done?.missionComplete) f.push('walk-on pickup did not complete the mission')
    if (!done?.exitUnlocked) f.push('exit did not unlock on completion')
    if (!/LAUNCH BAY is open/.test(done?.chipText ?? '')) f.push(`chip did not flip: "${done?.chipText}"`)
    if (done?.caretGlyph !== '🏁') f.push(`exit caret glyph wrong: "${done?.caretGlyph}"`)
    if (!caretOn(done, done?.renderedExit))
      f.push(`complete: exit caret not on the rendered exit (caret ${done?.caretLeft},${done?.caretTop} vs ${JSON.stringify(done?.renderedExit)})`)
    if (done?.edgeVisible) f.push('complete: edge arrow must hide while the exit is on-screen')
    if (done?.legacyExitCompass) f.push('legacy #exitArrow compass still in the DOM')
    // 5) Off-screen exit → edge arrow pinned INSIDE the canvas with the true
    // bearing and true distance (this is where the old compass sat window-pinned
    // in the letterbox, claiming an on-screen exit was off-screen below).
    const eg = s.exitEdge
    if (!eg?.edgeVisible) f.push('mid-map: exit edge arrow not visible')
    if (eg?.caretVisible) f.push('mid-map: caret must hide while the exit is off-screen')
    if (!bearingToOk(eg, eg?.exitPoint)) f.push(`mid-map: exit bearing wrong (angle=${eg?.edgeAngle})`)
    const wantExitDist = Math.round(distTo(eg, eg?.exitPoint))
    const labelDist = Number((eg?.edgeLabel ?? '').match(/LAUNCH BAY · (\d+)m/)?.[1] ?? NaN)
    if (!(Math.abs(labelDist - wantExitDist) <= 2)) f.push(`mid-map: exit label "${eg?.edgeLabel}" != ~${wantExitDist}m`)
    if (eg?.canvas && eg.edgeX !== null) {
      const inCanvas =
        eg.edgeX >= eg.canvas.x + 26 &&
        eg.edgeX <= eg.canvas.x + eg.canvas.w - 26 &&
        eg.edgeY >= eg.canvas.y + 26 &&
        eg.edgeY <= eg.canvas.y + eg.canvas.h - 26
      if (!inCanvas)
        f.push(`mid-map: edge arrow pinned outside the canvas (edge ${eg.edgeX},${eg.edgeY} canvas ${JSON.stringify(eg.canvas)})`)
    } else f.push('mid-map: no canvas rect / edge transform to assert against')
    // 6) Closing beat: back beside the exit, caret on its rendered pixel again.
    const en = s.exitNear
    if (en?.caretGlyph !== '🏁' || !caretOn(en, en?.renderedExit))
      f.push(`closeup: exit caret not on the rendered exit (${JSON.stringify({ glyph: en?.caretGlyph, left: en?.caretLeft, top: en?.caretTop, rendered: en?.renderedExit })})`)
    if (en?.legacyExitCompass) f.push('closeup: legacy #exitArrow compass still in the DOM')
    return f
  },
})

process.exit(ok ? 0 : 1)
