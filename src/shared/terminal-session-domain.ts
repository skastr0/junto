/**
 * Terminal session runtime domain (Phase A).
 *
 * PCMI: pristine symbols for control lifetime + herdr NDJSON seam.
 * Glue (Node pipes, SSH, Electron IPC) stays plastic; illegal states are
 * narrowed here so adapters cannot invent write-after-death or dual text+bytes.
 *
 * Stock herdr contract: `herdr terminal session control|observe` NDJSON
 * (client TerminalControlCommand / write_terminal_session_output).
 */

import { Data, Either, Schema } from "effect";

// ── Brands ────────────────────────────────────────────────────────────────

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

/** Public write/open helper result — typed cause, IPC-flattenable message. */
export type HerdrControlWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: HerdrControlError };

export const herdrControlWriteFailed = (
  cause: HerdrControlError,
): HerdrControlWriteResult => ({ ok: false, cause });

export const herdrControlWriteOk = (): HerdrControlWriteResult => ({ ok: true });

/** Flatten for IPC / legacy `{ ok, error?: string }` call sites. */
export const herdrControlWriteWire = (
  result: HerdrControlWriteResult,
): { readonly ok: true } | { readonly ok: false; readonly error: string } =>
  result.ok
    ? { ok: true }
    : { ok: false, error: result.cause.message };

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
