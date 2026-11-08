/**
 * What the core says when a seat's generation credential is published or
 * revoked: the push `seatCredential.changed`, which main's browser grants
 * read (app/browser/seat-credentials-ipc.ts). The core's registry
 * (core/work/seat-credentials.ts) and its process principals
 * (core/process-identity.ts) take their types from here.
 */
import { Schema } from "effect";

/**
 * One principal. There is one actor kind, so there is one principal shape:
 * no discriminant, and every anchor optional but at least one required by
 * `bind` (core/process-identity.ts).
 */
export const ProcessPrincipal = Schema.Struct({
  /** Agent key (`local:profile`) of the seat this process belongs to. */
  agentKey: Schema.optionalKey(Schema.String),
  /** Stable managed-terminal binding for the seat. */
  bindingId: Schema.optionalKey(Schema.String),
  /** Optional canvas anchor when known at bind time. */
  canvasName: Schema.optionalKey(Schema.String),
  nodeId: Schema.optionalKey(Schema.String),
});
export type ProcessPrincipal = typeof ProcessPrincipal.Type;

export const SeatCredentialEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("published"), principal: ProcessPrincipal, generationId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("revoked"), principal: ProcessPrincipal, generationId: Schema.String }),
]);
export type SeatCredentialEvent = typeof SeatCredentialEvent.Type;
