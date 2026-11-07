/**
 * The window's seat-awareness reads, answered by the core (junto/ipc.ts).
 *
 * The plane and the seats it reads live in the core process, so main asks for
 * the snapshot and for the collaboration gate rather than owning a plane it
 * cannot feed. One call answers both: the enabled check is the same snapshot
 * the renderer hydrates from, so the two cannot disagree. Its events are the
 * wire shape of `src/shared/seat-awareness-contract.ts`, which the renderer
 * decodes strictly again at its own edge.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { ThreadHealthReading } from "../../shared/wire/thread-health";
import {
  SEAT_AWARENESS_ACTIVITIES,
  SEAT_AWARENESS_CONCERNS,
  SEAT_AWARENESS_PUBLISHED_AVAILABILITIES,
  SEAT_AWARENESS_UNAVAILABLE_REASONS,
} from "../../shared/seat-awareness-contract";
import { coreClient } from "./link";

const Concern = Schema.Literals(SEAT_AWARENESS_CONCERNS);

/** The bounded evidence window an observation was made against, its lines tagged by id. */
const EvidenceWindow = Schema.Struct({
  digest: Schema.String,
  capturedAt: Schema.Number,
  lines: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
});

/** One observation: a judgment, an abstention, or an honest failure. */
export const SeatAwarenessAssessment = Schema.Struct({
  bindingId: Schema.String,
  assessmentId: Schema.String,
  availability: Schema.Literals(SEAT_AWARENESS_PUBLISHED_AVAILABILITIES),
  observedAt: Schema.Number,
  activity: Schema.NullOr(Schema.Literals(SEAT_AWARENESS_ACTIVITIES)),
  concerns: Schema.Array(Concern),
  absences: Schema.optional(Schema.Array(Schema.Struct({ concern: Concern, probability: Schema.Number }))),
  unansweredConcerns: Schema.optional(Schema.Array(Concern)),
  evidence: EvidenceWindow,
  selectedLineId: Schema.NullOr(Schema.String),
  unavailableReason: Schema.NullOr(Schema.Literals(SEAT_AWARENESS_UNAVAILABLE_REASONS)),
  health: Schema.optional(ThreadHealthReading),
});

/** The evidence window moved, or a new observation landed. */
export const SeatAwarenessEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("window"),
    bindingId: Schema.String,
    windowDigest: Schema.String,
    windowCapturedAt: Schema.Number,
    at: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("assessment"),
    assessment: SeatAwarenessAssessment,
    windowDigest: Schema.String,
    at: Schema.Number,
  }),
]);

/** The live gate, and the latest event per binding for the window's hydration. */
export const SeatAwarenessSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  events: Schema.Array(SeatAwarenessEvent),
});

export const SeatAwarenessRpcs = RpcGroup.make(
  Rpc.make("SeatAwarenessSnapshot", { success: SeatAwarenessSnapshot }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the awareness reads. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SeatAwarenessCore extends Context.Service<
  SeatAwarenessCore,
  RpcClient.FromGroup<typeof SeatAwarenessRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SeatAwarenessCore") {
  static readonly layer = Layer.effect(SeatAwarenessCore, coreClient(SeatAwarenessRpcs));
}
