/**
 * The window's seat calls, answered in the core (`src/core/ops/ipc-seats.ts`):
 * the region environment's report, secrets and out-of-date seats, the pause
 * plane's state and set, the operator's prompt to a managed seat, the
 * operator's offboard ask and where each offboard stands, and the onboarding
 * nudge.
 *
 * Main decodes what the window sends at its own edge
 * (`src/app/seats/seats-ipc.ts`), so every payload here is already typed.
 * Every answer is plain data the window reads, a refusal in the operator's
 * words included; the one failure a call can have is `RpcClientError`, the
 * core leaving before it answered.
 *
 * The answers that `src/shared/ipc.ts`, `src/shared/seat-onboarding-status.ts`,
 * `src/shared/region-environment.ts` and `src/core/work/seat-prompt.ts` name
 * as TypeScript types are Schemas here; the handlers and main's callers fail
 * to compile when the two drift.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { CanvasPauseState } from "../../shared/pause";
import { SourceReport } from "../../shared/region-environment";
import { isSeatGuidanceSeatId } from "../../shared/seat-guidance";
import { OFFBOARD_MODES, SeatOffboardAskResult, SeatOffboardProgress } from "../../shared/seat-sessions";
import { coreClient } from "./link";

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** A seat's canvas node id, as seat guidance bounds it. */
export const SeatId = Schema.String.pipe(
  Schema.check(Schema.makeFilter((raw: string) => isSeatGuidanceSeatId(raw) || "a seat's node id")),
);

/** A refusal is a sentence for the operator, never a throw. */
const Refused = Schema.Struct({ ok: Schema.Literal(false), message: Schema.String });

/** A running seat whose launch environment differs from the current resolution: names only, never values. */
export const StaleSeat = Schema.Struct({
  seatId: Schema.String,
  title: Schema.String,
  changed: Schema.Array(Schema.String),
});

export const RegionEnvReportResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), report: Schema.Array(SourceReport) }),
  Refused,
]);
export const RegionEnvStaleSeatsResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), seats: Schema.Array(StaleSeat) }),
  Refused,
]);

/** What the region screen sends to save: the value crosses once, and the answer is only its id. */
export const RegionEnvSaveSecretInput = Schema.Struct({
  /** The region the source lives in. Context only; not stored. */
  regionId: Schema.String,
  /** The variable name. Context only; not a key. */
  name: Schema.String,
  value: Schema.String,
  /** Present: replace the value behind this id. Absent: mint a new id. */
  secretId: Schema.optionalKey(Schema.String),
});
export const RegionEnvSaveSecretResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), secretId: Schema.String }),
  Refused,
]);
export const RegionEnvRemoveSecretResult = Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Refused]);

/** A pause write is SQLite-first: `ok` carries the fresh state, a refusal changed nothing and says why. */
export const FactoryPauseSetResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), state: CanvasPauseState }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

/** The operator's prompt to a managed seat, as the window sends it; the core checks each field again. */
export const SeatPromptInput = Schema.Struct({
  bindingId: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  canvasName: Schema.optionalKey(Schema.String),
  nodeId: Schema.optionalKey(Schema.String),
  /** False keeps a down seat down; the prompt waits in its mailbox. */
  wake: Schema.optionalKey(Schema.Boolean),
});
export const SeatPromptResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), disposition: Schema.Literals(["submitted", "queued"]), messageId: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(false),
    disposition: Schema.Literal("failed"),
    messageId: Schema.optionalKey(Schema.String),
    error: Schema.String,
  }),
]);

export const SeatOnboardNudgeResult = Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Refused]);

const RegionTarget = { canvasName: Schema.String, regionId: Schema.String };

export const SeatsRpcs = RpcGroup.make(
  Rpc.make("SeatsRegionEnvReport", { payload: RegionTarget, success: RegionEnvReportResult }),
  Rpc.make("SeatsRegionEnvStaleSeats", { payload: RegionTarget, success: RegionEnvStaleSeatsResult }),
  /** The secret store opens in the core, the one process that reads it for a seat's launch. */
  Rpc.make("SeatsRegionEnvSaveSecret", {
    payload: { value: Schema.String, secretId: Schema.optionalKey(Schema.String) },
    success: RegionEnvSaveSecretResult,
  }),
  Rpc.make("SeatsRegionEnvRemoveSecret", { payload: { secretId: Schema.String }, success: RegionEnvRemoveSecretResult }),
  Rpc.make("SeatsFactoryPauseState", { payload: { canvas: Schema.String }, success: CanvasPauseState }),
  Rpc.make("SeatsFactoryPauseSet", { payload: { canvas: Schema.String, paused: Schema.Boolean }, success: FactoryPauseSetResult }),
  Rpc.make("SeatsManagedPrompt", { payload: { input: SeatPromptInput }, success: SeatPromptResult }),
  Rpc.make("SeatsOffboardProgress", { success: Schema.Array(SeatOffboardProgress) }),
  /** The operator asks from the seat; the agent writes its notes and the core's closer ends the session in its mode. */
  Rpc.make("SeatsOffboardAsk", {
    payload: { canvasName: NonEmpty, seatId: SeatId, mode: Schema.Literals(OFFBOARD_MODES) },
    success: SeatOffboardAskResult,
  }),
  Rpc.make("SeatsOnboardNudge", { payload: { canvasName: NonEmpty, seatId: NonEmpty }, success: SeatOnboardNudgeResult }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the seats group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SeatsCore extends Context.Service<SeatsCore, RpcClient.FromGroup<typeof SeatsRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/SeatsCore",
) {
  static readonly layer = Layer.effect(SeatsCore, coreClient(SeatsRpcs));
}
