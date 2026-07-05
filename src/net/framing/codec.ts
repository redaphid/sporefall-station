/** Cursor-based binary writer/reader for the hot-path messages. */

export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  private pos = 0

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity)
    this.view = new DataView(this.buf.buffer)
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n))
    next.set(this.buf)
    this.buf = next
    this.view = new DataView(this.buf.buffer)
  }

  u8(v: number): this {
    this.ensure(1)
    this.view.setUint8(this.pos, v)
    this.pos += 1
    return this
  }

  u16(v: number): this {
    this.ensure(2)
    this.view.setUint16(this.pos, v, true)
    this.pos += 2
    return this
  }

  i16(v: number): this {
    this.ensure(2)
    this.view.setInt16(this.pos, v, true)
    this.pos += 2
    return this
  }

  u32(v: number): this {
    this.ensure(4)
    this.view.setUint32(this.pos, v >>> 0, true)
    this.pos += 4
    return this
  }

  bytes(v: Uint8Array): this {
    this.ensure(v.length)
    this.buf.set(v, this.pos)
    this.pos += v.length
    return this
  }

  /** Copy of the written region. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

export class ByteReader {
  private view: DataView
  pos = 0

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }

  u8(): number {
    const v = this.view.getUint8(this.pos)
    this.pos += 1
    return v
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  bytes(n: number): Uint8Array {
    const v = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** JSON cold-path helpers: [u8 msgType][utf8 json]. */
export const encodeJson = (msgType: number, payload: unknown): Uint8Array => {
  const body = textEncoder.encode(JSON.stringify(payload))
  const out = new Uint8Array(1 + body.length)
  out[0] = msgType
  out.set(body, 1)
  return out
}

export const decodeJson = <T>(bytes: Uint8Array): T => JSON.parse(textDecoder.decode(bytes.subarray(1))) as T
