/**
 * Compile-time product feature gates.
 *
 * Values are injected by electron-vite / bun build `define`. When the define
 * is absent (tsc, vitest without define), the env fallback applies so unit
 * tests and unbundled scripts stay deterministic.
 *
 * Herdr is legacy PTY-pane attach — not core product. Default OFF.
 * Re-enable a build with `VELLUM_HERDR=1`.
 */

declare const __VELLUM_HERDR_ENABLED__: boolean | undefined;

const envEnabled = (key: string): boolean => {
  try {
    return process.env[key] === "1";
  } catch {
    return false;
  }
};

/**
 * Product surface for Herdr (legacy pane attach, wizard, host capability,
 * serve-catalog IPC, idle-herdr queue, region herdr defaults, …).
 *
 * When false: no authoring UI, no host-cap chips/checkboxes, no herdr IPC
 * registration, no herdr plane start/warm. Durable schema still decodes
 * historical `herdr` rows; they render as inert furniture.
 */
export const HERDR_ENABLED: boolean =
  typeof __VELLUM_HERDR_ENABLED__ === "boolean"
    ? __VELLUM_HERDR_ENABLED__
    : envEnabled("VELLUM_HERDR");

/** Strip product-hidden capabilities from a host capability list for UI. */
export const productHostCapabilities = <T extends string>(
  capabilities: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  HERDR_ENABLED
    ? capabilities
    : capabilities.filter((c) => c !== "herdr");
