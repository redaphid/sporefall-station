/**
 * The real, native side of haptics — the ONLY module that touches
 * @capacitor/haptics. Kept apart from haptics.ts so tests (and the pure
 * mapping) never import the plugin. Every method here assumes it's only called
 * after `isNative()` passed, but the calls are fire-and-forget and swallow
 * errors so a flaky motor can never crash a frame.
 */

import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { HapticCmd, HapticDriver, HapticStyle } from './haptics'

const STYLE: Record<HapticStyle, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
}

/** Low intensity softens a heavy pulse down a step so the slider actually bites
 * (the native API has no continuous strength, only three discrete styles). */
const scaleStyle = (style: HapticStyle, intensity: number): HapticStyle => {
  if (intensity >= 0.66) return style
  if (intensity >= 0.33) return style === 'heavy' ? 'medium' : style === 'medium' ? 'light' : 'light'
  return 'light'
}

export const nativeHapticDriver = (): HapticDriver => ({
  isNative: () => Capacitor.isNativePlatform(),
  now: () => performance.now(),
  impact(cmd: HapticCmd, intensity: number): void {
    void Haptics.impact({ style: STYLE[scaleStyle(cmd.style, intensity)] }).catch(() => {})
    if (cmd.vibrateMs && cmd.vibrateMs > 0) {
      void Haptics.vibrate({ duration: Math.round(cmd.vibrateMs * intensity) }).catch(() => {})
    }
  },
})
