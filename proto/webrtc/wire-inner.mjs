// Runs inside `unshare -rn`: an impaired "wire" (netem on lo) between unix sockets.
import net from 'node:net'
import dgram from 'node:dgram'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const D = process.argv[2]
execFileSync('ip', ['link', 'set', 'lo', 'up'])
const sock = (n) => {
  const p = `${D}/${n}`
  try { fs.unlinkSync(p) } catch {}
  return p
}
const splice = (a, b) => {
  a.pipe(b).pipe(a)
  const end = () => { a.destroy(); b.destroy() }
  for (const s of [a, b]) { s.on('error', end); s.on('close', end) }
}

// TCP: one impaired hop per connection (that peer's access link).
const LO_PORT = 9001
net.createServer((c) => {
  c.setNoDelay(true)
  splice(c, net.connect(`${D}/tout.sock`))
}).listen(LO_PORT, '127.0.0.1')
net.createServer((u) => {
  const c = net.connect(LO_PORT, '127.0.0.1')
  c.setNoDelay(true)
  splice(u, c)
}).listen(sock('tin.sock'))

// UDP: each datagram crosses lo twice (X->Y, Y->Z) = host and guest access links.
const X = dgram.createSocket('udp4'), Y = dgram.createSocket('udp4'), Z = dgram.createSocket('udp4')
await Promise.all([X, Y, Z].map((s, i) => new Promise((r) => s.bind(9011 + i, '127.0.0.1', r))))
let out = null
Y.on('message', (m) => Y.send(m, 9013, '127.0.0.1'))
Z.on('message', (m) => {
  if (!out) return
  const h = Buffer.alloc(2)
  h.writeUInt16BE(m.length)
  out.write(Buffer.concat([h, m]))
})
net.createServer((u) => {
  out = u
  let buf = Buffer.alloc(0)
  u.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 2) {
      const n = buf.readUInt16BE(0)
      if (buf.length < 2 + n) break
      X.send(buf.subarray(2, 2 + n), 9012, '127.0.0.1')
      buf = buf.subarray(2 + n)
    }
  })
}).listen(sock('udp.sock'))

net.createServer((c) => c.on('data', (d) => {
  const [delay, loss] = d.toString().trim().split(/\s+/).map(Number)
  try {
    try { execFileSync('tc', ['qdisc', 'del', 'dev', 'lo', 'root'], { stdio: 'ignore' }) } catch {}
    if (delay > 0 || loss > 0) {
      execFileSync('tc', ['qdisc', 'add', 'dev', 'lo', 'root', 'netem', 'delay', `${delay}ms`, 'loss', `${loss}%`, 'limit', '10000'])
    }
    c.end(execFileSync('tc', ['qdisc', 'show', 'dev', 'lo']).toString())
  } catch (e) {
    c.end('ERR ' + e.message)
  }
})).listen(sock('ctl.sock'))
console.log('inner ready')
