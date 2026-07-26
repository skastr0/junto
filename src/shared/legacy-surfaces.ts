/**
 * Product surface gate: ACP chat and herdr are retired as primary operator paths.
 * Managed terminal is the only agent work surface.
 *
 * Keep services/code dormant — this flag only hides UI entry points so operators
 * cannot open ACP chat or create/open herdr as the default path.
 * Flip to false only for deliberate legacy revival (not a runtime feature flag).
 */
export const LEGACY_SURFACES_HIDDEN = true as const;

/** ACP chat UI (toolbar, kind strip, double-click open). */
export const ACP_CHAT_SURFACE_HIDDEN = LEGACY_SURFACES_HIDDEN;

/** Herdr placement, wizard entry, selection toolbar, capability toggles. */
export const HERDR_SURFACE_HIDDEN = LEGACY_SURFACES_HIDDEN;
