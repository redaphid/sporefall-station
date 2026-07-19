// Interactive UI chrome — the press-exempt layer.
//
// Any element carrying `data-ui-chrome` (or nested inside one) is INTERACTIVE
// UI, not play space: a press landing on it must NEVER enter the game-input /
// inspect press classification (pressModel.ts) — the chrome element owns its
// tap outright. The touch layer (touch.ts) and the canvas inspect wiring
// (overlay.ts) both consult isUiChrome() before feeding a press to their
// trackers, so marking an overlay is sufficient — no per-overlay carve-outs.
//
// Mark every clickable overlay (settings gear/panel, mission chip/panel,
// inspect-card affordances, menus, game-over screen…) with markUiChrome so the
// NEXT overlay added is exempt by construction instead of by luck.
//
// Hit-test reality check: marking is only half the contract. Chrome must ALSO
// sit where touches can reach it — on the UI layer (#ui, the same layer as the
// touch controls' full-screen stick zones) with a z-index above them. Chrome
// mounted on the canvas host (#app) is UNDER #ui in the browser's hit test, so
// on a phone the stick zones swallow every touch before it arrives, no matter
// what z-index the chrome asks for — #app and #ui are sibling stacking
// contexts, so z-indexes inside one never compete with the other. That exact
// trap is how the settings gear shipped mouse-only.

export const markUiChrome = (el: HTMLElement): void => {
  el.dataset.uiChrome = ''
}

/** Did this event target land on (or inside) marked UI chrome? */
export const isUiChrome = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-ui-chrome]') !== null
