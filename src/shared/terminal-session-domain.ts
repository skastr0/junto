/**
 * Terminal session runtime domain (Phase A–C).
 *
 * PCMI: pristine symbols for session lifetime + herdr NDJSON seam.
 * Glue (Node pipes, SSH, Electron IPC, node-pty) stays plastic.
 *
 * Surfaces:
 *   - native PTY (TermPlane / LocalSessionHost) — owns kill on quit
 *   - herdr control/observe client — detach-only, never pane murder
 *
 * Stock herdr contract: `herdr terminal session control|observe` NDJSON
 * (client TerminalControlCommand / write_terminal_session_output).
 */

import { Data, Either, Schema } from "effect";

// ── Brands ────────────────────────────────────────────────────────────────

export const BindingId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("BindingId"),
);
export type BindingId = typeof BindingId.Type;

export const SessionEpoch = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("SessionEpoch"),
);
export type SessionEpoch = typeof SessionEpoch.Type;

export const HerdrStreamId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("HerdrStreamId"),
);
export type HerdrStreamId = typeof HerdrStreamId.Type;

export const HerdrTerminalId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("HerdrTerminalId"),
);
export type HerdrTerminalId = typeof HerdrTerminalId.Type;

/** Which adapter owns the session generation. */
export type SessionSurface = "native" | "herdr-control";

/** Product geometry floors for control attach / resize (renderer → herdr). */
export const ControlCols = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(20),
  Schema.brand("ControlCols"),
);
export type ControlCols = typeof ControlCols.Type;

export const ControlRows = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(5),
  Schema.brand("ControlRows"),
);
export type ControlRows = typeof ControlRows.Type;

// ── Control I/O phase (replaces writeBroken / ioFailed flags) ─────────────

/**
 * Writable only while Live. Broken/Closed refuse further stdin offers.
 * Transitions: Live → Broken (pipe/child/overflow) → removed; Live → Closed (detach).
 */
export type ControlIoPhase = Data.TaggedEnum<{
  Live: {};
  Broken: {
    readonly reason: "pipe" | "overflow" | "child" | "io";
  };
  Closed: {
    readonly reason: string;
  };
}>;

export const ControlIoPhase = Data.taggedEnum<ControlIoPhase>();

export const controlPhaseIsLive = (phase: ControlIoPhase): boolean =>
  phase._tag === "Live";

export const controlPhaseRefusesWrite = (phase: ControlIoPhase): boolean =>
  phase._tag !== "Live";

// ── Product session phase (native + herdr share vocabulary) ───────────────

/**
 * One phase machine for both surfaces. Write only on Live.
 * Opening → Live → (Broken | Closed); Broken → Closed on process exit.
 */
export type SessionPhase = Data.TaggedEnum<{
  Opening: { readonly surface: SessionSurface };
  Live: { readonly surface: SessionSurface };
  Broken: {
    readonly surface: SessionSurface;
    readonly reason: "pipe" | "overflow" | "child" | "io";
  };
  Closed: {
    readonly surface: SessionSurface;
    readonly reason: string;
  };
}>;

export const SessionPhase = Data.taggedEnum<SessionPhase>();

export const sessionPhaseAllowsWrite = (phase: SessionPhase): boolean =>
  phase._tag === "Live";

export const sessionPhaseIsOpen = (phase: SessionPhase): boolean =>
  phase._tag === "Opening" || phase._tag === "Live" || phase._tag === "Broken";

/** Map product phase → existing TerminalSessionStatus wire vocab. */
export const productStatusFromSessionPhase = (
  phase: SessionPhase,
): "starting" | "running" | "exited" | "missing" => {
  switch (phase._tag) {
    case "Opening":
      return "starting";
    case "Live":
    case "Broken":
      return "running";
    case "Closed":
      return "exited";
  }
};

/** Map herdr control I/O phase into product SessionPhase. */
export const sessionPhaseFromControlIo = (
  phase: ControlIoPhase,
  surface: SessionSurface = "herdr-control",
): SessionPhase => {
  switch (phase._tag) {
    case "Live":
      return SessionPhase.Live({ surface });
    case "Broken":
      return SessionPhase.Broken({ surface, reason: phase.reason });
    case "Closed":
      return SessionPhase.Closed({ surface, reason: phase.reason });
  }
};

// ── Tagged errors ─────────────────────────────────────────────────────────

export class HerdrControlInactiveError extends Schema.TaggedError<HerdrControlInactiveError>()(
  "HerdrControlInactiveError",
  {
    message: Schema.String,
  },
) {}

export class HerdrControlPipeError extends Schema.TaggedError<HerdrControlPipeError>()(
  "HerdrControlPipeError",
  {
    channel: Schema.Literal("stdin", "stdout", "stderr"),
    message: Schema.String,
  },
) {}

