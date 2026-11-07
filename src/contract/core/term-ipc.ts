/**
 * The window's terminals, as main asks the core for them (term/ipc.ts): the
 * seats and terminals on a canvas, their starts and stops, the leases a view
 * reads and types through, the node-delete fence, and the harness reads a
 * seat's card and picker make. The terminal plane runs in the core process,
 * whose PTYs run in the terminal process over a port, so every one of these
 * runs where the plane is. Its events come back on the push channels, never
 * here.
 *
 * A plane or router call that fails answers `TermRefused` with the sentence
 * the window shows; an answer the window reads as data (`{ ok: false }`)
 * stays an answer.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { MachineInventory } from "../../shared/harness-domain/inventory";
import { HostDirectorySnapshot } from "../../shared/host-directory";
import { NodeId, Seat, Terminal } from "../../shared/model";
import { CacheMode } from "../../shared/seat-offboard";
import { TerminalSessionSummary } from "../../shared/terminal";
import { coreClient } from "./link";

/** The plane or the router refused, or the seat could not be read; `message` is the sentence the window shows. */
export class TermRefused extends Schema.TaggedError<TermRefused>()("TermRefused", {
  message: Schema.String,
}) {}

// ── What crosses ─────────────────────────────────────────────────────────────

/** A seat or a raw terminal: the two kinds a terminal binding belongs to. */
export const SeatOrTerminal = Schema.Union([Seat, Terminal]);

/**
 * What a seat's card reads about its next start (`modelSeatLaunchState`):
 * whether it picks up where it was, what its next turn does, and how it
 * stands against its cache window (seat-next-launch.ts).
 */
export const SeatLaunchState = Schema.Struct({
  settingsFixed: Schema.Boolean,
  nextTurn: Schema.optional(Schema.Struct({ fresh: Schema.Boolean, freshAt: Schema.optional(Schema.Number) })),
  cacheWindow: Schema.optional(
    Schema.Struct({
      windowMinutes: Schema.Number,
      stillSince: Schema.Number,
      windowEndsAt: Schema.Number,
      pastWindow: Schema.Boolean,
      pastByMs: Schema.Number,
      cacheMode: Schema.optional(CacheMode),
      tokens: Schema.optional(Schema.Number),
    }),
  ),
});
export type SeatLaunchState = typeof SeatLaunchState.Type;

/** A model the harness picker offers. */
export const ManagedTerminalModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  efforts: Schema.optional(Schema.Array(Schema.String)),
});

/** The models one harness offers, and where the list came from. */
export const ManagedTerminalModelsResult = Schema.Struct({
  models: Schema.Array(ManagedTerminalModelOption),
  source: Schema.Literals(["cache", "aliases", "command", "empty"]),
  error: Schema.optional(Schema.String),
  efforts: Schema.Array(Schema.String),
});

/** Why a machine's harnesses cannot be read now, with the last snapshot it sent. */
export const MachineInventoryFailure = Schema.Struct({
  _tag: Schema.Literal("InventoryUnavailableError"),
  machine: Schema.String,
  reason: Schema.Literals(["timeout", "failed", "unreachable", "notInstalled"]),
  message: Schema.String,
  failure: Schema.optional(Schema.String),
  operationId: Schema.optional(Schema.String),
  last: Schema.optional(Schema.Struct({ inventory: MachineInventory, receivedAt: Schema.Number })),
});

export const MachineInventoryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), inventory: MachineInventory }),
  Schema.Struct({ ok: Schema.Literal(false), error: MachineInventoryFailure }),
]);

/** A native setting's value, as it is read and written. */
const NativeValue = Schema.Union([Schema.Boolean, Schema.String, Schema.Number]);

/** Why a native setting could not be read or written on its machine. */
export const NativeSettingFailure = Schema.Union([
  MachineInventoryFailure,
  Schema.Struct({
    _tag: Schema.Literal("NativeSettingRefusedError"),
    harness: Schema.String,
    key: Schema.String,
    reason: Schema.Literals(["undeclared", "version", "value"]),
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("NativeConfigWriteError"),
    machine: Schema.String,
    harness: Schema.String,
    key: Schema.String,
    reason: Schema.Literals(["conflict", "unsupported", "io"]),
    message: Schema.String,
  }),
]);

