/**
 * App-owned canvas authority contract.
 *
 * Documents live under content-addressed objects; `current.json` is the sole
 * commit pointer. This is the product durability store.
 */

import { Schema } from "effect";

export const CANVAS_AUTHORITY_SCHEMA = "vellum/canvas-authority/v1" as const;
export const CANVAS_AUTHORITY_POINTER_SCHEMA =
  "vellum/canvas-authority-pointer/v1" as const;

/** Decimal uint64 generation string — compare with BigInt, never Number. */
export const AuthorityGeneration = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9][0-9]*)$/),
  Schema.maxLength(32),
);
export type AuthorityGeneration = typeof AuthorityGeneration.Type;

export const Sha256Hex = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
);
export type Sha256Hex = typeof Sha256Hex.Type;

export const CanvasAuthorityDocumentEntry = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  bytes: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  sha256: Sha256Hex,
});
export type CanvasAuthorityDocumentEntry =
  typeof CanvasAuthorityDocumentEntry.Type;

export const CanvasAuthorityManifestV1 = Schema.Struct({
  schema: Schema.Literal(CANVAS_AUTHORITY_SCHEMA),
  generation: AuthorityGeneration,
  createdAt: Schema.String,
  intentSha256: Sha256Hex,
  documents: Schema.Array(CanvasAuthorityDocumentEntry).pipe(
    Schema.maxItems(256),
  ),
});
export type CanvasAuthorityManifestV1 = typeof CanvasAuthorityManifestV1.Type;

export const CanvasAuthorityPointerV1 = Schema.Struct({
  schema: Schema.Literal(CANVAS_AUTHORITY_POINTER_SCHEMA),
  generation: AuthorityGeneration,
  manifestSha256: Sha256Hex,
  intentSha256: Sha256Hex,
});
export type CanvasAuthorityPointerV1 = typeof CanvasAuthorityPointerV1.Type;

/** Compare decimal generation strings with BigInt ordering. */
export const compareAuthorityGeneration = (
  left: string,
  right: string,
): number => {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
