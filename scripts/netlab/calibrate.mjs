// Calibrate the lab: measure relay WebSocket RTT and WebRTC DataChannel RTT under
// several impairments and compare against what was requested.
//   NETLAB_DIR=<scratch dir> node scripts/netlab/calibrate.mjs [--pings 200] [--json out.json]
import fs from 'node:fs'
import { enterNetns, startLab, profileToImpairment } from './lab.mjs'

await enterNetns()

const SETTINGS = [
  { name: 'clean', relay: { rttMs: 0, lossPct: 0 }, udp: { rttMs: 0, lossPct: 0 } },
  { name: 'relay +110ms', relay: { rttMs: 110, lossPct: 0 }, udp: { rttMs: 0, lossPct: 0 } },
  { name: 'udp +80ms', relay: { rttMs: 0, lossPct: 0 }, udp: { rttMs: 80, lossPct: 0 } },
  { name: 'loss', relay: { rttMs: 0, lossPct: 3 }, udp: { rttMs: 0, lossPct: 10 } },
]
const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt)
const PING = { n: Number(arg('--pings', 200)), intervalMs: 20, size: 64, timeoutMs: 3000 }

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN
}
const netemCounts = (qdisc) =>
  Object.fromEntries([...qdisc.matchAll(/qdisc netem (\d+):[^\n]*\n Sent \d+ bytes (\d+) pkt \(dropped (\d+)/g)]
    .map(([, h, pkts, drop]) => [h === '20' ? 'relay' : 'udp', { pkts: Number(pkts), dropped: Number(drop) }]))

const lab = await startLab()
const results = []
try {
  const url = `${lab.staticOrigin}/calibrate.html`
  const { host, guest } = await lab.openPages(url)

  const offer = await host.evaluate(() => window.netlab.dcOffer())
  const answer = await guest.evaluate((o) => window.netlab.dcAnswer(o), offer)
  await host.evaluate((a) => window.netlab.dcAccept(a), answer)
  const pair = await host.evaluate(() => window.netlab.dcSelectedPair())
  console.log('selected ICE pair:', JSON.stringify(pair))
  if (pair?.local.type !== 'host' || pair?.remote.type !== 'host') throw new Error('selected pair is not host<->host')

  let base
  for (const [i, s] of SETTINGS.entries()) {
    const imp = profileToImpairment(s)
    const before = netemCounts((await lab.impair(imp)).qdisc)
    const room = `cal-${i}-${process.pid}`
    await host.evaluate((u) => window.netlab.wsHostEcho(u), lab.relayWs(room, 'host'))
    const ws = await guest.evaluate(([u, o]) => window.netlab.wsClientPing(u, o), [lab.relayWs(room, 'client'), PING])
    const mid = netemCounts(lab.qdisc())
    const dc = await host.evaluate((o) => window.netlab.dcPing(o), PING)
    const after = netemCounts(lab.qdisc())
    const delta = (a, b) => ({
      relay: { pkts: b.relay.pkts - a.relay.pkts, dropped: b.relay.dropped - a.relay.dropped },
      udp: { pkts: b.udp.pkts - a.udp.pkts, dropped: b.udp.dropped - a.udp.dropped },
    })
    const row = (cls, r, req, own, perTraversalLossPct, netem) => ({
      setting: s.name, cls, reqRttMs: req.rttMs, reqOneWayLossPct: req.lossPct,
      p50: pct(r.rtts, 50), p95: pct(r.rtts, 95), p99: pct(r.rtts, 99),
      pingLostPct: (100 * (r.sent - r.rtts.length)) / r.sent,
      reqTraversalLossPct: perTraversalLossPct,
      measTraversalLossPct: (100 * netem[own].dropped) / netem[own].pkts,
      netem,
    })
    const rows = [
      row('relay-ws', ws, s.relay, 'relay', imp.relayLossPct, delta(before, mid)),
      row('p2p-dc', dc, s.udp, 'udp', imp.udpLossPct, delta(mid, after)),
    ]
    base ??= Object.fromEntries(rows.map((r) => [r.cls, r.p50]))
    for (const r of rows) r.addedP50 = r.p50 - base[r.cls]
    results.push({ setting: s, impairment: imp, rows })
  }
} finally {
  await lab.stop()
}

const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-')
console.log('\nsetting       class     +RTT req  +RTT meas   p50    p95    p99   drop/trav req  meas   ping loss exp  meas   lo pkts relay/udp')
for (const { rows } of results) {
  for (const r of rows) {
    const expPingLoss = r.cls === 'p2p-dc' ? 100 * (1 - (1 - r.reqOneWayLossPct / 100) ** 2) : 0
    console.log(
      [r.setting.padEnd(13), r.cls.padEnd(8), f(r.reqRttMs).padStart(8), f(r.addedP50).padStart(9), f(r.p50).padStart(6), f(r.p95).padStart(6),
        f(r.p99).padStart(6), f(r.reqTraversalLossPct).padStart(12), f(r.measTraversalLossPct).padStart(6), f(expPingLoss).padStart(12),
        f(r.pingLostPct).padStart(6), `   ${r.netem.relay.pkts}/${r.netem.udp.pkts}`].join(' '),
    )
  }
}
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(results, null, 2))
