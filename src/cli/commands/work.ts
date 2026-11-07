import { Argument, Command, Flag } from "effect/cli";
import { Effect, Option, Schema } from "effect";
import {
  type MsgPromptArgs,
  type MsgSendArgs,
  PreambleArgs,
  RulingsArgs,
  type WorkOpName,
} from "../../shared/work-control";
import { mintOpId } from "../../shared/resource-command";
import type { OpId } from "../../shared/work-ids";
import { InputError } from "../core/errors";
import { DEFAULT_BATCH_CONCURRENCY, runMutationBatch } from "../core/batch";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { MsgList, MsgPrompt, MsgReact, MsgRead, MsgReply, MsgSend, MsgSent } from "../../contract/work/msg";
import { WorkSocket, callWorkRpc } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Argument.String("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const optionalJsonInputArg = jsonInputArg.pipe(Argument.optional);

const concurrencyOption = Flag.Int("concurrency").pipe(
  Flag.optional,
  Flag.withDescription(
    `Max concurrent mutations (default ${DEFAULT_BATCH_CONCURRENCY}); reject <= 0`,
  ),
);

const timeoutOption = Flag.Int("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

/** Domain call — identity is process-bind on the server, not a payload claim. */
const callDomain = <A>(
  op: WorkOpName,
  item: A,
  timeout?: number,
) =>
  Effect.gen(function* () {
    const socket = yield* WorkSocket;
    return yield* socket.call(op, item, timeout);
  });

// --- task ---

/** `task rules`, registered by the task command (./task.ts). */
export const taskRulesCommand = Command.make(
  "rules",
  {
    task: Argument.String("task").pipe(Argument.optional, Argument.withDescription("A task: #42, its id, or a junto:// ref")),
    node: Flag.String("node").pipe(Flag.optional, Flag.withDescription("A task node instead: its id, its name or a junto:// ref")),
    timeout: timeoutOption,
  },
  ({ task, node, timeout }) =>
    executeJsonCommand(
      "task rules",
      Effect.gen(function* () {
        // One of the two: the rules where a task sits, or a task node's own.
        if (Option.isSome(task) === Option.isSome(node)) {
          return yield* Effect.fail(new InputError({ message: "name a task, or --node, not both", path: Option.isSome(task) ? "node" : "task" }));
        }
        const item = Option.isSome(task) ? { task: task.value } : { node: Option.getOrThrow(node) };
        return yield* callDomain("task.rules", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "The rules in force on a task node, with provenance: name a task for the rules where it sits, which its finish leaves unanswered and the checks it needs with their status, or --node for a node's own",
  ),
);

/** Operator-pinned precedent over the seat's (or a target's) region stack. */
export const rulingsCommand = Command.make(
  "rulings",
  { input: optionalJsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "rulings",
      Effect.gen(function* () {
        const raw = Option.match(input, {
          onNone: () => "{}",
          onSome: (value) => (value.trim().length === 0 ? "{}" : value),
        });
        const item = yield* loadJsonInput(RulingsArgs, raw);
        return yield* callDomain("rulings", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Pinned rulings for this seat's region stack, or a connected target's",
  ),
);

// --- seat-local preamble --------------------------------------------------

export const preambleCommand = Command.make(
  "preamble",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "preamble",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(PreambleArgs, input);
        return yield* callDomain("preamble", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Show a short-lived preamble above this agent node (about 30 seconds)",
  ),
);

// --- msg ---

const msgListCommand = Command.make(
  "list",
  { input: optionalJsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "msg list",
      Effect.gen(function* () {
        const raw = Option.match(input, {
          onNone: () => "{}",
          onSome: (value) => (value.trim().length === 0 ? "{}" : value),
        });
        const item = yield* loadJsonInput(MsgList.payloadSchema, raw);
        return yield* callWorkRpc(MsgList, item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "List this seat's inbox (marks listed mail read unless peek) or a connected peer's mailbox; filter by threadId, from, unread, since and text. One page, newest first: limit (default 50), more and remaining in the answer, before (the last id listed) for the next page, sentBefore for the next page of sent mail",
  ),
);

/** The item with the write id it names, or a new one (core/op-id.ts). */
const withOpId = <A extends { readonly opId?: OpId }>(item: A): A => ({ ...item, opId: item.opId ?? mintOpId() });

const msgSendCommand = Command.make(
  "send",
  {
    input: jsonInputArg,
    text: Argument.String("text").pipe(Argument.optional),
    prompt: Flag.Boolean("prompt").pipe(Flag.withDefault(false)),
    concurrency: concurrencyOption,
    timeout: timeoutOption,
  },
  ({ input, text, prompt, concurrency, timeout }) =>
    executeJsonCommand(
      "msg send",
      runMutationBatch({
        // `msg send <target> <text>` is shorthand for one JSON item.
        input: Option.match(text, {
          onNone: () => input,
          onSome: (body) => JSON.stringify({ target: input, text: body }),
        }),
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: prompt ? MsgPrompt.payloadSchema : MsgSend.payloadSchema,
        // Each item carries its write id, so a timed-out comment sent again is written once.
        run: (item) => prompt ? callWorkRpc(MsgPrompt, item as MsgPromptArgs, toUndefined(timeout)) : callWorkRpc(MsgSend, withOpId(item as MsgSendArgs), toUndefined(timeout)),
      }),
    ),
).pipe(Command.withDescription(
  "Send mail, typed into the seat's input: whole up to 2,500 characters, with mail sent together as one turn, or with --prompt the full text at once, as its own turn (batch-capable)",
));

const msgSentCommand = Command.make(
  "sent",
  { input: optionalJsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) => executeJsonCommand(
    "msg sent",
    Effect.gen(function* () {
      const item = yield* loadJsonInput(MsgSent.payloadSchema, toUndefined(input) ?? "{}");
      return yield* callWorkRpc(MsgSent, item, toUndefined(timeout));
    }),
  ),
).pipe(Command.withDescription("Read sent mail and recipient receipts without marking their mailbox read"));

const msgReadCommand = Command.make(
  "read",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "msg read",
      runMutationBatch({
        input: /^[\[{\s@-]/.test(input) ? input : JSON.stringify({ messageId: input }),
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: MsgRead.payloadSchema,
        run: (item) => callWorkRpc(MsgRead, item, toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Read a complete mailbox message and mark it read (own seat; batch-capable)",
  ),
);

const msgReplyCommand = Command.make(
  "reply",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "msg reply",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: MsgReply.payloadSchema,
        run: (item) => callWorkRpc(MsgReply, withOpId(item), toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Reply to mail and mark inReplyTo read (batch-capable)",
  ),
);

const msgReactCommand = Command.make(
  "react",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "msg react",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: MsgReact.payloadSchema,
        run: (item) => callWorkRpc(MsgReact, item, toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Acknowledge mailbox mail without a reply (own seat; batch-capable)",
  ),
);

export const msgCommand = Command.make("msg").pipe(
  Command.withDescription("Message ops"),
  Command.withSubcommands([
    msgListCommand,
    msgSendCommand,
    msgSentCommand,
    msgReadCommand,
    msgReplyCommand,
    msgReactCommand,
  ]),
);

void Schema;
