/**
 * Terminal session runtime domain.
 *
 * PCMI: pristine symbols for session lifetime. Glue (Node pipes, SSH, Electron
 * IPC, node-pty) stays plastic.
 *
 * Surface: the native PTY (TermPlane / LocalSessionHost) — it owns kill on quit.
 */

import { Data, Schema } from "effect";

// ── Brands ────────────────────────────────────────────────────────────────

export const BindingId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("BindingId"),
);
export type BindingId = typeof BindingId.Type;

export const SessionEpoch = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("SessionEpoch"),
);
export type SessionEpoch = typeof SessionEpoch.Type;

/** Which adapter owns the session generation. */
export type SessionSurface = "native";

// ── Product session phase ─────────────────────────────────────────────────

/**
 * One phase machine for the session. Write only on Live.
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
): "starting" | "running" | "exited" => {
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

// ── Tagged errors ─────────────────────────────────────────────────────────

export class TerminalSpawnError extends Schema.TaggedError<TerminalSpawnError>()(
  "TerminalSpawnError",
  {
    surface: Schema.Literal("native"),
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
    surface: Schema.Literal("native"),
    message: Schema.String,
  },
) {}

export type TerminalSessionError =
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
