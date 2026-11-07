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
  LogsReadArgs,
  SignalClearArgs,
  SignalListArgs,
  SignalListResult,
  SignalRaiseArgs,
  EmptyArgs,
  EnvReportArgs,
  OffboardArgs,
  SinceArgs,
  WorkErrorBody,
} from "../../shared/work-control";
import { OpId } from "../../shared/work-ids";
import { BriefingMentions } from "../../shared/briefing-mentions";
import { HarnessId, IsolationSpec, MailTransportSpec } from "../../shared/managed-terminal-templates";
import { FactoryRole, Port } from "../../shared/physics/schema";
import { PortraitOverride } from "../../shared/portrait-overrides";
import { Ruling } from "../../shared/work-model";
import { SeatRegion } from "./msg";
import { OFFBOARD_MODES } from "../../shared/seat-sessions";
import { WorkFailure, WorkInputHint, WorkInputRefusal } from "./failure";

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

/** A node as a seat sees it: its id, its kind and its title. */
export const VisibleNode = Schema.Struct({ id: Schema.String, kind: Schema.optional(Schema.String), title: Schema.String });

/** A managed harness on this machine: whether it is installed, and how it takes mail and keeps its home. */
export const HarnessInstall = Schema.Struct({
  harness: HarnessId,
  displayName: Schema.String,
  binary: Schema.String,
  installed: Schema.Boolean,
  executable: Schema.optional(Schema.String),
  mailTransport: MailTransportSpec,
  isolation: IsolationSpec,
});

/** A seat tool: its command, what it does, and the input it takes. */
export const SeatTool = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  description: Schema.String,
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const overseer = { overseer: Schema.Struct({ enabled: Schema.Boolean, affectedByPause: Schema.Literal(false) }) };

/** A paused seat reads, and is told to wait for the operator. */
const pause = { paused: Schema.Boolean, next_step: Schema.optionalKey(Schema.String) };

/** A seat wired to this one: who it is, and the ports this seat holds over the edge. */
const connectedSeat = {
  ...VisibleNode.fields,
  name: Schema.String,
  regions: Schema.Array(SeatRegion),
  role: FactoryRole,
  grants: Schema.Array(Port),
};

/** A node sharing a region with this seat, and the innermost region they share. */
export const CoMember = Schema.Struct({
  ...VisibleNode.fields,
  name: Schema.String,
  regions: Schema.Array(SeatRegion),
  shared_region: SeatRegion,
});

export const CapabilitiesAnswer = Schema.Struct({
  node: VisibleNode,
  harnesses: Schema.Array(HarnessInstall),
  role: FactoryRole,
  tools: Schema.Array(SeatTool),
  ...overseer,
  protocol_version: Schema.String,
  connected: Schema.Array(Schema.Struct({ ...connectedSeat, summary: Schema.String })),
  co_members: Schema.Array(CoMember),
  ...pause,
});

/** A connected node's board: what it stands for, how many rules it carries, and where work goes next. */
const boardBriefing = {
  board: Schema.optionalKey(Schema.Struct({ name: Schema.String, namingHint: Schema.optionalKey(Schema.String) })),
  contract: Schema.optionalKey(
    Schema.Struct({
      instructions: Schema.optionalKey(Schema.String),
      incomingHandling: Schema.optionalKey(Schema.String),
      incomingDescription: Schema.optionalKey(Schema.String),
      outgoingHandoff: Schema.optionalKey(Schema.String),
      outgoingDescription: Schema.optionalKey(Schema.String),
      rules: Schema.Number,
    }),
  ),
  next: Schema.optionalKey(
    Schema.Array(Schema.Struct({ board: Schema.String, name: Schema.String, description: Schema.optionalKey(Schema.String) })),
  ),
};

/** The commands one connection family allows: `<target>` stands for any id in `targets`. */
export const ConnectionCommands = Schema.Struct({
  family: Schema.String,
  targets: Schema.Array(Schema.String),
  commands: Schema.Record(Schema.String, Schema.String),
  note: Schema.String,
  more: Schema.String,
});

/** One resource kind in this seat's reach, with every command its kind allows. */
const ResourceReach = Schema.Struct({
  kind: Schema.Literals(["task", "artifacts"]),
  count: Schema.Number,
  targets: Schema.Array(Schema.String),
  list: Schema.String,
  commands: Schema.Record(Schema.String, Schema.String),
  note: Schema.String,
  more: Schema.String,
});

/** The Files nodes in reach: a folder's root only on the machine that holds it. */
const FilesReach = Schema.Struct({
  kind: Schema.Literal("files"),
  count: Schema.Number,
  targets: Schema.Array(Schema.String),
  folders: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, root: Schema.optionalKey(Schema.String) })),
  note: Schema.String,
  more: Schema.String,
});

/** The seat as the operator configured it: name, harness and launch dials, look, soul and instructions. */
export const SeatConfiguration = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  harness: Schema.String,
  harness_profile: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  look: Schema.optionalKey(PortraitOverride),
  soul: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
});

/** A reference in this seat's scope, by name: never its body. */
const ReferenceListing = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  scope: Schema.Literals(["app", "region"]),
  region: Schema.optionalKey(Schema.Struct({ id: Schema.String, label: Schema.String })),
  read: Schema.String,
});

/** A session's transcript, or a plain line on why it has none, and what became of its process. */
const transcript = {
  transcript_path: Schema.NullOr(Schema.String),
  transcript_missing: Schema.optionalKey(Schema.String),
};
const windDown = { wind_down: Schema.optionalKey(Schema.String), transcript_caution: Schema.optionalKey(Schema.String) };

