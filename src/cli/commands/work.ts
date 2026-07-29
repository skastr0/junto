import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Schema } from "effect";
import {
  ArtifactPublishCliArgs,
  MsgListArgs,
  MsgSendArgs,
  RequestEscalateArgs,
  TasksClaimArgs,
  TasksListArgs,
  TasksUpdateArgs,
  type WorkOpName,
} from "../../shared/work-control";
import { materializeArtifactParts } from "../core/artifact-parts";
import { DEFAULT_BATCH_CONCURRENCY, runMutationBatch } from "../core/batch";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Args.text({ name: "input" }).pipe(
  Args.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const concurrencyOption = Options.integer("concurrency").pipe(
  Options.optional,
  Options.withDescription(
    `Max concurrent mutations (default ${DEFAULT_BATCH_CONCURRENCY}); reject <= 0`,
  ),
);

const timeoutOption = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
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
).pipe(Command.withDescription("Claim one or more tasks (batch-capable)"));

const tasksUpdateCommand = Command.make(
  "update",
  { input: jsonInputArg, concurrency: concurrencyOption, timeout: timeoutOption },
  ({ input, concurrency, timeout }) =>
    executeJsonCommand(
      "tasks update",
      runMutationBatch({
        input,
        concurrency: toUndefined(concurrency) ?? DEFAULT_BATCH_CONCURRENCY,
        itemSchema: TasksUpdateArgs,
        run: (item) => callDomain("tasks.update", item, toUndefined(timeout)),
      }),
    ),
).pipe(Command.withDescription("Update task state (batch-capable)"));

export const tasksCommand = Command.make("tasks").pipe(
  Command.withDescription("Task work-plane ops"),
  Command.withSubcommands([tasksListCommand, tasksClaimCommand, tasksUpdateCommand]),
);

// --- msg ---

const msgListCommand = Command.make(
  "list",
  { input: jsonInputArg, timeout: timeoutOption },
  ({ input, timeout }) =>
    executeJsonCommand(
      "msg list",
      Effect.gen(function* () {
        const item = yield* loadJsonInput(MsgListArgs, input);
        return yield* callDomain("msg.list", item, toUndefined(timeout));
      }),
    ),
).pipe(Command.withDescription("List messages on a connected node"));

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

export const msgCommand = Command.make("msg").pipe(
  Command.withDescription("Message ops"),
  Command.withSubcommands([msgListCommand, msgSendCommand]),
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
).pipe(Command.withDescription("Publish an artifact (path→b64 at CLI boundary)"));

export const artifactCommand = Command.make("artifact").pipe(
  Command.withDescription("Artifact ops"),
  Command.withSubcommands([artifactPublishCommand]),
);

void Schema;
