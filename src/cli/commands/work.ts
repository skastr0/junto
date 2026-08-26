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
  PreambleArgs,
  RequestEscalateArgs,
  RulingsArgs,
  TasksClaimArgs,
  TasksClaimsArgs,
  TasksCreateCliArgs,
  TasksListArgs,
  TasksShowArgs,
  TasksUpdateCliArgs,
  type WorkOpName,
} from "../../shared/work-control";
import { tasksBoardCommand } from "./board";
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
).pipe(Command.withDescription("Assign one or more tasks to this seat (batch-capable)"));

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
                  path: "holdFor",
                  received: item.holdFor,
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
                  path: "holdFor",
                  received: item.holdFor,
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
    "Update task state — claim responses and waivers on completionEvidence, forward with next, send back with defect (batch-capable)",
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
    "Show one task with its journey — prior stations appear as what they published, never their interiors",
  ),
);

const tasksClaimsCommand = Command.make(
  "claims",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "tasks claims",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(TasksClaimsArgs, input);
        return yield* callDomain("tasks.claims", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Effective claims at a station with provenance; name a task for readiness (unanswered claims, ticket status)",
  ),
);

export const tasksCommand = Command.make("tasks").pipe(
  Command.withDescription("Task work-plane ops"),
  Command.withSubcommands([
    tasksListCommand,
    tasksShowCommand,
    tasksCreateCommand,
    tasksClaimCommand,
    tasksClaimsCommand,
    tasksUpdateCommand,
    tasksBoardCommand,
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
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "msg send",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: MsgSendArgs,
        run: (item) => callDomain("msg.send", item, toUndefined(timeout)),
      }),
    ),
).pipe(Command.withDescription("Send a message (batch-capable)"));

const msgReadCommand = Command.make(
  "read",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "msg read",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: MsgReadArgs,
        run: (item) => callDomain("msg.read", item, toUndefined(timeout)),
      }),
    ),
).pipe(
  Command.withDescription(
    "Mark a mailbox message read (own seat only; batch-capable)",
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
    "Reply to factory mail and mark inReplyTo read (batch-capable)",
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
    msgReadCommand,
    msgReplyCommand,
    msgReactCommand,
  ]),
);

/**
 * Escalate: file a request, mark the seat blocked, return a stop directive.
 * Hold-until-answer is TODO (fire-and-block).
 */
export const escalateCommand = Command.make(
  "escalate",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "escalate",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(RequestEscalateArgs, input);
        return yield* callDomain("request.escalate", item, toUndefined(timeout));
      }),
    ),
).pipe(
  Command.withDescription(
    "Escalate to the operator: create request, block seat, return stop directive",
  ),
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