/** This seat's sessions: the current one, the last one before it, and a count of the earlier ones. */
const PastSessions = Schema.Struct({
  note: Schema.String,
  current: Schema.NullOr(
    Schema.Struct({
      session_id: Schema.String,
      harness: Schema.String,
      transcript_path: Schema.NullOr(Schema.String),
      offboarded: Schema.Boolean,
    }),
  ),
  last: Schema.NullOr(
    Schema.Struct({
      session_id: Schema.String,
      harness: Schema.String,
      started_at: Schema.optional(Schema.String),
      ended_at: Schema.optionalKey(Schema.optional(Schema.String)),
      ended_because: Schema.optional(Schema.String),
      closed: Schema.optionalKey(Schema.String),
      gist: Schema.optionalKey(Schema.String),
      notes_in: Schema.optionalKey(Schema.Literal("handoff")),
      notes: Schema.optionalKey(Schema.String),
      ...transcript,
      wind_down: Schema.optionalKey(Schema.String),
    }),
  ),
  earlier: Schema.Number,
});

/** The note the previous session left for this one, when it continued rather than rested. */
const Handoff = Schema.Struct({
  note: Schema.String,
  from_session: Schema.String,
  left_at: Schema.optional(Schema.String),
  continuation: Schema.String,
  gist: Schema.NullOr(Schema.String),
  notes: Schema.optionalKey(Schema.String),
  ...transcript,
  ...windDown,
});

/** The previous session ended with no notes: who ended it, and where its transcript is. */
const PreviousWithoutNotes = Schema.Struct({
  note: Schema.String,
  session_id: Schema.String,
  harness: Schema.String,
  ended_at: Schema.optional(Schema.String),
  ended_because: Schema.optional(Schema.String),
  ended_by: Schema.optionalKey(Schema.String),
  ...transcript,
  ...windDown,
});

export const OnboardAnswer = Schema.Struct({
  guidance: Schema.Array(Schema.String),
  briefing: Schema.optionalKey(Schema.Union([Schema.String, Schema.Struct({ unreadable: Schema.String })])),
  briefing_mentions: Schema.optionalKey(BriefingMentions),
  region: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      instruction: Schema.optionalKey(Schema.String),
      mentions: Schema.optionalKey(BriefingMentions),
    }),
  ),
  seat: Schema.optionalKey(SeatConfiguration),
  nodeRef: Schema.String,
  node: VisibleNode,
  role: FactoryRole,
  ...overseer,
  protocol_version: Schema.String,
  ...pause,
  connected: Schema.Array(Schema.Struct({ ...connectedSeat, ...boardBriefing })),
  commands: Schema.Array(ConnectionCommands),
  reach: Schema.Array(Schema.Union([ResourceReach, FilesReach])),
  references: Schema.optionalKey(Schema.Array(ReferenceListing)),
  rulings: Schema.optionalKey(
    Schema.Array(Schema.Struct({ region: Schema.String, label: Schema.String, rulings: Schema.Array(Ruling) })),
  ),
  co_members: Schema.Array(Schema.Struct({ region: Schema.String, seats: Schema.Array(Schema.String) })),
  tools: Schema.Array(SeatTool),
  since: Schema.Union([SinceAnswer, Schema.Struct({ unavailable: Schema.String })]),
  sessions: Schema.optionalKey(PastSessions),
  handoff: Schema.optionalKey(Handoff),
  previous_session_without_notes: Schema.optionalKey(PreviousWithoutNotes),
});

/** The session's notes saved, and how the seat moves on: it rests, or a fresh session continues. */
export const OffboardAnswer = Schema.Struct({
  session_id: Schema.String,
  gist: Schema.String,
  mode: Schema.Literals(OFFBOARD_MODES),
  ...applied,
  next_step: Schema.String,
});

/**
 * An op that takes no arguments and refuses every key, publishing a closed
 * object. capabilities and env.report keep v1's empty struct instead, which
 * admits any object and ignores it.
 */
const noArgs = (words: string) =>
  EmptyArgs.check(
    Schema.makeFilter((args) => Object.keys(args).length === 0 || words, {
      toJsonSchema: () => ({ type: "object", properties: {}, additionalProperties: false }),
    }),
  );

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
export const Offboard = Rpc.make("offboard", { payload: OffboardArgs, success: OffboardAnswer, error: WorkFailure });
/** onboard takes no arguments, refused in onboard's own words. */
const OnboardTakesNothing = noArgs("onboard takes no arguments: a seat onboards itself");
const ONBOARD_TAKES_NOTHING = {
  type: "InputError",
  message: "onboard takes no arguments: a seat onboards itself",
  details: { path: "args", retryable: false, hint: "junto schema show onboard" },
} as const;

export const Capabilities = Rpc.make("capabilities", { payload: EmptyArgs, success: CapabilitiesAnswer, error: WorkFailure });
export const Onboard = Rpc.make("onboard", { payload: OnboardTakesNothing, success: OnboardAnswer, error: WorkFailure })
  // An extra key is refused in onboard's own words, as v1 refused it.
  .annotate(WorkInputRefusal, ONBOARD_TAKES_NOTHING);

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const DiscoveryRpcs = RpcGroup.make(SignalRaise, SignalClear, SignalList, OpShow, OpList, EnvReport, LogsRead, Since, Offboard, Capabilities, Onboard).annotateRpcs(
  Rpc.ParseOptions,
  { onExcessProperty: "error" },
);
