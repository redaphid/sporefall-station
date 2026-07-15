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

/**
 * Host side: turn a display name into the short local name we put on the air.
 * Collapses whitespace, truncates to the advertisement budget, and falls back to
 * 'SoR' so we never advertise an empty name.
 */
export const toAdvertiseName = (raw: string | null | undefined): string => {
  const clean = (raw ?? '').replace(/\s+/g, ' ').trim()
  const short = clean.slice(0, ADVERTISE_NAME_MAX).trim()
  return short || 'SoR'
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
