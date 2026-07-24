/**
 * Station projection v1 — complete Command Center → Station intent frame.
 *
 * Beta scope is `full-canvas-set` only: one generation replaces the previous
 * complete canvas document set. Delivery (CC push / Remote pull of frames) is
 * a later lane; this module freezes the on-wire and on-disk contract.
 *
 * Integrity: SHA-256 of exact bytes only (no HMAC secret in beta).
 */

import { Schema } from "effect";

export const STATION_PROJECTION_SCHEMA = "vellum/station-projection/v1" as const;
export const STATION_PROJECTION_POINTER_SCHEMA =
  "vellum/station-projection-pointer/v1" as const;
export const STATION_PROJECTION_SCOPE = "full-canvas-set" as const;

/**
 * On-wire frame magic (ASCII, trailing newline included).
 * Layout: magic + uint32-be(manifestLen) + manifestUtf8 + docs in order.
 */
export const STATION_PROJECTION_FRAME_MAGIC =
  "VELLUM-STATION-PROJECTION/1\n" as const;

/** Decimal uint64 generation string — compare with BigInt, never Number. */
export const ProjectionGeneration = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9][0-9]*)$/),
  Schema.maxLength(32),
);
export type ProjectionGeneration = typeof ProjectionGeneration.Type;

export const Sha256Hex = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export type Sha256Hex = typeof Sha256Hex.Type;

export const StationProjectionDocumentEntry = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  bytes: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sha256: Sha256Hex,
});
export type StationProjectionDocumentEntry =
  typeof StationProjectionDocumentEntry.Type;

/**
 * Complete-generation manifest. `commandCenterWitness` / `targetWitness` are
 * opaque SHA-256 hex bindings of the producing CC seat and intended Remote
 * seat (see station-witness domain hashing on the product side).
 */
export const StationProjectionManifestV1 = Schema.Struct({
  schema: Schema.Literal(STATION_PROJECTION_SCHEMA),
  scope: Schema.Literal(STATION_PROJECTION_SCOPE),
  generation: ProjectionGeneration,
  createdAt: Schema.String,
  commandCenterWitness: Sha256Hex,
  targetWitness: Sha256Hex,
  /** Length-prefixed intent over sorted name + body hashes. */
  intentSha256: Sha256Hex,
  documents: Schema.Array(StationProjectionDocumentEntry).pipe(
    Schema.maxItems(256),
  ),
});
export type StationProjectionManifestV1 = typeof StationProjectionManifestV1.Type;

/** Durable pointer at `~/.vellum/projections/station/current.json`. */
export const StationProjectionPointerV1 = Schema.Struct({
  schema: Schema.Literal(STATION_PROJECTION_POINTER_SCHEMA),
  generation: ProjectionGeneration,
  frameSha256: Sha256Hex,
  manifestSha256: Sha256Hex,
  intentSha256: Sha256Hex,
});
export type StationProjectionPointerV1 = typeof StationProjectionPointerV1.Type;

/** Compare decimal generation strings with BigInt ordering. */
export const compareProjectionGeneration = (
  left: string,
  right: string,
): number => {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
