// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Result, Schema } from "effect";
import {
  OVERSEER_CATALOG,
  OVERSEER_MAX_REQUEST_BYTES,
  OVERSEER_OPERATION_NAMES,
  OverseerArgsSchemas,
  decodeOverseerArgs,
  decodeOverseerResult,
  type OverseerCatalogEntry,
  type OverseerOperation,
} from "../../shared/overseer-control";
import type { WorkOpName } from "../../shared/work-control";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { AuthError, InputError, RuntimeDown, WireError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand } from "../core/output";
import { WorkSocket } from "../core/socket";
import { OVERSEER_SKILL_MARKDOWN } from "./overseer-skill";

const toUndefined = <A>(value: Option.Option<A>) =>
  Option.isSome(value) ? value.value : undefined;

const jsonInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object, @file path, raw JSON string, or - for stdin"),
);

const optionalJsonInputArg = jsonInputArg.pipe(Argument.optional);

const timeoutOption = Flag.integer("timeout").pipe(
  Flag.optional,
  Flag.withDescription(`Socket call timeout in ms (default ${DEFAULT_TIMEOUT_MS})`),
);

const targetArg = Argument.string("target").pipe(
  Argument.withDescription("Overseer operation, command id, or family.verb"),
);

const inputModes = ["inline-json", "@file", "stdin"] as const;

const OVERSEER_WORK_OP = "overseer" as WorkOpName;

export const OVERSEER_UNAVAILABLE: ReadonlyArray<{
  readonly capability: string;
  readonly reason: string;
}> = [
  {
    capability: "grant or revoke overseer",
    reason: "Human-only toggle. Overseers cannot propagate.",
  },
  {
    capability: "delete own seat",
    reason:
      "Direct, indirect, canvas delete, alias, or binding replacement that removes this seat is refused.",
  },
  {
    capability: "operator viewport mutation",
    reason: "No pan, zoom, focus, resize, or switch. Screenshots observe only.",
  },
  {
    capability: "mint ether.overseer",
    reason: "Create, copy, configure, and reseat cannot mint or restore the grant.",
  },
  {
    capability: "pause/play as authority",
    reason: "Pause and play gate automated work only. They have no bearing on overseer command.",
  },
  {
    capability: "direct database or operator socket",
    reason: "Closed overseer operations over the existing process-bind work socket only.",
  },
  {
    capability: "caller-supplied principal",
    reason: "Identity is process-bind. No nodeRef or operator seat impersonation.",
  },
];

const commandNameFor = (entry: OverseerCatalogEntry): string =>
  entry.family === "overseer" ? `overseer ${entry.verb}` : `overseer ${entry.family} ${entry.verb}`;

const commandIdFor = (operation: OverseerOperation): string => `overseer.${operation}`;

const matchesOverseerTarget = (target: string, operation: OverseerOperation): boolean => {
  const normalized = target.trim();
  if (normalized.length === 0) return false;
  return (
    operation === normalized ||
    commandIdFor(operation) === normalized ||
    `overseer ${operation.replace(".", " ")}` === normalized ||
    (operation === "status" && (normalized === "status" || normalized === "overseer status"))
  );
};

export const unwrapOverseerSocketData = (data: unknown): Effect.Effect<unknown, WireError> => {
  const decoded = decodeOverseerResult(data);
  if (Result.isFailure(decoded)) {
    return Effect.fail(
      new WireError({
        type: "ProtocolError",
        message: "overseer result was not a valid OverseerResult",
        details: { hint: decoded.failure.message },
      }),
    );
  }
  const result = decoded.success;
  if (!result.ok) {
    return Effect.fail(
      new WireError({
        type: result.error.type,
        message: result.error.message,
        ...(result.error.details !== undefined ? { details: result.error.details } : {}),
      }),
    );
  }
  return Effect.succeed(result.data);
};

const callOverseer = (
  operation: OverseerOperation,
  args: unknown,
  timeout?: number,
): Effect.Effect<unknown, InputError | RuntimeDown | AuthError | WireError, WorkSocket> =>
  Effect.gen(function* () {
    const request = { operation, args };
    const encoded = JSON.stringify(request);
    if (Buffer.byteLength(encoded) > OVERSEER_MAX_REQUEST_BYTES) {
      return yield* Effect.fail(
        new InputError({
          message: `overseer request exceeds ${OVERSEER_MAX_REQUEST_BYTES} bytes`,
          path: "args",
        }),
      );
    }
    const socket = yield* WorkSocket;
    const data = yield* socket.call(OVERSEER_WORK_OP, request, timeout);
    return yield* unwrapOverseerSocketData(data);
  });

