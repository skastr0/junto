import { Schema } from "effect";

const Id = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)));
const Revision = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

/** Correlation constrains a process-admitted command. None of these fields grants authority. */
export const OverseerLiveCorrelation = Schema.Struct({
  sessionId: Id,
  requestId: Id,
  intentRevision: Revision,
  operationId: Id,
  expectedRevision: Schema.optionalKey(Id),
});
export type OverseerLiveCorrelation = typeof OverseerLiveCorrelation.Type;

export const OverseerHostEvent = Schema.Struct({
  type: Schema.Literals(["accepted", "progress", "completed", "cancelled", "failed"]),
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(32_000))),
  /** Full Responses conversation, retained only by the main-owned durable journal. */
  conversation: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
export type OverseerHostEvent = typeof OverseerHostEvent.Type;

export const OverseerHostRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("next"), sessionId: Schema.optionalKey(Id) }),
  Schema.Struct({
    type: Schema.Literal("event"), sessionId: Id, requestId: Id,
    intentRevision: Revision, event: OverseerHostEvent,
  }),
  Schema.Struct({ type: Schema.Literal("steer"), sessionId: Id, requestId: Id, intentRevision: Revision,
    targetRequestId: Id, text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32_000))) }),
  Schema.Struct({ type: Schema.Literal("cancel-request"), sessionId: Id, requestId: Id, intentRevision: Revision, targetRequestId: Id }),
  Schema.Struct({ type: Schema.Literal("stop-actions"), sessionId: Id, requestId: Id, intentRevision: Revision }),
]);
export type OverseerHostRequest = typeof OverseerHostRequest.Type;

export const OverseerHostAssignment = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("cancel"), requestId: Id, intentRevision: Revision }),
  Schema.Struct({
    type: Schema.Literal("run"), sessionId: Id, requestId: Id,
    intentRevision: Revision, model: Id,
    /** Private, process-authenticated delivery only; never log or persist this assignment. */
    apiKey: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    instructions: Schema.String,
    context: Schema.String,
    conversation: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    operationIds: Schema.Array(Id).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
    expectedRevision: Schema.optionalKey(Id),
    maxSteps: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 32 })))),
  }),
]);
export type OverseerHostAssignment = typeof OverseerHostAssignment.Type;
export type OverseerHostRun = Extract<OverseerHostAssignment, { readonly type: "run" }>;

export const decodeOverseerHostRequest = Schema.decodeUnknownResult(OverseerHostRequest, { onExcessProperty: "error" });
export const decodeOverseerHostAssignment = Schema.decodeUnknownResult(OverseerHostAssignment, { onExcessProperty: "error" });