export class HerdrControlProtocolError extends Schema.TaggedError<HerdrControlProtocolError>()(
  "HerdrControlProtocolError",
  {
    message: Schema.String,
  },
) {}

export class HerdrControlOverflowError extends Schema.TaggedError<HerdrControlOverflowError>()(
  "HerdrControlOverflowError",
  {
    message: Schema.String,
  },
) {}

export class HerdrControlShutdownError extends Schema.TaggedError<HerdrControlShutdownError>()(
  "HerdrControlShutdownError",
  {
    message: Schema.String,
  },
) {}

export type HerdrControlError =
  | HerdrControlInactiveError
  | HerdrControlPipeError
  | HerdrControlProtocolError
  | HerdrControlOverflowError
  | HerdrControlShutdownError;

export class TerminalSpawnError extends Schema.TaggedError<TerminalSpawnError>()(
  "TerminalSpawnError",
  {
    surface: Schema.Literal("native", "herdr-control"),
    message: Schema.String,
  },
) {}

export class TerminalAdmitError extends Schema.TaggedError<TerminalAdmitError>()(
  "TerminalAdmitError",
  {
    message: Schema.String,
  },
) {}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    surface: Schema.Literal("native", "herdr-control"),
    message: Schema.String,
  },
) {}

export type TerminalSessionError =
  | HerdrControlError
  | TerminalSpawnError
  | TerminalAdmitError
  | TerminalWriteError;

export const terminalSpawnError = (
  surface: SessionSurface,
  message: string,
): TerminalSpawnError => new TerminalSpawnError({ surface, message });

export const terminalWriteError = (
  surface: SessionSurface,
  message: string,
): TerminalWriteError => new TerminalWriteError({ surface, message });

/** Public write/open helper result — typed cause, IPC-flattenable message. */
export type HerdrControlWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: HerdrControlError };

export const herdrControlWriteFailed = (
  cause: HerdrControlError,
): HerdrControlWriteResult => ({ ok: false, cause });

export const herdrControlWriteOk = (): HerdrControlWriteResult => ({ ok: true });

export const inactiveControlError = (message: string): HerdrControlInactiveError =>
  new HerdrControlInactiveError({ message });

export const pipeControlError = (
  channel: "stdin" | "stdout" | "stderr",
  message: string,
): HerdrControlPipeError => new HerdrControlPipeError({ channel, message });

// ── Stock herdr NDJSON outbound (control stdin) ───────────────────────────

export const HerdrTerminalInputBytes = Schema.Struct({
  type: Schema.Literal("terminal.input"),
  bytes: Schema.String,
});
export type HerdrTerminalInputBytes = typeof HerdrTerminalInputBytes.Type;

export const HerdrTerminalInputText = Schema.Struct({
  type: Schema.Literal("terminal.input"),
  text: Schema.String,
});
export type HerdrTerminalInputText = typeof HerdrTerminalInputText.Type;

export const HerdrTerminalResize = Schema.Struct({
  type: Schema.Literal("terminal.resize"),
  cols: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  rows: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
});
export type HerdrTerminalResize = typeof HerdrTerminalResize.Type;

export const HerdrTerminalScroll = Schema.Struct({
  type: Schema.Literal("terminal.scroll"),
  direction: Schema.Literal("up", "down"),
  lines: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  column: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  row: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  modifiers: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(0, 255))),
});
export type HerdrTerminalScroll = typeof HerdrTerminalScroll.Type;

export const HerdrTerminalRelease = Schema.Struct({
  type: Schema.Literal("terminal.release"),
});
export type HerdrTerminalRelease = typeof HerdrTerminalRelease.Type;

export type HerdrControlOutbound =
  | HerdrTerminalInputBytes
  | HerdrTerminalInputText
  | HerdrTerminalResize
  | HerdrTerminalScroll
  | HerdrTerminalRelease;

/** Encode one NDJSON line (with trailing newline) for control stdin. */
export const encodeHerdrControlLine = (command: HerdrControlOutbound): string =>
  `${JSON.stringify(command)}\n`;

export const herdrInputBytes = (bytes: string): HerdrTerminalInputBytes => ({
  type: "terminal.input",
  bytes,
});

export const herdrInputText = (text: string): HerdrTerminalInputText => ({
  type: "terminal.input",
  text,
});

export const herdrResize = (cols: number, rows: number): HerdrTerminalResize => ({
  type: "terminal.resize",
  cols,
  rows,
});

export const herdrRelease = (): HerdrTerminalRelease => ({ type: "terminal.release" });

export const herdrScroll = (input: {
  readonly direction: "up" | "down";
  readonly lines: number;
  readonly column?: number;
  readonly row?: number;
  readonly modifiers?: number;
}): HerdrTerminalScroll => ({
  type: "terminal.scroll",
  direction: input.direction,
  lines: input.lines,
  ...(input.column !== undefined ? { column: input.column } : {}),
  ...(input.row !== undefined ? { row: input.row } : {}),
  ...(input.modifiers !== undefined ? { modifiers: input.modifiers } : {}),
});

