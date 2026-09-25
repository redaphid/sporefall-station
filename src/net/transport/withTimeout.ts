/**
 * A deadline for promises that can hang forever.
 *
 * This exists because of a specific defect in the BLE plugin we ship. Android's
 * GATT client reports connection outcomes through one callback,
 * `onConnectionStateChange(gatt, status, newState)`, and the plugin's version
 * (BluetoothLowEnergyPlugin.java) resolves the pending connect call ONLY on
 * `STATE_CONNECTED`. On `STATE_DISCONNECTED` it emits a `deviceDisconnected`
 * event and drops the pending call on the floor; `status` — the field that
 * carries the actual GATT error — is never even read.
 *
 * So `await connect(...)` against a peripheral that refuses, is out of range, or
 * hits the notorious GATT 133 never settles. Not slowly: NEVER. The joining
 * player waits on a screen that will not change for as long as they are willing
 * to hold the phone, and the reconnect loop that awaits the same call stalls at
 * its first attempt without ever reaching the second.
 *
 * A timeout is the only defence available to us from the JS side without forking
 * the plugin, so every BLE await that can hang gets one.
 *
 * Notes on the implementation, both of which matter:
 * - The timer is ALWAYS cleared once the underlying promise settles. A dangling
 *   `setTimeout` keeps the event loop (and a test runner) alive, and on a phone
 *   it would fire a rejection into a promise nobody is listening to any more.
 * - Handlers are attached to the underlying promise directly rather than racing
 *   it, so a rejection arriving AFTER the deadline is still considered handled
 *   and cannot surface as an unhandled rejection. Settling a promise twice is a
 *   no-op, so the late result is simply discarded.
 */
export const withTimeout = <T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