export const NativeSettingsReadResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    values: Schema.Record(Schema.String, NativeValue),
    /** Keys whose file value is outside the declared setting; shown as unset, never as text. */
    unfit: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: NativeSettingFailure }),
]);

export const NativeSettingWriteResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: NativeValue }),
  Schema.Struct({ ok: Schema.Literal(false), error: NativeSettingFailure }),
]);

/** A view's hold on one generation of a binding. */
export const ControlLease = Schema.Struct({
  leaseId: Schema.String,
  bindingId: Schema.String,
  epoch: Schema.String,
  mode: Schema.Literals(["control", "observe"]),
});

/** One entry of a generation's journal, as an attach hands it back. */
export const JournalEntry = Schema.Union([
  Schema.Struct({ seq: Schema.BigInt, type: Schema.Literal("output"), data: Schema.String }),
  Schema.Struct({ seq: Schema.BigInt, type: Schema.Literal("resize"), cols: Schema.Number, rows: Schema.Number }),
  Schema.Struct({
    seq: Schema.BigInt,
    type: Schema.Literal("exit"),
    code: Schema.UndefinedOr(Schema.Number),
    signal: Schema.UndefinedOr(Schema.Number),
  }),
]);

/** The main grid's serialized screen, scrollback included. */
export const AttachScreenSnapshot = Schema.Struct({
  bindingId: Schema.String,
  epoch: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
  seq: Schema.BigInt,
  serialized: Schema.String,
});

export const AttachResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    lease: ControlLease,
    cols: Schema.Number,
    rows: Schema.Number,
    journal: Schema.Array(JournalEntry),
    status: Schema.String,
    pid: Schema.optional(Schema.Number),
    screen: Schema.optional(AttachScreenSnapshot),
  }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);

/** What a view asks to attach to, as the window sends it. */
export const TermAttachInput = Schema.Struct({
  bindingId: Schema.String,
  mode: Schema.Literals(["control", "observe"]),
  takeover: Schema.optional(Schema.Boolean),
  /** Route to the binding's machine when it is not this one. */
  hostId: Schema.optional(Schema.String),
  /** A control view that can take a surface port. */
  surface: Schema.optional(Schema.Boolean),
});

/** A binding a node delete closes. */
export const TerminalNodeDeleteResource = Schema.Struct({
  bindingId: Schema.String,
  hostId: Schema.optional(Schema.String),
});

export const TerminalNodeDeleteOutcome = Schema.Literals(["committed", "aborted"]);

export const TerminalBeginNodeDeleteResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    leaseId: Schema.String,
    closeResults: Schema.Array(Schema.Struct({ bindingId: Schema.String, hostId: Schema.String, clean: Schema.Literal(true) })),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

export const TerminalFinishNodeDeleteResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

// ── Payloads main decodes at its edge ────────────────────────────────────────

/** Text with something other than whitespace in it. */
const NonBlank = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/)));

/** A seat or terminal by the canvas it is on and its node id: all the window names. */
export const TermSeatWhere = Schema.Struct({ canvas: NonBlank, id: NodeId });
export const TermListAsk = Schema.Struct({ hostId: Schema.optional(Schema.String) });
export const TermDirectoryAsk = Schema.Struct({ hostId: Schema.String, path: Schema.optional(Schema.String) });
export const TermBindingAsk = Schema.Struct({ bindingId: Schema.String, hostId: Schema.optional(Schema.String) });
export const TermMachineAsk = Schema.Struct({ machine: NonBlank });
export const TermHarnessAsk = Schema.Struct({ harness: Schema.String });
export const TermNativeSettingsAsk = Schema.Struct({
  machine: Schema.String,
  harness: Schema.String,
  keys: Schema.Array(Schema.String),
});
/** A native setting to write; the core decodes the harness, key and value against the declared setting. */
export const TermNativeSettingWriteAsk = Schema.Struct({
  machine: Schema.String,
  harness: Schema.String,
  key: Schema.String,
  value: NativeValue,
});
export const TermNodeDeleteBegin = Schema.Struct({ resources: Schema.Array(TerminalNodeDeleteResource) });
export const TermNodeDeleteFinish = Schema.Struct({ leaseId: Schema.String, outcome: TerminalNodeDeleteOutcome });

