import { Schema } from "effect";
import { WorkAttentionRow } from "./work-sinks";

/** Complete sink counts, independent of the visible content page. */
export const WorkSinkGlance = Schema.Struct({
  nodeId: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  needsHuman: Schema.Boolean,
  allTerminal: Schema.Boolean,
  inputRequired: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  authRequired: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorkSinkGlance = typeof WorkSinkGlance.Type;

export const WorkAttentionSnapshot = Schema.Struct({
  glances: Schema.Array(WorkSinkGlance),
  items: Schema.Array(WorkAttentionRow),
});
export type WorkAttentionSnapshot = typeof WorkAttentionSnapshot.Type;

export const emptySinkGlance = (nodeId: string): WorkSinkGlance => ({
  nodeId, count: 0, needsHuman: false, allTerminal: true,
  inputRequired: 0, authRequired: 0,
});