const loadOverseerArgs = (operation: OverseerOperation, input: Option.Option<string>) =>
  Effect.gen(function* () {
    const raw = Option.match(input, {
      onNone: () => "{}",
      onSome: (value) => (value.trim().length === 0 ? "{}" : value),
    });
    const value = yield* loadJsonInput(Schema.Unknown, raw);
    const decoded = decodeOverseerArgs(operation, value);
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(
        new InputError({
          message: decoded.failure.message,
          path: "args",
          expected: operation,
          received: value,
          hint: `vellum-command overseer schema show ${operation}`,
        }),
      );
    }
    return decoded.success;
  });

const FAMILY_HELP: Readonly<Record<string, string>> = {
  overseer: "Live grant and daemon surface for this process-bound overseer seat",
  canvas: "List, read, create, delete, digest, render, or screenshot canvases",
  node: "List, get, create, configure, move, resize, or delete nodes",
  edge: "List, get, verb-table, connect, configure, or disconnect edges",
  tasks: "Task work-plane ops without requiring a connecting edge",
  request: "Request list, get, create, resolve, comment",
  artifact: "Artifact list, get, publish, archive, delete",
  msg: "Mailbox list, send, read, reply, react",
  board: "Board list, create-topic, post, mark-read, tags, notify",
  pad: "Pad read, patch, digest, render, look-here, get, tagged",
  sheet: "Sheet read or configure",
  content: "Content ingest, path, stat, materialize",
  agent: "Agent list, get, reseat, start, wake, prompt, output, interrupt, stop",
  terminal: "Terminal list, get, start, input, output, resize, interrupt, stop",
  page: "Page list, get, open, goto, eval, screenshot, close, stop",
  scheduler: "Scheduler fire, status, configure",
  git: "Git status, log, show on a git node",
};

const describeEntry = (entry: OverseerCatalogEntry): string =>
  FAMILY_HELP[entry.family] !== undefined && entry.verb === "list"
    ? `${FAMILY_HELP[entry.family]}`
    : `Overseer ${entry.operation}${entry.mutation ? " (mutation)" : " (read)"}`;

const makeVerbCommand = (entry: OverseerCatalogEntry) =>
  Command.make(
    entry.verb,
    { input: optionalJsonInputArg, timeout: timeoutOption },
    ({ input, timeout }) =>
      executeJsonCommand(
        commandNameFor(entry),
        Effect.gen(function* () {
          const args = yield* loadOverseerArgs(entry.operation, input);
          return yield* callOverseer(entry.operation, args, toUndefined(timeout));
        }),
      ),
  ).pipe(Command.withDescription(describeEntry(entry)));

const familyEntries = new Map<string, OverseerCatalogEntry[]>();
for (const entry of OVERSEER_CATALOG) {
  if (entry.family === "overseer") continue;
  const list = familyEntries.get(entry.family) ?? [];
  list.push(entry);
  familyEntries.set(entry.family, list);
}

const familyCommands = [...familyEntries.entries()].map(([family, entries]) =>
  Command.make(family).pipe(
    Command.withDescription(FAMILY_HELP[family] ?? `Overseer ${family} operations`),
    Command.withSubcommands(entries.map(makeVerbCommand)),
  ),
);

const statusEntry = OVERSEER_CATALOG.find((entry) => entry.operation === "status");
if (statusEntry === undefined) {
  throw new Error("overseer catalog missing status");
}

const statusCommand = makeVerbCommand(statusEntry);

const schemaListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "overseer schema list",
    Effect.succeed({
      schemas: overseerSchemas.map((schema) => ({
        command_id: schema.command_id,
        command: schema.command,
        schema_id: schema.schema_id,
        description: schema.description,
        operation: schema.command_id.replace(/^overseer\./, ""),
        accepts_batch: false,
      })),
    }),
  ),
).pipe(Command.withDescription("List overseer JSON input schemas (offline)"));

const schemaShowCommand = Command.make("show", { target: targetArg }, ({ target }) =>
  executeJsonCommand(
    "overseer schema show",
    Effect.gen(function* () {
      const operation = OVERSEER_OPERATION_NAMES.find((name) =>
        matchesOverseerTarget(target, name),
      );
      if (operation === undefined) {
        return yield* Effect.fail(
          new InputError({
            message: `No overseer schema found for ${target}`,
            path: "target",
            hint: "vellum-command overseer schema list",
          }),
        );
      }
      const contract = overseerSchemas.find((schema) => schema.command_id === commandIdFor(operation));
      if (contract === undefined) {
        return yield* Effect.fail(
          new InputError({ message: `No overseer schema found for ${target}`, path: "target" }),
        );
      }
      return {
        command_id: contract.command_id,
        command: contract.command,
        schema_id: contract.schema_id,
        description: contract.description,
        accepts_batch: false,
        input_modes: [...inputModes],
        schema: Schema.toJsonSchemaDocument(contract.schema).schema,
        operation,
      };
    }),
  ),
).pipe(Command.withDescription("Show one overseer JSON input schema (offline)"));

