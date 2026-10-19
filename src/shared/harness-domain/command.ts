/**
 * Commands: what Junto does to a seat. `admitCommand` is the one place that
 * decides whether a command may go now, through which support, or why not.
 *
 * Mail is held while a seat compacts, retries or is blocked: typed text would
 * answer a permission prompt, land in a dialog, or be lost to a compaction.
 */
import { Result, Schema } from "effect";
import {
  type CommandCapability,
  type CommandSupport,
  type HarnessCapabilities,
} from "./capability";
import type { SeatSnapshot, SeatStatus } from "./status";

export const MailMode = Schema.Literals(["queue", "steer", "interrupt"]);
export type MailMode = typeof MailMode.Type;

export const SeatCommand = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("DeliverMail"), text: Schema.String, mode: MailMode }),
  Schema.Struct({
    _tag: Schema.Literal("AnswerPermission"),
    decision: Schema.Literals(["once", "always", "reject"]),
    requestId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Interrupt") }),
  Schema.Struct({ _tag: Schema.Literal("Compact") }),
]);
export type SeatCommand = typeof SeatCommand.Type;

export class CommandUnsupportedError extends Schema.TaggedError<CommandUnsupportedError>()(
  "CommandUnsupportedError",
  { capability: Schema.String, message: Schema.String },
) {}

export class SeatNotReadyError extends Schema.TaggedError<SeatNotReadyError>()(
  "SeatNotReadyError",
  { command: Schema.String, status: Schema.String, message: Schema.String },
) {}

export class CommandDeliveryError extends Schema.TaggedError<CommandDeliveryError>()(
  "CommandDeliveryError",
  { command: Schema.String, message: Schema.String },
) {}

export type CommandRefusal = CommandUnsupportedError | SeatNotReadyError;

const MAIL_CAPABILITY: Readonly<Record<MailMode, CommandCapability>> = {
  queue: "mailQueue",
  steer: "mailSteer",
  interrupt: "mailInterrupt",
};

export const commandCapability = (command: SeatCommand): CommandCapability => {
  switch (command._tag) {
    case "DeliverMail":
      return MAIL_CAPABILITY[command.mode];
    case "AnswerPermission":
      return "answerPermission";
    case "Interrupt":
      return "interrupt";
    case "Compact":
      return "compact";
  }
};

const describe = (status: SeatStatus): string => {
  switch (status._tag) {
    case "Working":
      return `Working:${status.phase}`;
    case "Blocked":
      return `Blocked:${status.reason._tag}`;
    default:
      return status._tag;
  }
};

/** Why the seat cannot take the command now, or undefined when it can. */
const notReady = (status: SeatStatus, command: SeatCommand): string | undefined => {
  switch (command._tag) {
    case "DeliverMail":
      if (status._tag === "Idle") return undefined;
      if (status._tag === "Working") {
        if (status.phase === "compacting") return "the seat is compacting";
        if (status.phase === "retrying") return "the seat is retrying";
        // An idle seat takes any mode as a plain prompt; a working one only
        // through a mode the harness supports, checked below.
        return undefined;
      }
      if (status._tag === "Blocked") return "the seat is blocked";
      // A read that cannot tell is not a hold: the composer gate decides, as
      // it did before the contract.
      if (status._tag === "Unknown") return undefined;
      return "the seat is not running";
    case "AnswerPermission":
      if (status._tag === "Blocked" && status.reason._tag === "Permission") {
        const wanted = command.requestId;
        const held = status.reason.requestId;
        return wanted !== undefined && held !== undefined && wanted !== held
          ? "a different permission request is open"
          : undefined;
      }
      return "no permission request is open";
    case "Interrupt":
      return status._tag === "Working" || status._tag === "Blocked" ? undefined : "nothing is running";
    case "Compact":
      return status._tag === "Idle" ? undefined : "the seat is not idle";
  }
};

/**
 * Admit a command against a seat's snapshot and its harness capabilities.
 * Mail to an idle seat needs only typed delivery of any mode.
 */
export const admitCommand = (
  snapshot: SeatSnapshot,
  capabilities: HarnessCapabilities,
  command: SeatCommand,
): Result.Result<Exclude<CommandSupport, { level: "none" }>, CommandRefusal> => {
  const capability = commandCapability(command);
  const reason = notReady(snapshot.status, command);
  if (reason !== undefined) {
    return Result.fail(
      new SeatNotReadyError({ command: capability, status: describe(snapshot.status), message: reason }),
    );
  }
  const idleMail = command._tag === "DeliverMail" && snapshot.status._tag === "Idle";
  const support = idleMail ? firstMailSupport(capabilities) : capabilities.commands[capability];
  if (support.level === "none") {
    return Result.fail(
      new CommandUnsupportedError({ capability, message: `this harness has no ${capability}` }),
    );
  }
  return Result.succeed(support);
};

const firstMailSupport = (capabilities: HarnessCapabilities): CommandSupport => {
  const { mailQueue, mailSteer, mailInterrupt } = capabilities.commands;
  return [mailQueue, mailSteer, mailInterrupt].find((support) => support.level !== "none") ?? mailQueue;
};
