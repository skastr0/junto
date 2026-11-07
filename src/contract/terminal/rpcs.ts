/**
 * The terminal link's calls: what the core asks the terminal process and
 * waits on. Each is an Effect `Rpc` whose payload, success and error are
 * Schemas, decoded closed at both ends (`src/shared/rpc-port.ts` carries
 * them). The terminal process serves the group with a required handler
 * record (`src/terminal/serve.ts`), so a call without a handler fails its
 * compile; the core's client (`src/node/terminals/client.ts`) is built from
 * the same group, so a changed payload or answer fails the other side's.
 *
 * The one-way traffic on the same port (output, keys, acknowledgements, the
 * commands that are never answered) is not here: it stays plain structured
 * clone, with no answer and no decode per message (`protocol.ts`).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/**
 * The link's own version. `TerminalAdopt` carries it both ways: a core and a
 * terminal process from different builds refuse adoption, and the PTYs stay
 * running for a core that speaks the same link.
 */
export const TERMINAL_LINK_VERSION = 1;

/** How a PTY ended. Each is absent when node-pty did not report it. */
export const TerminalExitStatus = Schema.Struct({
  code: Schema.UndefinedOr(Schema.Number),
  signal: Schema.UndefinedOr(Schema.Number),
});
export type TerminalExitStatus = typeof TerminalExitStatus.Type;

export const TerminalSpawnInput = Schema.Struct({
  /** The core's name for this terminal; every later message for it carries it. */
  id: Schema.Number,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))),
  cols: Schema.Number,
  rows: Schema.Number,
  /** Stored opaque, and given back by `TerminalAdopt`. A JSON value (`seat-spawn-meta.ts`). */
  meta: Schema.optionalKey(Schema.Unknown),
});
export type TerminalSpawnInput = typeof TerminalSpawnInput.Type;

export const TerminalSpawned = Schema.Struct({ pid: Schema.UndefinedOr(Schema.Number) });
export type TerminalSpawned = typeof TerminalSpawned.Type;

/** The terminal process could not start the PTY; `message` is node-pty's. */
export class TerminalSpawnRefused extends Schema.TaggedError<TerminalSpawnRefused>()("TerminalSpawnRefused", {
  message: Schema.String,
}) {}

/** One PTY the terminal process kept for the next core. */
export const TerminalAdopted = Schema.Struct({
  id: Schema.Number,
  pid: Schema.Number,
  cols: Schema.Number,
  rows: Schema.Number,
  /** The spawn's meta, absent when it had none. */
  meta: Schema.optionalKey(Schema.Unknown),
  /** Output the last core handled, up to `TERMINAL_HISTORY_CHARS`, cut on a chunk boundary. */
  history: Schema.String,
  /** The last chunk `history` holds; what follows it arrives as `pty.data`. */
  seq: Schema.Number,
  exit: Schema.optionalKey(TerminalExitStatus),
});
export type TerminalAdopted = typeof TerminalAdopted.Type;

export const TerminalAdoption = Schema.Struct({
  version: Schema.Number,
  terminals: Schema.Array(TerminalAdopted),
  /**
   * The lowest id no terminal of this process has had. The new core names its
   * spawns from here, so none reuses an id the process already knows.
   */
  nextId: Schema.Number,
});
export type TerminalAdoption = typeof TerminalAdoption.Type;

/** The core and the terminal process speak different link versions. */
export class TerminalLinkVersionMismatch extends Schema.TaggedError<TerminalLinkVersionMismatch>()("TerminalLinkVersionMismatch", {
  expected: Schema.Number,
  actual: Schema.Number,
}) {}

export const TerminalRpcs = RpcGroup.make(
  /** Start a PTY. Answers its pid. */
  Rpc.make("TerminalSpawn", { payload: TerminalSpawnInput, success: TerminalSpawned, error: TerminalSpawnRefused }),
  /**
   * A new core's first ask on its port: every PTY held, exited ones with their
   * exit. Every PTY's unacknowledged output, then any held exit, follow as
   * ordinary `pty.data` and `pty.exit`; the core holds what reaches it before
   * this answer.
   */
  Rpc.make("TerminalAdopt", {
    payload: { version: Schema.Number },
    success: TerminalAdoption,
    error: TerminalLinkVersionMismatch,
  }),
  /**
   * Answered once the terminal process took it, so its answer comes back
   * behind every push it sent before: a hold posted before a fence is in
   * force there, and every surface key that arrived before it has been heard.
   */
  Rpc.make("TerminalFence"),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });
