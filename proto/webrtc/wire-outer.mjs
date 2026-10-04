// Outer half of the wire: TCP :WS_PORT -> netns -> wrangler, and a 2-port UDP proxy -> netns.
import net from 'node:net'
import dgram from 'node:dgram'
import fs from 'node:fs'
const [D, WS_PORT, WRANGLER_PORT, UA, UB] = process.argv.slice(2)
const splice = (a, b) => {
  a.pipe(b).pipe(a)
  const end = () => { a.destroy(); b.destroy() }
  for (const s of [a, b]) { s.on('error', end); s.on('close', end) }
}
const sock = (n) => {
  const p = `${D}/${n}`
  try { fs.unlinkSync(p) } catch {}
  return p
}
net.createServer((c) => {
  c.setNoDelay(true)
  splice(c, net.connect(`${D}/tin.sock`))
}).listen(+WS_PORT, '0.0.0.0')
net.createServer((u) => {
  const c = net.connect(+WRANGLER_PORT, '127.0.0.1')
  c.setNoDelay(true)
  splice(u, c)
}).listen(sock('tout.sock'))

// The host is told the guest lives at UA; the guest is told the host lives at UB.
const sA = dgram.createSocket('udp4'), sB = dgram.createSocket('udp4')
const addr = [null, null]
const ipc = net.connect(`${D}/udp.sock`)
const fwd = (dir, m) => {
  const h = Buffer.alloc(3)
  h.writeUInt16BE(m.length + 1)
  h[2] = dir
  ipc.write(Buffer.concat([h, m]))
}
const same = (a, b) => a.address === b.address && a.port === b.port
sA.on('message', (m, r) => { addr[0] ??= r; if (same(r, addr[0])) fwd(1, m) })
sB.on('message', (m, r) => { addr[1] ??= r; if (same(r, addr[1])) fwd(0, m) })
let buf = Buffer.alloc(0)
ipc.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 2) {
    const n = buf.readUInt16BE(0)
    if (buf.length < 2 + n) break
    const dir = buf[2], m = buf.subarray(3, 2 + n)
    const to = addr[dir]
    if (to) (dir === 0 ? sA : sB).send(m, to.port, to.address)
    buf = buf.subarray(2 + n)
  }
})
sA.bind(+UA, '0.0.0.0')
sB.bind(+UB, '0.0.0.0')
net.createServer((c) => { addr[0] = null; addr[1] = null; c.end('reset') }).listen(sock('reset.sock'))
console.log('outer ready')
