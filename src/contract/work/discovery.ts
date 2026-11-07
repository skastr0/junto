/**
 * The work socket's discovery ops, as one Effect `RpcGroup`: what a seat
 * reads of itself and raises to the operator. Owned by cli-performance.
 *
 * Each op's tag is its v1 name, its arguments the payload, its answer the
 * success and `WorkFailure` the error, as `src/contract/work/msg.ts` writes
 * them. The core serves the group (`src/core/work-control/discovery.ts`) and
 * the CLI calls it, so a change to an op's arguments or answer fails the
 * compile of both.
 *
 * ping and doctor are not here: they answer before the work server reads the
 * caller's canvas, so a seat whose canvas is closed still hears them, and a
 * call this group serves always carries its canvas.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { MachineLogRead } from "../../shared/machine-log";
import { OpListArgs, OpShowArgs } from "../../shared/op-control";
import { SeatEnvironmentReport } from "../../shared/region-environment";
import { RefusalReason } from "../../shared/resource-command";
import { AgentSignal } from "../../shared/wire/agent-signals";
import {
  EnvReportArgs,
  LogsReadArgs,
  SignalClearArgs,
  SignalListArgs,
  SignalListResult,
  SignalRaiseArgs,
  SinceArgs,
  WorkErrorBody,
} from "../../shared/work-control";
import { OpId } from "../../shared/work-ids";
import { WorkFailure, WorkInputHint } from "./failure";

const applied = { disposition: Schema.Literal("applied") };

export const SignalRaiseAnswer = Schema.Struct({ signal: AgentSignal, ...applied, next_step: Schema.String });

/** The signals withdrawn: one by its id, or every open one. */
export const SignalClearAnswer = Schema.Struct({ signals: Schema.Array(AgentSignal), ...applied });

/** Why a queued write reads at risk, as the overlay ruled it. */
export const OpRefusal = Schema.Struct({
  reason: RefusalReason,
  message: Schema.String,
  expected: Schema.optionalKey(Schema.Unknown),
  next_step: Schema.optionalKey(Schema.String),
});

/** What this machine reads of a queued write over its ruled state. */
export const OpOverlay = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("at_risk"), refusal: OpRefusal }),
  Schema.Struct({ status: Schema.Literal("at_risk"), waiting: Schema.Literal("base_not_pulled"), root: OpId }),
]);

/** One write as `op show` prints it: queued with its overlay, applied with what it made, or refused. */
export const OpView = Schema.Union([
  Schema.Struct({ state: Schema.Literal("queued"), opId: OpId, overlay: Schema.optionalKey(OpOverlay) }),
  Schema.Struct({ state: Schema.Literal("applied"), opId: OpId, made: Schema.Record(Schema.String, Schema.Unknown) }),
  Schema.Struct({ state: Schema.Literal("refused"), opId: OpId, error: WorkErrorBody, root: OpId }),
]);

export const OpShowAnswer = Schema.Struct({ op: OpView });

export const OpListAnswer = Schema.Struct({ ops: Schema.Array(OpView), more: Schema.Boolean });

/** One since section: a sentence and an id per line, and how to list the rest. */
const SinceSection = Schema.optionalKey(
  Schema.Struct({
    lines: Schema.Array(Schema.String),
    more: Schema.optionalKey(Schema.Number),
    list: Schema.optionalKey(Schema.String),
  }),
);

/** Since this seat's last session, as onboard and `junto since` print it; a section with nothing in it is left out. */
export const SinceAnswer = Schema.Struct({
  as_of: Schema.String,
  unread: Schema.Number,
  owed_replies: SinceSection,
  awaiting_replies: SinceSection,
  open_signals: SinceSection,
  answers_since: SinceSection,
  your_tasks: SinceSection,
  reviews_owed: SinceSection,
});

export const SignalRaise = Rpc.make("signal.raise", { payload: SignalRaiseArgs, success: SignalRaiseAnswer, error: WorkFailure });
export const SignalClear = Rpc.make("signal.clear", { payload: SignalClearArgs, success: SignalClearAnswer, error: WorkFailure });
export const SignalList = Rpc.make("signal.list", { payload: SignalListArgs, success: SignalListResult, error: WorkFailure });
/** op show and op list refuse their arguments in the schema's words, and point at their own schema. */
const OP_INPUT_HINT = "junto schema show shows this command's input";
export const OpShow = Rpc.make("op.show", { payload: OpShowArgs, success: OpShowAnswer, error: WorkFailure }).annotate(WorkInputHint, OP_INPUT_HINT);
export const OpList = Rpc.make("op.list", { payload: OpListArgs, success: OpListAnswer, error: WorkFailure }).annotate(WorkInputHint, OP_INPUT_HINT);
export const EnvReport = Rpc.make("env.report", { payload: EnvReportArgs, success: SeatEnvironmentReport, error: WorkFailure });
export const LogsRead = Rpc.make("logs.read", { payload: LogsReadArgs, success: MachineLogRead, error: WorkFailure });
export const Since = Rpc.make("since", { payload: SinceArgs, success: SinceAnswer, error: WorkFailure });

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const DiscoveryRpcs = RpcGroup.make(SignalRaise, SignalClear, SignalList, OpShow, OpList, EnvReport, LogsRead, Since).annotateRpcs(
  Rpc.ParseOptions,
  { onExcessProperty: "error" },
);