export const TermRpcs = RpcGroup.make(
  /** The stored seat or terminal by canvas and id; undefined for any other node or none. */
  Rpc.make("TermSeatNode", { payload: TermSeatWhere, success: Schema.UndefinedOr(SeatOrTerminal), error: TermRefused }),
  /** A seat on this machine: what its next start does. */
  Rpc.make("TermSeatLaunchState", { payload: { canvas: Schema.String, node: Seat }, success: SeatLaunchState, error: TermRefused }),
  /** A seat on another machine: what it last said, for its card; undefined when it cannot say. */
  Rpc.make("TermRemoteSeatLaunch", { payload: { node: Seat }, success: Schema.UndefinedOr(SeatLaunchState), error: TermRefused }),
  Rpc.make("TermStartSeat", { payload: { canvas: Schema.String, seatId: NodeId }, success: TerminalSessionSummary, error: TermRefused }),
  Rpc.make("TermStopSeat", { payload: { canvas: Schema.String, seatId: NodeId }, error: TermRefused }),
  /** A raw terminal: its create admission, its start and its bound process identity. */
  Rpc.make("TermStartTerminal", { payload: { canvas: Schema.String, node: Terminal }, success: TerminalSessionSummary, error: TermRefused }),
  /** True when the binding's machine began stopping it. */
  Rpc.make("TermStopBinding", { payload: TermBindingAsk, success: Schema.Boolean, error: TermRefused }),
  Rpc.make("TermGet", { payload: TermBindingAsk, success: Schema.UndefinedOr(TerminalSessionSummary), error: TermRefused }),
  /** One machine's sessions, or every machine's with `*` or `all`. */
  Rpc.make("TermList", { payload: TermListAsk, success: Schema.Array(TerminalSessionSummary), error: TermRefused }),
  Rpc.make("TermReadDirectory", { payload: TermDirectoryAsk, success: HostDirectorySnapshot, error: TermRefused }),
  Rpc.make("TermIsLocalHost", { payload: { hostId: Schema.String }, success: Schema.Boolean }),
  Rpc.make("TermThisMachine", { success: Schema.String }),
  Rpc.make("TermBeginNodeDelete", { payload: TermNodeDeleteBegin, success: TerminalBeginNodeDeleteResult, error: TermRefused }),
  Rpc.make("TermFinishNodeDelete", { payload: TermNodeDeleteFinish, success: TerminalFinishNodeDeleteResult, error: TermRefused }),
  /** The attach and the machine it went to (this one when none was named). */
  Rpc.make("TermAttach", {
    payload: { input: TermAttachInput },
    success: Schema.Struct({ hostId: Schema.String, result: AttachResult }),
    error: TermRefused,
  }),
  Rpc.make("TermRelease", { payload: { lease: ControlLease, hostId: Schema.String }, error: TermRefused }),
  /** Keys from the operator: the core tags their origin where they land. */
  Rpc.make("TermWrite", {
    payload: { lease: ControlLease, data: Schema.String, hostId: Schema.String },
    success: Schema.Boolean,
    error: TermRefused,
  }),
  Rpc.make("TermResize", {
    payload: { lease: ControlLease, cols: Schema.Number, rows: Schema.Number, hostId: Schema.String },
    success: Schema.Boolean,
    error: TermRefused,
  }),
  Rpc.make("TermHarnessModels", { payload: TermHarnessAsk, success: ManagedTerminalModelsResult, error: TermRefused }),
  /** This machine's harnesses, or a linked one's over the link's inventory channel. */
  Rpc.make("TermMachineInventory", { payload: TermMachineAsk, success: MachineInventoryResult, error: TermRefused }),
  Rpc.make("TermNativeSettingsRead", { payload: TermNativeSettingsAsk, success: NativeSettingsReadResult, error: TermRefused }),
  Rpc.make("TermNativeSettingWrite", { payload: TermNativeSettingWriteAsk, success: NativeSettingWriteResult, error: TermRefused }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the terminal group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class TermCore extends Context.Service<TermCore, RpcClient.FromGroup<typeof TermRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/TermCore",
) {
  static readonly layer = Layer.effect(TermCore, coreClient(TermRpcs));
}
