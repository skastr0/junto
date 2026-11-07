/**
 * The auto cache mode's question and the operator's offboard buttons, for the
 * window (seat-sessions/operator-offboard-ipc.ts), answered where the seats
 * and their views run: the seats this machine runs, and those a linked machine
 * asked on a view here. Main decodes the window's input closed at its edge;
 * the core holds every rule. A refusal is a row or a `{ ok: false }` the
 * window shows, an answer, so none of these has an error to act on beyond the
 * core leaving.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { CACHE_QUESTION_PATTERN, SEAT_CACHE_DUE_ANSWERS } from "../../shared/seat-cache-due";
import { OFFBOARD_REFUSAL_CODES, SEAT_OFFBOARD_ACTIONS } from "../../shared/seat-offboard";
import { OFFBOARD_MODES } from "../../shared/seat-sessions";
import { coreClient } from "./link";

/** A name a seat or canvas goes by, as the core reads one. */
const Name = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));

/** A seat due the question (shared/seat-cache-due.ts, which the preload reads, so it holds no Schema). */
export const SeatCacheDue = Schema.Struct({
  canvasName: Schema.String,
  seatId: Schema.String,
  question: Schema.String,
  windowEndsAt: Schema.Number,
  tokens: Schema.optional(Schema.Number),
});

/** The window's answer, closed: these fields only, the question by its own pattern. */
export const SeatCacheDueAnswerInput = Schema.Struct({
  canvasName: Name,
  seatId: Name,
  question: Schema.String.pipe(Schema.check(Schema.isPattern(CACHE_QUESTION_PATTERN))),
  answer: Schema.Literals(SEAT_CACHE_DUE_ANSWERS),
});

export const SeatCacheDueAnswerResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

/** The offboard buttons' run: one action on one seat or many. */
export const SeatOffboardRunInput = Schema.Struct({
  canvasName: Schema.String,
  seatIds: Schema.Array(Schema.String),
  action: Schema.Literals(SEAT_OFFBOARD_ACTIONS),
  mode: Schema.optional(Schema.Literals(OFFBOARD_MODES)),
});

const RefusalCode = Schema.Literals(OFFBOARD_REFUSAL_CODES);

export const SeatOffboardRunRow = Schema.Union([
  Schema.Struct({
    seatId: Schema.String,
    title: Schema.optional(Schema.String),
    ok: Schema.Literal(true),
    action: Schema.Literals(SEAT_OFFBOARD_ACTIONS),
    outcome: Schema.Literals(["asked", "closed"]),
    pastWindow: Schema.Boolean,
  }),
  Schema.Struct({
    seatId: Schema.String,
    title: Schema.optional(Schema.String),
    ok: Schema.Literal(false),
    code: RefusalCode,
    reason: Schema.String,
    pastWindow: Schema.optional(Schema.Boolean),
  }),
]);

export const SeatOffboardRunResult = Schema.Struct({
  results: Schema.Array(SeatOffboardRunRow),
  closed: Schema.Number,
  asked: Schema.Number,
  refused: Schema.Number,
});

/** What a seat's offboard buttons say before they are pressed. */
export const SeatOffboardStatus = Schema.Struct({
  seatId: Schema.String,
  now: Schema.Union([
    Schema.Struct({ allowed: Schema.Literal(true) }),
    Schema.Struct({ allowed: Schema.Literal(false), code: RefusalCode, reason: Schema.String }),
  ]),
  stillSince: Schema.optional(Schema.Number),
  idleMinutes: Schema.NullOr(Schema.Number),
  pastWindow: Schema.Boolean,
  preferred: Schema.Literals(SEAT_OFFBOARD_ACTIONS),
  workMinutes: Schema.optional(Schema.Number),
  sessionTokens: Schema.optional(Schema.Number),
  worthCutting: Schema.optional(Schema.Boolean),
});

/** Which seats of one canvas the buttons ask about. */
export const SeatOffboardStatusAsk = Schema.Struct({ canvasName: Schema.String, seatIds: Schema.Array(Schema.String) });

export const SeatCacheDueRpcs = RpcGroup.make(
  Rpc.make("SeatCacheDueList", { success: Schema.Array(SeatCacheDue) }),
  Rpc.make("SeatCacheDueAnswer", { payload: { input: SeatCacheDueAnswerInput }, success: SeatCacheDueAnswerResult }),
  /** The operator's run, as the overseer and the automatic rules go through it (seat-sessions/operator-offboard.ts). */
  Rpc.make("SeatCacheDueOffboardRun", { payload: { input: SeatOffboardRunInput }, success: SeatOffboardRunResult }),
  Rpc.make("SeatCacheDueOffboardStatus", { payload: SeatOffboardStatusAsk, success: Schema.Array(SeatOffboardStatus) }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the cache question and the offboard buttons. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class SeatCacheDueCore extends Context.Service<
  SeatCacheDueCore,
  RpcClient.FromGroup<typeof SeatCacheDueRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/SeatCacheDueCore") {
  static readonly layer = Layer.effect(SeatCacheDueCore, coreClient(SeatCacheDueRpcs));
}