const schemaCommand = Command.make("schema").pipe(
  Command.withDescription("Overseer schemas (offline, no daemon)"),
  Command.withSubcommands([schemaListCommand, schemaShowCommand]),
);

const examplesListCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "overseer examples list",
    Effect.succeed({
      examples: overseerExamples.map((example) => ({
        command_id: example.command_id,
        command: example.command,
        name: example.name,
        ...(example.description ? { description: example.description } : {}),
      })),
    }),
  ),
).pipe(Command.withDescription("List overseer examples (offline)"));

const examplesShowCommand = Command.make("show", { target: targetArg }, ({ target }) =>
  executeJsonCommand(
    "overseer examples show",
    Effect.gen(function* () {
      const examples = overseerExamples.filter((example) => {
        const operation = example.command_id.replace(/^overseer\./, "") as OverseerOperation;
        return (
          matchesOverseerTarget(target, operation) ||
          example.command_id === target.trim() ||
          example.command === target.trim()
        );
      });
      const first = examples[0];
      if (!first) {
        return yield* Effect.fail(
          new InputError({
            message: `No overseer examples found for ${target}`,
            path: "target",
            hint: "vellum-command overseer examples list",
          }),
        );
      }
      return {
        command_id: first.command_id,
        command: first.command,
        examples: examples.map((example) => ({
          name: example.name,
          ...(example.description ? { description: example.description } : {}),
          ...(example.args ? { args: example.args } : {}),
          ...(example.input !== undefined ? { input: example.input } : {}),
        })),
      };
    }),
  ),
).pipe(Command.withDescription("Show overseer examples for one operation (offline)"));

const examplesCommand = Command.make("examples").pipe(
  Command.withDescription("Overseer examples (offline, no daemon)"),
  Command.withSubcommands([examplesListCommand, examplesShowCommand]),
);

const skillCommand = Command.make("skill", {}, () =>
  executeJsonCommand(
    "overseer skill",
    Effect.succeed({
      name: "overseer",
      offline: true,
      daemon_required: false,
      format: "agent-skill-markdown",
      content: OVERSEER_SKILL_MARKDOWN,
    }),
  ),
).pipe(
  Command.withDescription(
    "Embedded overseer skill (offline, no daemon). Product text, not a global skill install.",
  ),
);

export const overseerOfflineCapabilities = () => ({
  offline: true,
  daemon_required: false,
  transport: {
    implemented: true,
    work_op: "overseer",
    request: { operation: "OverseerOperation", args: "optional" },
    inner_result: "{ok:true,operation,data}|{ok:false,operation,error}",
  },
  implemented: {
    cli_transport: OVERSEER_OPERATION_NAMES.slice(),
    offline: ["overseer skill", "overseer schema", "overseer examples", "overseer capabilities"],
  },
  unavailable: OVERSEER_UNAVAILABLE,
  handlers: {
    claimed: false,
    note:
      "CLI ships the full catalog. Live handler availability is not claimed offline. Run overseer status under a live granted seat, or treat Unsupported as missing handler.",
  },
  authority: {
    grant: "human-only",
    remote: "supported",
    edges_required: false,
    pause_play_has_bearing: false,
    self_deletion: false,
    operator_viewport_mutation: false,
    propagation: false,
  },
});

const capabilitiesCommand = Command.make("capabilities", {}, () =>
  executeJsonCommand("overseer capabilities", Effect.succeed(overseerOfflineCapabilities())),
).pipe(
  Command.withDescription(
    "Offline overseer surface: implemented CLI transport vs unavailable authority. Not live edge wiring.",
  ),
);

export const overseerCommand = Command.make("overseer").pipe(
  Command.withDescription(
    "Agent-native overseer commands (JSON). Requires a live human-granted overseer seat for live verbs.",
  ),
  Command.withSubcommands([
    skillCommand,
    schemaCommand,
    examplesCommand,
    capabilitiesCommand,
    statusCommand,
    ...familyCommands,
  ]),
);

export const overseerSchemas: ReadonlyArray<CommandSchemaContract> = OVERSEER_CATALOG.map(
  (entry) => ({
    command_id: commandIdFor(entry.operation),
    command: commandNameFor(entry),
    schema_id: `overseer.${entry.operation}.input/v1`,
    description: `${describeEntry(entry)}. Overseer; edges not required.`,
    schema: OverseerArgsSchemas[entry.operation],
    accepts_batch: false,
    input_modes: inputModes,
  }),
);

