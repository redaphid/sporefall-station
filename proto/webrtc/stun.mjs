// From ONE local UDP socket, ask several STUN servers for our mapped address.
// Same mapped ip:port from every server = endpoint-independent mapping (cone NAT).
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import crypto from 'node:crypto'

const servers = [
  ['stun.cloudflare.com', 3478],
  ['stun.cloudflare.com', 53],
  ['stun.l.google.com', 19302],
  ['stun1.l.google.com', 19302],
]
const s = dgram.createSocket('udp4')
await new Promise((r) => s.bind(0, r))
const pending = new Map()
s.on('message', (m) => {
  const tid = m.subarray(8, 20).toString('hex')
  const done = pending.get(tid)
  if (!done) return
  let i = 20
  while (i + 4 <= m.length) {
    const type = m.readUInt16BE(i), len = m.readUInt16BE(i + 2)
    if (type === 0x0020) {
      const port = m.readUInt16BE(i + 6) ^ 0x2112
      const ip = [0, 1, 2, 3].map((k) => m[i + 8 + k] ^ [0x21, 0x12, 0xa4, 0x42][k]).join('.')
      done(`${ip}:${port}`)
    }
    i += 4 + len + ((4 - (len % 4)) % 4)
  }
})
const ask = async (host, port) => {
  const ip = (await dns.lookup(host, { family: 4 })).address
  const tid = crypto.randomBytes(12)
  const req = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), tid])
  return new Promise((res) => {
    pending.set(tid.toString('hex'), res)
    for (let k = 0; k < 3; k++) setTimeout(() => s.send(req, port, ip), k * 300)
    setTimeout(() => res('timeout'), 2500)
  }).then((m) => `${host}:${port} (${ip}) -> ${m}`)
}
console.log('local port', s.address().port)
for (const [h, p] of servers) console.log(await ask(h, p))
s.close()