// ── Stock herdr NDJSON inbound (control/observe stdout) ───────────────────

export const HerdrTerminalFrame = Schema.Struct({
  type: Schema.Literal("terminal.frame"),
  bytes: Schema.String,
  encoding: Schema.optional(Schema.String),
  full: Schema.optional(Schema.Boolean),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  seq: Schema.optional(Schema.Number),
});
export type HerdrTerminalFrame = typeof HerdrTerminalFrame.Type;

export const HerdrTerminalClosed = Schema.Struct({
  type: Schema.Literal("terminal.closed"),
  reason: Schema.optional(Schema.String),
});
export type HerdrTerminalClosed = typeof HerdrTerminalClosed.Type;

export const HerdrControlInbound = Schema.Union(HerdrTerminalFrame, HerdrTerminalClosed);
export type HerdrControlInbound = typeof HerdrControlInbound.Type;

/** Best-effort parse of one control stdout line; unknown types return undefined. */
export const parseHerdrControlInbound = (line: string): HerdrControlInbound | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownEither(HerdrControlInbound)(raw);
  return Either.isRight(decoded) ? decoded.right : undefined;
};

/** Normalize raw cols/rows for product control attach (floors). */
export const normalizeControlGeometry = (
  cols: number,
  rows: number,
): { readonly cols: number; readonly rows: number } => ({
  cols: Number.isFinite(cols) ? Math.max(20, Math.floor(cols)) : 80,
  rows: Number.isFinite(rows) ? Math.max(5, Math.floor(rows)) : 24,
});

// ── Write channel shape (Phase D — interface only; adapters implement) ─────

/**
 * Ordered write offer to a Live session. Adapters (herdr NDJSON, native PTY)
 * implement this; callers never touch raw Writable/stdin.
 * Plastic implementations may still use Node streams under the hood.
 */
export type ControlWriteOffer = {
  readonly kind: "text" | "bytes" | "resize" | "scroll" | "release";
  readonly payload: string;
};

/**
 * Stable close/break codes for product recovery (renderer policy table).
 * Prefer these over freeform reason strings when branching reconnect UX.
 */
export const SessionRecoveryCode = Schema.Literal(
  "pipe_broken",
  "overflow",
  "child_error",
  "stdin_error",
  "stdout_error",
  "stderr_error",
  "client_close",
  "renderer_destroyed",
  "renderer_process_gone",
  "renderer_reloaded",
  "renderer_gone",
  "scope_release",
  "host_revoked",
  "superseded",
  "exit",
  "pane_gone",
  "unknown",
);
export type SessionRecoveryCode = typeof SessionRecoveryCode.Type;

/** Map freeform close reason → recovery code for UI policy. */
export const sessionRecoveryCodeFromReason = (reason: string | undefined): SessionRecoveryCode => {
  if (!reason) return "unknown";
  if (reason === "pipe_broken") return "pipe_broken";
  if (reason === "overflow") return "overflow";
  if (reason === "child_error") return "child_error";
  if (reason.endsWith("_error") && /stdin|stdout|stderr/.test(reason)) {
    if (reason.startsWith("stdin")) return "stdin_error";
    if (reason.startsWith("stdout")) return "stdout_error";
    if (reason.startsWith("stderr")) return "stderr_error";
  }
  if (reason === "client_close") return "client_close";
  if (reason === "renderer_destroyed") return "renderer_destroyed";
  if (reason === "renderer_process_gone") return "renderer_process_gone";
  if (reason === "renderer_reloaded") return "renderer_reloaded";
  if (reason === "renderer_gone") return "renderer_gone";
  if (reason.startsWith("scope_release")) return "scope_release";
  if (reason === "host_revoked") return "host_revoked";
  if (reason === "superseded") return "superseded";
  if (reason === "exit" || reason.startsWith("exit_")) return "exit";
  if (reason === "pane_gone" || reason === "closed") return "pane_gone";
  return "unknown";
};

/** Auto-reconnect only for transport/process loss — not intentional detach. */
export const sessionRecoveryShouldAutoReconnect = (code: SessionRecoveryCode): boolean =>
  code === "pipe_broken" ||
  code === "child_error" ||
  code === "stdin_error" ||
  code === "stdout_error" ||
  code === "stderr_error" ||
  code === "overflow" ||
  code === "unknown" ||
  code === "exit";

/**
 * Capability present only while session is Live (construction: callers hold
 * this handle from open, not a free-floating stream id from a Closed session).
 */
export type LiveWriteChannel = {
  readonly offer: (line: string) => HerdrControlWriteResult;
};