export const overseerExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: commandIdFor("canvas.batch"),
    command: "overseer canvas batch",
    name: "create and connect in one commit",
    description: "Single-canvas structural edits, validated and committed together. Read the canvas first for expectedRevision.",
    args: ["overseer", "canvas", "batch"],
    input: { operations: [
      { operation: "node.create", node: { id: "backlog", type: "text", text: "Backlog", x: 400, y: 0, width: 260, height: 120, ether: { entity: { kind: "task" } } } },
      { operation: "edge.connect", edge: { fromNode: "worker", toNode: "backlog", verb: "contributes" } },
    ] },
  },
  {
    command_id: commandIdFor("status"),
    command: "overseer status",
    name: "read live grant",
    description: "Process-bound live grant and daemon surface. Requires the work socket.",
    args: ["overseer", "status"],
    input: {},
  },
  {
    command_id: commandIdFor("canvas.list"),
    command: "overseer canvas list",
    name: "list canvases",
    args: ["overseer", "canvas", "list"],
    input: {},
  },
  {
    command_id: commandIdFor("canvas.create"),
    command: "overseer canvas create",
    name: "create a canvas",
    args: ["overseer", "canvas", "create"],
    input: { canvas: "work" },
  },
  {
    command_id: commandIdFor("canvas.read"),
    command: "overseer canvas read",
    name: "read caller canvas",
    args: ["overseer", "canvas", "read"],
    input: {},
  },
  {
    command_id: commandIdFor("node.create"),
    command: "overseer node create",
    name: "create a text node",
    description: "Strict JSON Canvas draft. No overseer grant field.",
    args: ["overseer", "node", "create"],
    input: {
      node: { type: "text", text: "note", x: 0, y: 0, width: 220, height: 84 },
    },
  },
  {
    command_id: commandIdFor("node.move"),
    command: "overseer node move",
    name: "move a node",
    args: ["overseer", "node", "move"],
    input: { nodeId: "n1", x: 40, y: 80 },
  },
  {
    command_id: commandIdFor("edge.connect"),
    command: "overseer edge connect",
    name: "connect two agents",
    args: ["overseer", "edge", "connect"],
    input: { edge: { fromNode: "a", toNode: "b", verb: "messages" } },
  },
  {
    command_id: commandIdFor("tasks.list"),
    command: "overseer tasks list",
    name: "list tasks on a sink",
    args: ["overseer", "tasks", "list"],
    input: { target: "tasks-1" },
  },
  {
    command_id: commandIdFor("request.create"),
    command: "overseer request create",
    name: "create a request as overseer",
    description: "Overseer request.create is not the edge-scoped escalate command.",
    args: ["overseer", "request", "create"],
    input: { target: "requests-1", brief: "Need a ruling" },
  },
  {
    command_id: commandIdFor("agent.reseat"),
    command: "overseer agent reseat",
    name: "reseat an agent harness",
    description: "Reseat does not inherit the overseer grant.",
    args: ["overseer", "agent", "reseat"],
    input: { nodeId: "agent-1", harness: "amp" },
  },
  {
    command_id: commandIdFor("page.screenshot"),
    command: "overseer page screenshot",
    name: "observe a page",
    description: "Observes only. Does not move the operator viewport.",
    args: ["overseer", "page", "screenshot"],
    input: { sessionId: "session-1" },
  },
  {
    command_id: commandIdFor("git.status"),
    command: "overseer git status",
    name: "git status on a git node",
    args: ["overseer", "git", "status"],
    input: { nodeId: "git-1" },
  },
];

export const overseerCapabilities: ReadonlyArray<CommandCapability> = [
  {
    command_id: "overseer.skill",
    command: "overseer skill",
    category: "discovery",
    description:
      "Embedded overseer skill markdown (offline, no daemon). Not a global skill install.",
  },
  {
    command_id: "overseer.schema",
    command: "overseer schema",
    category: "discovery",
    description: "Overseer JSON input schemas (offline, no daemon).",
  },
  {
    command_id: "overseer.examples",
    command: "overseer examples",
    category: "discovery",
    description: "Overseer examples (offline, no daemon).",
  },
  {
    command_id: "overseer.capabilities",
    command: "overseer capabilities",
    category: "discovery",
    description:
      "Implemented CLI transport vs unavailable authority. Does not claim live handlers.",
  },
  ...OVERSEER_CATALOG.map(
    (entry): CommandCapability => ({
      command_id: commandIdFor(entry.operation),
      command: commandNameFor(entry),
      category: entry.mutation ? "workflow" : "discovery",
      description: describeEntry(entry),
      schemas: overseerSchemas.filter((schema) => schema.command_id === commandIdFor(entry.operation)),
      examples: overseerExamples.filter(
        (example) => example.command_id === commandIdFor(entry.operation),
      ),
    }),
  ),
];
