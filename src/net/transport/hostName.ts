/**
 * Pure name helpers for BLE host discovery — kept free of the plugin so they can
 * be unit-tested without a phone.
 *
 * Why the tiny budget: a legacy BLE advertisement is a 31-byte PDU. A connectable
 * advert already spends ~3 bytes on flags and 18 bytes on our 128-bit service UUID
 * (2 header + 16), leaving ~10 bytes for the local-name AD structure — 2 bytes of
 * which are its own header. So only ~8 characters of name actually fit. Anything
 * longer makes Android's advertiser fail ADVERTISE_FAILED_DATA_TOO_LARGE (silently,
 * since the capgo plugin resolves before its async onStartFailure fires). The capgo
 * plugin advertises with the 3-arg BluetoothLeAdvertiser.startAdvertising, i.e. NO
 * scan-response packet, so the name has to live in the main advert — hence the hard
 * truncation here instead of overflowing into scan-response.
 */
export const ADVERTISE_NAME_MAX = 8

/** Hard limit on a legacy advertisement PDU. Over this, Android answers
 * ADVERTISE_FAILED_DATA_TOO_LARGE — and does so silently (see advertisementBytes). */
export const ADVERTISE_PDU_MAX = 31

/** AD-structure overheads, mirroring AOSP BluetoothLeAdvertiser: a mandatory
 * flags structure in a connectable advert, then 1 length + 1 type byte per field. */
const FLAGS_FIELD_BYTES = 3
const OVERHEAD_BYTES_PER_FIELD = 2
const UUID_128_BYTES = 16

/**
 * Size in bytes of the legacy advertisement PDU we are asking Android to broadcast.
 * Mirrors AOSP's BluetoothLeAdvertiser.totalBytes(): exceed ADVERTISE_PDU_MAX and
 * the stack calls postStartFailure(ADVERTISE_FAILED_DATA_TOO_LARGE) and RETURNS
 * WITHOUT THROWING — so the capgo plugin's call.resolve() still runs, our await
 * still succeeds, and the host reports it is advertising while the radio is quiet.
 * Nothing at runtime will tell us we are over budget, so we measure it here.
 *
 * The name is measured as UTF-8, because that is what goes on the air. JS string
 * length counts UTF-16 code units and under-counts every non-ASCII character —
 * an emoji is 2 code units but 4 bytes.
 */
export const advertisementBytes = (opts: { name?: string | null; serviceUuids?: number }): number => {
  let size = FLAGS_FIELD_BYTES
  size += (opts.serviceUuids ?? 0) * (OVERHEAD_BYTES_PER_FIELD + UUID_128_BYTES)
  const name = opts.name ?? ''
  if (name) size += OVERHEAD_BYTES_PER_FIELD + new TextEncoder().encode(name).length
  return size
}

/**
 * Host side: turn a display name into the short local name we put on the air.
 * Collapses whitespace, truncates to the advertisement budget, and falls back to
 * 'Spore' so we never advertise an empty name.
 */
export const toAdvertiseName = (raw: string | null | undefined): string => {
  const clean = (raw ?? '').replace(/\s+/g, ' ').trim()
  let short = clean.slice(0, ADVERTISE_NAME_MAX)
  // Truncation must not sever a surrogate pair: a dangling high surrogate is an
  // invalid code unit that encodes to a broken UTF-8 byte on the air.
  if (/[\uD800-\uDBFF]$/.test(short)) short = short.slice(0, -1)
  short = short.trim()
  return short || 'Spore'
}

/**
 * Scan side: the label shown for a host in the join list. Prefer the advertised
 * name; when a host advertised no usable name, derive a stable short code from its
 * deviceId so two nameless hosts stay distinguishable instead of both reading
 * 'Unknown host'.
 */
export const toHostLabel = (name: string | null | undefined, deviceId: string): string => {
  const clean = (name ?? '').trim()
  if (clean) return clean
  const tail = (deviceId ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(-4).toUpperCase()
  return tail ? `Host ${tail}` : 'Unknown host'
}
