// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";
import {
  ArtifactPublishCliArgs,
  BoardCreateTopicArgs,
  BoardListArgs,
  BoardMarkReadArgs,
  BoardPostArgs,
  BoardTagsListArgs,
  MsgListArgs,
  MsgReactArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  MsgPromptArgs,
  MsgSentArgs,
  VerdictPostArgs,
  PreambleArgs,
  RulingsArgs,
  TasksClaimArgs,
  TasksRulesArgs,
  TasksCreateCliArgs,
  TasksListArgs,
  TasksShowArgs,
  TasksUpdateCliArgs,
  type WorkOpName,
} from "../../shared/work-control";
import { tasksCheckCommand } from "./board";
import { tasksWaitCommand } from "./seat";
import { toTasksCreateArgs, toTasksUpdateArgs } from "../core/duration";
import { InputError } from "../core/errors";
import { materializeArtifactParts } from "../core/artifact-parts";
import { DEFAULT_BATCH_CONCURRENCY, runMutationBatch } from "../core/batch";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const optionalJsonInputArg = jsonInputArg.pipe(Argument.optional);

const concurrencyOption = Flag.integer("concurrency").pipe(
  Flag.optional,
  Flag.withDescription(
    `Max concurrent mutations (default ${DEFAULT_BATCH_CONCURRENCY}); reject <= 0`,
  ),
);

const timeoutOption = Flag.integer("timeout").pipe(
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

// --- tasks ---

const tasksListCommand = Command.make(
  "list",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "tasks list",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(TasksListArgs, input);
        return yield* callDomain("tasks.list", item, toUndefined(timeout));
      }),
    ),
).pipe(Command.withDescription("List tasks on a connected task node"));

const tasksClaimCommand = Command.make(
  "claim",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "tasks claim",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: TasksClaimArgs,
        run: (item) => callDomain("tasks.claim", item, toUndefined(timeout)),
      }),
    ),
).pipe(Command.withDescription("Claim one or more tasks for this seat (batch-capable)"));

const tasksCreateCommand = Command.make(
  "create",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "tasks create",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: TasksCreateCliArgs,
        run: (item) =>
          Effect.gen(function* () {
            const lowered = toTasksCreateArgs(item);
            if (!lowered.ok) {
              return yield* Effect.fail(
                new InputError({
                  message: lowered.message,
                  path: "waitFor",
                  received: item.waitFor,
                }),
              );
            }
            return yield* callDomain(
              "tasks.create",
              lowered.args,
              toUndefined(timeout),
            );
          }),
      }),
    ),
).pipe(Command.withDescription("Create one or more tasks on a connected sink (batch-capable)"));

const tasksUpdateCommand = Command.make(
  "update",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "tasks update",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: TasksUpdateCliArgs,
        run: (item) =>
          Effect.gen(function* () {
            const lowered = toTasksUpdateArgs(item);
            if (!lowered.ok) {
              return yield* Effect.fail(
                new InputError({
                  message: lowered.message,
                  path: "waitFor",
                  received: item.waitFor,
                }),
              );
            }
            return yield* callDomain(
              "tasks.update",
              lowered.args,
              toUndefined(timeout),
            );
          }),
      }),
    ),
).pipe(
  Command.withDescription(
    "Update task state — claims and waivers on completionEvidence, send on with next, send back with defect (batch-capable)",
  ),
);

const tasksShowCommand = Command.make(
  "show",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "tasks show",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(TasksShowArgs, input);
        return yield* callDomain("tasks.show", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Show one task with its visits — prior boards expose handoff notes and cited refs, never their interiors",
  ),
);

const tasksRulesCommand = Command.make(
  "rules",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "tasks rules",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(TasksRulesArgs, input);
        return yield* callDomain("tasks.rules", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Rules in force at a board with provenance; name a task for readiness",
  ),
);

export const tasksCommand = Command.make("tasks").pipe(
  Command.withDescription("Task work-plane ops"),
  Command.withSubcommands([
    tasksWaitCommand,
    tasksListCommand,
    tasksShowCommand,
    tasksCreateCommand,
    tasksClaimCommand,
    tasksRulesCommand,
    tasksUpdateCommand,
    tasksCheckCommand,
  ]),
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

const verdictPostCommand = Command.make(
  "post",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) => executeJsonCommand(
    "verdict post",
    runMutationBatch({
      input,
      concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
      itemSchema: VerdictPostArgs,
      run: (item) => callDomain("verdict.post", item, toUndefined(timeout)),
    }),
  ),
).pipe(Command.withDescription("Post a green or blocking verdict for an exact review subject"));

