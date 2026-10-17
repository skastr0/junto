/**
 * What each harness can report and accept, declared per signal and per
 * command. "none" is explicit: a feature asks whether a seat can report usage
 * limits, and how reliably, and the type makes it handle the answer.
 *
 * A harness record declares a support for every key; there is no default.
 * Conformance tests spawn the real binary and assert every `native` and
 * `parsed` claim.
 */
import { Schema } from "effect";
import { HarnessChannel, type HarnessSignalKind } from "./signal";

export const SignalSupport = Schema.Union([
  Schema.Struct({ level: Schema.Literal("none") }),
  Schema.Struct({
    level: Schema.Literals(["native", "parsed", "screen"]),
    channel: HarnessChannel,
  }),
]);
export type SignalSupport = typeof SignalSupport.Type;

/** `native` goes through a structured side channel, `typed` is keystrokes into the PTY. */
export const CommandChannel = Schema.Literals(["pty", "report", "api", "process"]);
export type CommandChannel = typeof CommandChannel.Type;

export const CommandSupport = Schema.Union([
  Schema.Struct({ level: Schema.Literal("none") }),
  Schema.Struct({ level: Schema.Literals(["native", "typed"]), channel: CommandChannel }),
]);
export type CommandSupport = typeof CommandSupport.Type;

export const COMMAND_CAPABILITIES = [
  "mailQueue",
  "mailSteer",
  "mailInterrupt",
  "answerPermission",
  "interrupt",
  "compact",
  "resume",
] as const;
export const CommandCapability = Schema.Literals(COMMAND_CAPABILITIES);
export type CommandCapability = typeof CommandCapability.Type;

/** Signals a harness reports. Seat, awareness and system signals are not harness capabilities. */
export type HarnessCapabilities = {
  readonly signals: Readonly<Record<HarnessSignalKind, SignalSupport>>;
  readonly commands: Readonly<Record<CommandCapability, CommandSupport>>;
};

export const NO_SIGNAL: SignalSupport = { level: "none" };
export const NO_COMMAND: CommandSupport = { level: "none" };
