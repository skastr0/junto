/**
 * DesiredFile transport for packager-embed install.
 *
 * Do not fork packager types — re-export the source of truth and expose a thin
 * Effect Schema for IPC / ledger boundaries.
 */

import type { DesiredFile as PackagerDesiredFile } from "@skastr0/prism-packager";
import { Schema } from "effect";

/** Packager DesiredFile — path + content + optional mode. */
export type DesiredFile = PackagerDesiredFile;

/**
 * Wire schema for DesiredFile. `plugin` is diagnostic attribution from the
 * packager lowerers; treat as opaque string at the transport edge.
 */
export const DesiredFileSchema = Schema.Struct({
  targetPath: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  content: Schema.String,
  mode: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 0o7777))),
  plugin: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
});

export type DesiredFileWire = typeof DesiredFileSchema.Type;

export const decodeDesiredFile = Schema.decodeUnknown(DesiredFileSchema);
export const encodeDesiredFile = Schema.encode(DesiredFileSchema);

/** One apply-layer operation after attempting to write a DesiredFile. */
export type ApplyOperationType = "write" | "skip";

export type ApplyOperation = {
  readonly type: ApplyOperationType;
  readonly path: string;
  readonly reason: string;
};

export type ApplyReceipt = {
  readonly operations: ReadonlyArray<ApplyOperation>;
  readonly applied: number;
  readonly skipped: number;
};