export const verdictCommand = Command.make("verdict").pipe(
  Command.withDescription("Post durable reviews through a current reviews edge"),
  Command.withSubcommands([verdictPostCommand]),
);

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
        const item = yield* loadJsonInput(MsgListArgs, raw);
        return yield* callDomain("msg.list", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "List this seat's inbox (marks listed mail read) or a connected peer's mailbox",
  ),
);

const msgSendCommand = Command.make(
  "send",
  {
    input: jsonInputArg,
    text: Argument.string("text").pipe(Argument.optional),
    prompt: Flag.boolean("prompt").pipe(Flag.withDefault(false)),
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
        itemSchema: prompt ? MsgPromptArgs : MsgSendArgs,
        run: (item) => callDomain(prompt ? "msg.prompt" : "msg.send", item, toUndefined(timeout)),
      }),
    ),
).pipe(Command.withDescription(
  "Send mail, typed into the seat's input at once: a short notice line, or with --prompt the full text (batch-capable)",
));

const msgSentCommand = Command.make(
  "sent",
  { input: optionalJsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) => executeJsonCommand(
    "msg sent",
    Effect.gen(function* () {
      const item = yield* loadJsonInput(MsgSentArgs, toUndefined(input) ?? "{}");
      return yield* callDomain("msg.sent", item, toUndefined(timeout));
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
        itemSchema: MsgReadArgs,
        run: (item) => callDomain("msg.read", item, toUndefined(timeout)),
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
        itemSchema: MsgReplyArgs,
        run: (item) => callDomain("msg.reply", item, toUndefined(timeout)),
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
        itemSchema: MsgReactArgs,
        run: (item) => callDomain("msg.react", item, toUndefined(timeout)),
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

// --- artifact ---

const artifactPublishCommand = Command.make(
  "publish",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "artifact publish",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: ArtifactPublishCliArgs,
        run: (item) =>
          Effect.gen(function* () {
            const wire = yield* materializeArtifactParts(item);
            const socket = yield* WorkSocket;
            return yield* socket.call(
              "artifact.publish",
              wire,
              toUndefined(timeout),
            );
          }),
      }),
    ),
).pipe(Command.withDescription("Publish an artifact with text/data or ContentRef parts"));

export const artifactCommand = Command.make("artifact").pipe(
  Command.withDescription("Artifact ops"),
  Command.withSubcommands([artifactPublishCommand]),
);

// --- board (bulletin) ---

const boardListCommand = Command.make(
  "list",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "board list",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(BoardListArgs, input);
        return yield* callDomain("board.list", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "List topics/posts on a connected bulletin board (optional participation)",
  ),
);

const boardTopicCommand = Command.make(
  "topic",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "board topic",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: BoardCreateTopicArgs,
        run: (item) =>
          callDomain("board.create_topic", item, toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Create a board topic (does not notify other agents)",
  ),
);

const boardPostCommand = Command.make(
  "post",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "board post",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: BoardPostArgs,
        run: (item) => callDomain("board.post", item, toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Post a note under a topic (optional; mark_read is enough to clear attention)",
  ),
);

const boardReadCommand = Command.make(
  "read",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "board read",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: BoardMarkReadArgs,
        run: (item) => callDomain("board.mark_read", item, toUndefined(timeout)),
      }),
    ),
).pipe(Command.withDescription("Mark a topic read without replying"));

const boardTagsCommand = Command.make(
  "tags",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "board tags",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(BoardTagsListArgs, input);
        return yield* callDomain("board.tags", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "List posts that tag this seat (async collab inbox — no ack required)",
  ),
);

export const boardCommand = Command.make("board").pipe(
  Command.withDescription(
    "Bulletin board ops — optional shared context; never a decision inbox",
  ),
  Command.withSubcommands([
    boardListCommand,
    boardTopicCommand,
    boardPostCommand,
    boardReadCommand,
    boardTagsCommand,
  ]),
);

void Schema;
