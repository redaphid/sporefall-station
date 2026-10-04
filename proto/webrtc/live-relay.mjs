// Host + guest on this machine, through the LIVE relay DO (no deploy, a throwaway room).
// relay RTT = 2*e + 2*d, where e = here<->edge RTT (TCP connect) and d = edge<->DO RTT.
import net from 'node:net'
import tls from 'node:tls'

const HOST = 'sporefall.hypnodroid.com'
const room = `bench-colo-${Math.random().toString(36).slice(2, 8)}`
const base = `wss://${HOST}/ws/${room}`
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]

const edge = []
for (let i = 0; i < 20; i++) {
  const t0 = performance.now()
  await new Promise((r) => { const s = net.connect(443, HOST, () => { edge.push(performance.now() - t0); s.destroy(); r() }) })
}
const ray = await new Promise((r) => {
  const s = tls.connect({ host: HOST, port: 443, servername: HOST }, () => s.write(`GET /ws/${room} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`))
  let b = ''
  s.on('data', (d) => (b += d))
  s.on('end', () => r((b.match(/cf-ray: (\S+)/i) || [])[1] + ' status ' + b.split('\r\n')[0]))
})

const open = (role) => new Promise((res) => {
  const ws = new WebSocket(`${base}?role=${role}`)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => res(ws)
})
const host = await open('host')
let guestId = null
host.onmessage = (ev) => {
  if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.t === 'peer+') guestId = m.id; return }
  const f = new Uint8Array(ev.data)
  host.send(f)
}
const guest = await open('client')
while (!guestId) await new Promise((r) => setTimeout(r, 50))
const rtt = []
guest.onmessage = (ev) => {
  if (typeof ev.data === 'string') return
  const v = new DataView(ev.data)
  rtt.push(performance.now() - v.getFloat64(1))
}
const N = +(process.argv[2] ?? 300)
for (let i = 0; i < N; i++) {
  const b = new Uint8Array(24)
  b[0] = 0xf1
  new DataView(b.buffer).setFloat64(1, performance.now())
  guest.send(b)
  await new Promise((r) => setTimeout(r, 100))
}
await new Promise((r) => setTimeout(r, 1000))
guest.close(); host.close()
const e = pct(edge, 50), R = pct(rtt, 50)
console.log(JSON.stringify({ room, edgeRay: ray, edgeTcpRttP50: +e.toFixed(1), relayRttN: rtt.length, relayRttP50: +R.toFixed(1), relayRttP95: +pct(rtt, 95).toFixed(1), impliedEdgeToDoRttMs: +((R - 2 * e) / 2).toFixed(1) }))
process.exit(0)
