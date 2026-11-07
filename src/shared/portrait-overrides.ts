import { Schema } from "effect";
import { PORTRAIT_FACE_OPTIONS } from "./agent-portrait";

// Per-seat portrait overrides (the character editor's output), stored one row
// per seat in junto.db `portrait_overrides`. Traits are bounded plain strings
// and the renderer resolves each against today's options, falling back to
// the identity default, so an option a later build retires never makes a row
// unreadable. This normalizer is the one gate for both the IPC input and the
// stored rows: it keeps known fields of the right shape and drops the rest.

const TRAIT_KEYS = ["bodyHue", "accentHue", "shape", "topper", "marking", "accessory"] as const;
// The face traits are closed lists the editor offers; one outside them is dropped.
const FACE_TRAITS = {
  eyes: PORTRAIT_FACE_OPTIONS.eyes,
  mouth: PORTRAIT_FACE_OPTIONS.mouth,
  brows: PORTRAIT_FACE_OPTIONS.brows,
} as const;
// A trait is a base id ("toast") or a pack item ("<pack>:<item>").
const TRAIT_MAX = 72;

/** Longest seat identity (a canvas node id). */
export const PORTRAIT_SEAT_ID_MAX = 1024;

/**
 * One seat's overrides. Every field is optional; absent means the identity
 * default. The face traits are closed lists, the catalog traits are plain
 * ids the renderer resolves, and nothing else is kept.
 */
export const PortraitOverride = Schema.Struct({
  bodyHue: Schema.optionalKey(Schema.String),
  accentHue: Schema.optionalKey(Schema.String),
  shape: Schema.optionalKey(Schema.String),
  topper: Schema.optionalKey(Schema.String),
  eyes: Schema.optionalKey(Schema.Literals(FACE_TRAITS.eyes)),
  mouth: Schema.optionalKey(Schema.Literals(FACE_TRAITS.mouth)),
  brows: Schema.optionalKey(Schema.Literals(FACE_TRAITS.brows)),
  marking: Schema.optionalKey(Schema.String),
  accessory: Schema.optionalKey(Schema.String),
  blush: Schema.optionalKey(Schema.Boolean),
  temperament: Schema.optionalKey(Schema.Number),
});
export type PortraitOverride = typeof PortraitOverride.Type;

/** Seat id -> override, as the renderer holds it. */
export const PortraitOverrides = Schema.Record(Schema.String, PortraitOverride);
export type PortraitOverrides = typeof PortraitOverrides.Type;

export const PortraitOverrideSetResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), seatId: Schema.String, override: Schema.NullOr(PortraitOverride) }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
export type PortraitOverrideSetResult = typeof PortraitOverrideSetResult.Type;

/** Main -> renderer: one seat's override as it now stands (null is reset). */
export type PortraitOverrideEvent = {
  readonly seatId: string;
  readonly override: PortraitOverride | null;
};

export const isPortraitSeatId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= PORTRAIT_SEAT_ID_MAX;

/** A seat identity as a call names it: the same bound `isPortraitSeatId` holds. */
export const PortraitSeatId = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => isPortraitSeatId(value) || "portrait seat id is invalid")),
);

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
  for (const key of ["eyes", "mouth", "brows"] as const) {
    const trait = input[key];
    const options: ReadonlyArray<string> = FACE_TRAITS[key];
    if (typeof trait === "string" && options.includes(trait)) out[key] = trait;
  }
  if (typeof input.blush === "boolean") out.blush = input.blush;
  const temperament = input.temperament;
  if (typeof temperament === "number" && Number.isFinite(temperament) && temperament >= -1 && temperament <= 1) {
    out.temperament = temperament;
  }
  return Object.keys(out).length > 0 ? (out as PortraitOverride) : null;
}
