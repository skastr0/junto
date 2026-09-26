import type { PortraitConfig } from "./agent-portrait";

// Per-seat portrait overrides (the character editor's output), stored one row
// per seat in junto.db `portrait_overrides`. Traits are bounded plain strings
// and the renderer resolves each against today's options, falling back to
// the identity default, so an option a later build retires never makes a row
// unreadable. This normalizer is the one gate for both the IPC input and the
// stored rows: it keeps known fields of the right shape and drops the rest.

const TRAIT_KEYS = ["bodyHue", "accentHue", "shape", "topper", "eyes", "mouth", "brows", "marking", "accessory"] as const;
// A trait is a base id ("toast") or a pack item ("<pack>:<item>").
const TRAIT_MAX = 72;

/** Largest stored override body; a full config is well under 400 bytes. */
export const PORTRAIT_OVERRIDE_MAX_JSON = 2048;

/** Longest seat identity (a canvas node id). */
export const PORTRAIT_SEAT_ID_MAX = 1024;

export type PortraitOverride = PortraitConfig;

/** Seat id -> override, as the renderer holds it. */
export type PortraitOverrides = Readonly<Record<string, PortraitOverride>>;

export type PortraitOverrideSetResult =
  | { readonly ok: true; readonly seatId: string; readonly override: PortraitOverride | null }
  | { readonly ok: false; readonly message: string };

/** Main -> renderer: one seat's override as it now stands (null is reset). */
export type PortraitOverrideEvent = {
  readonly seatId: string;
  readonly override: PortraitOverride | null;
};

export const isPortraitSeatId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= PORTRAIT_SEAT_ID_MAX;

/**
 * Keep the known, well-shaped fields of an override. Returns null when
 * nothing usable is left (an empty override is a reset, never a row).
 */
export function normalizePortraitOverride(value: unknown): PortraitOverride | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of TRAIT_KEYS) {
    const trait = input[key];
    if (typeof trait === "string" && trait.length > 0 && trait.length <= TRAIT_MAX) out[key] = trait;
  }
  if (typeof input.blush === "boolean") out.blush = input.blush;
  const temperament = input.temperament;
  if (typeof temperament === "number" && Number.isFinite(temperament) && temperament >= -1 && temperament <= 1) {
    out.temperament = temperament;
  }
  return Object.keys(out).length > 0 ? (out as PortraitOverride) : null;
}
