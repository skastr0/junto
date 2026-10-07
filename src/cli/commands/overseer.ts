// V4: Args→Argument, Options→Flag. Map: ../effect-v4-import-map.ts
import { Argument, Command, Flag } from "effect/unstable/cli";
import { readFile } from "node:fs/promises";
import { Effect, Option, Result, Schema } from "effect";
import {
  OVERSEER_CATALOG,
  OVERSEER_MAX_REQUEST_BYTES,
  OVERSEER_OPERATION_NAMES,
  OVERSEER_SECRET_ARGS_OPERATIONS,
  OverseerArgsSchemas,
  OverseerSecretPutInput,
  decodeOverseerArgs,
  decodeOverseerResult,
  type OverseerCatalogEntry,
  type OverseerOperation,
} from "../../shared/overseer-control";
import type { WorkOpName } from "../../shared/work-control";
import { overseerOperationEnabled } from "../../shared/features";
import type {
  CommandCapability,
  CommandExample,
  CommandSchemaContract,
} from "../core/discovery";
import { DEFAULT_TIMEOUT_MS } from "../core/constants";
import { executeReportCommand } from "../core/env-report";
import { AuthError, InputError, RuntimeDown, WireError } from "../core/errors";
import { loadJsonInput } from "../core/json";
import { executeJsonCommand, executeJsonCommandWithVerdict } from "../core/output";
import { decodeSecretPutInput, readSecretValue } from "../core/secret-input";
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

const secretPutInputModes = ["inline-json", "@file"] as const;

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
  // Offline targets resolve against the live catalog: a feature-gated
  // operation is not discoverable even when its name is typed directly.
  if (!OVERSEER_CATALOG.some((entry) => entry.operation === operation)) return false;
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
          // What was received is repeated to help fix it, except where it
          // could be a secret.
          ...(OVERSEER_SECRET_ARGS_OPERATIONS.has(operation) ? {} : { received: value }),
          hint: `junto overseer schema show ${operation}`,
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
  agent: "Agent list, get, reseat, start, wake, prompt, output, interrupt, stop, offboard, offboard-status, offboard-rules, offboard-configure",
  terminal: "Terminal list, get, start, input, output, resize, interrupt, stop",
  page: "Page list, get, open, goto, eval, screenshot, close, stop",
  scheduler: "Scheduler fire, status, configure",
  git: "Git status, log, show on a git node",
  env: "Region environment: show, source-add, source-edit, source-remove, source-reorder, seal, folders, doctor",
  secret: "Junto's own secret store on this machine: put (value on stdin), delete, list",
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

/**
 * `env doctor` prints the resolver's report whole and exits non-zero when a
 * required source could not be read.
 */
const makeDoctorCommand = (entry: OverseerCatalogEntry) =>
  Command.make(
    entry.verb,
    { input: optionalJsonInputArg, timeout: timeoutOption },
    ({ input, timeout }) =>
      executeReportCommand(
        commandNameFor(entry),
        Effect.gen(function* () {
          const args = yield* loadOverseerArgs(entry.operation, input);
          return yield* callOverseer(entry.operation, args, toUndefined(timeout));
        }),
      ),
  ).pipe(
    Command.withDescription(
      "Region environment report: names, kinds, origins and status, never a value. Exits non-zero when a required source is missing",
    ),
  );

/** A seat that was refused: the answer is printed whole, the exit code says so. */
export const offboardRefusedAny = (data: unknown): boolean =>
  typeof data === "object" && data !== null &&
  typeof (data as { refused?: unknown }).refused === "number" &&
  (data as { refused: number }).refused > 0;

/**
 * `agent offboard` answers per seat. A refused seat is not a command error,
 * so the result prints as a success and the exit code is non-zero.
 */
const makeOffboardCommand = (entry: OverseerCatalogEntry) =>
  Command.make(
    entry.verb,
    { input: optionalJsonInputArg, timeout: timeoutOption },
    ({ input, timeout }) =>
      executeJsonCommandWithVerdict(
        commandNameFor(entry),
        Effect.gen(function* () {
          const args = yield* loadOverseerArgs(entry.operation, input);
          return yield* callOverseer(entry.operation, args, toUndefined(timeout));
        }),
        offboardRefusedAny,
      ),
  ).pipe(
    Command.withDescription(
      "Ask seats to offboard, or end idle sessions now. One result per seat; exits non-zero when any seat was refused",
    ),
  );

const secretPutInputArg = Argument.string("input").pipe(
  Argument.withDescription("JSON object {} or {secretId}, inline or @file. The value is read from stdin"),
  Argument.optional,
);

const readArgumentFile = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new InputError({ message: "the @file argument could not be read", path: "input" }),
  });

/**
 * `secret put` reads the value from stdin only, so it cannot share the JSON
 * input path of the other verbs: there the argument is the whole request.
 */
const makeSecretPutCommand = (entry: OverseerCatalogEntry) =>
  Command.make(
    entry.verb,
    { input: secretPutInputArg, timeout: timeoutOption },
    ({ input, timeout }) =>
      executeJsonCommand(
        commandNameFor(entry),
        Effect.gen(function* () {
          const named = yield* decodeSecretPutInput(toUndefined(input), readArgumentFile);
          const value = yield* readSecretValue({
            isTTY: process.stdin.isTTY === true,
            text: () => new Response(Bun.stdin.stream()).text(),
          });
          return yield* callOverseer(entry.operation, { ...named, value }, toUndefined(timeout));
        }),
      ),
  ).pipe(
    Command.withDescription(
      "Save a secret in Junto's own store on this machine. The value is read from stdin only",
    ),
  );

const makeFamilyVerbCommand = (entry: OverseerCatalogEntry) =>
  entry.operation === "secret.put"
    ? makeSecretPutCommand(entry)
    : entry.operation === "env.doctor"
      ? makeDoctorCommand(entry)
      : entry.operation === "agent.offboard"
        ? makeOffboardCommand(entry)
        : makeVerbCommand(entry);

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
    Command.withSubcommands(entries.map(makeFamilyVerbCommand)),
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
            hint: "junto overseer schema list",
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
            hint: "junto overseer examples list",
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
    cli_transport: OVERSEER_CATALOG.map((entry) => entry.operation),
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
    // `secret put` documents what the command takes, which is not what the
    // wire carries: the value never is an argument.
    schema: entry.operation === "secret.put"
      ? OverseerSecretPutInput
      : OverseerArgsSchemas[entry.operation],
    accepts_batch: false,
    input_modes: entry.operation === "secret.put" ? secretPutInputModes : inputModes,
  }),
);

const declaredOverseerExamples: ReadonlyArray<CommandExample> = [
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
  {
    command_id: commandIdFor("agent.offboard"),
    command: "overseer agent offboard",
    name: "ask several seats to offboard and continue",
    description: "Each seat's agent is asked to offboard: it writes its own notes and a fresh session starts right away. Costs each seat one turn, so it is right while the seat's cache is still warm. One row per seat, in the order asked.",
    args: ["overseer", "agent", "offboard"],
    input: { nodeIds: ["agent-1", "agent-2", "agent-3"] },
  },
  {
    command_id: commandIdFor("agent.offboard"),
    command: "overseer agent offboard",
    name: "ask a seat to offboard and rest",
    description: "The seat closes its session with its notes and rests until mail wakes it.",
    args: ["overseer", "agent", "offboard"],
    input: { nodeIds: ["agent-1"], action: "ask", mode: "rest" },
  },
  {
    command_id: commandIdFor("agent.offboard"),
    command: "overseer agent offboard",
    name: "end idle sessions now",
    description: "Junto ends the session itself: no turn, no notes. Only for a seat that is idle, offline or resting; any other seat is a refused row with its reason and the command exits non-zero.",
    args: ["overseer", "agent", "offboard"],
    input: { nodeIds: ["agent-1", "agent-2"], action: "now" },
  },
  {
    command_id: commandIdFor("agent.offboard-status"),
    command: "overseer agent offboard-status",
    name: "see which action fits each seat before offboarding",
    description: "Whether ending now is allowed, how long the seat has sat still, whether it is past its cache window, the preferred action, and the session's work time and size.",
    args: ["overseer", "agent", "offboard-status"],
    input: { nodeIds: ["agent-1", "agent-2"] },
  },
  {
    command_id: commandIdFor("agent.offboard-rules"),
    command: "overseer agent offboard-rules",
    name: "read the automatic offboard rules",
    description: "The installation's rules with any harness overrides, and what they come to for each harness.",
    args: ["overseer", "agent", "offboard-rules"],
    input: {},
  },
  {
    command_id: commandIdFor("agent.offboard-configure"),
    command: "overseer agent offboard-configure",
    name: "offboard automatically after three hours and turn the idle nudge on",
    description: "Changes only the fields given and returns the rules after the change.",
    args: ["overseer", "agent", "offboard-configure"],
    input: { auto: { minutes: 180 }, nudge: { enabled: true } },
  },
  {
    command_id: commandIdFor("agent.offboard-configure"),
    command: "overseer agent offboard-configure",
    name: "give one harness its own cache window, and remove another's override",
    description: "An override names only what differs from the installation. null removes it.",
    args: ["overseer", "agent", "offboard-configure"],
    input: { harness: { claude: { cacheWindowMinutes: 300, auto: { minutes: 300 } }, codex: null } },
  },
  {
    command_id: commandIdFor("agent.offboard-configure"),
    command: "overseer agent offboard-configure",
    name: "let the automatic rules act on smaller sessions",
    description: "A session is worth cutting once it worked this long or its transcript reached about this many tokens. The automatic rules leave anything smaller alone.",
    args: ["overseer", "agent", "offboard-configure"],
    input: { worth: { workMinutes: 20, tokens: 150000 } },
  },
  {
    command_id: commandIdFor("env.show"),
    command: "overseer env show",
    name: "read a region's environment",
    description: "The environment as stored on the region: names and references, never a secret value.",
    args: ["overseer", "env", "show"],
    input: { nodeId: "region-1" },
  },
  {
    command_id: commandIdFor("env.source-add"),
    command: "overseer env source-add",
    name: "give every seat in a region an existing Keychain item",
    description: "Reads the item in place at each launch. The id is generated when omitted; the source is appended unless index is given.",
    args: ["overseer", "env", "source-add"],
    input: {
      nodeId: "region-1",
      source: { kind: "keychain", name: "OP_SERVICE_ACCOUNT_TOKEN", service: "op-service-account" },
    },
  },
  {
    command_id: commandIdFor("env.source-add"),
    command: "overseer env source-add",
    name: "resolve a 1Password reference with a token from another source",
    description: "tokenFrom names the source in scope that yields the service account token.",
    args: ["overseer", "env", "source-add"],
    input: {
      nodeId: "region-1",
      source: {
        id: "db-url",
        kind: "onepassword",
        name: "DATABASE_URL",
        ref: "op://Engineering/database/url",
        tokenFrom: "op-token",
        required: true,
      },
    },
  },
  {
    command_id: commandIdFor("env.source-edit"),
    command: "overseer env source-edit",
    name: "replace a source whole",
    description: "The source is replaced as given and keeps its id.",
    args: ["overseer", "env", "source-edit"],
    input: {
      nodeId: "region-1",
      sourceId: "node-env",
      source: { kind: "value", name: "NODE_ENV", value: "production" },
    },
  },
  {
    command_id: commandIdFor("env.source-remove"),
    command: "overseer env source-remove",
    name: "remove a source",
    args: ["overseer", "env", "source-remove"],
    input: { nodeId: "region-1", sourceId: "node-env" },
  },
  {
    command_id: commandIdFor("env.source-reorder"),
    command: "overseer env source-reorder",
    name: "set the order sources apply in",
    description: "The complete new order. A later source overrides an earlier one by name.",
    args: ["overseer", "env", "source-reorder"],
    input: { nodeId: "region-1", sourceIds: ["op-token", "db-url"] },
  },
  {
    command_id: commandIdFor("env.seal"),
    command: "overseer env seal",
    name: "seal a region",
    description: "Seats inside a sealed region inherit nothing from regions outside it.",
    args: ["overseer", "env", "seal"],
    input: { nodeId: "region-1", sealed: true },
  },
  {
    command_id: commandIdFor("env.folders"),
    command: "overseer env folders",
    name: "set the folders seats inside are given",
    description: "Sets the whole list. Absolute paths or ~/ paths.",
    args: ["overseer", "env", "folders"],
    input: { nodeId: "region-1", folders: ["~/.config/gh", "/opt/shared/certs"] },
  },
  {
    command_id: commandIdFor("env.doctor"),
    command: "overseer env doctor",
    name: "report the whole canvas",
    description: "What every seat would launch with: names, kinds, origins and status, never a value. Exits non-zero when a required source is missing.",
    args: ["overseer", "env", "doctor"],
    input: {},
  },
  {
    command_id: commandIdFor("env.doctor"),
    command: "overseer env doctor",
    name: "report one region or one seat",
    args: ["overseer", "env", "doctor"],
    input: { nodeId: "region-1" },
  },
  {
    command_id: commandIdFor("secret.put"),
    command: "overseer secret put",
    name: "save a new secret",
    description: "The value is read from stdin only: pipe it in. The result carries the id to name in a secret source.",
    args: ["overseer", "secret", "put"],
    input: {},
  },
  {
    command_id: commandIdFor("secret.put"),
    command: "overseer secret put",
    name: "replace the value behind an id",
    description: "The value is read from stdin only: pipe it in.",
    args: ["overseer", "secret", "put"],
    input: { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70" },
  },
  {
    command_id: commandIdFor("secret.delete"),
    command: "overseer secret delete",
    name: "remove a secret from this machine",
    args: ["overseer", "secret", "delete"],
    input: { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70" },
  },
  {
    command_id: commandIdFor("secret.list"),
    command: "overseer secret list",
    name: "list the secret ids on this machine",
    description: "Ids only.",
    args: ["overseer", "secret", "list"],
    input: {},
  },
];

/** Examples follow their operation: a disabled family has no recipe. */
export const overseerExamples: ReadonlyArray<CommandExample> =
  declaredOverseerExamples.filter((example) =>
    overseerOperationEnabled(example.command_id.replace(/^overseer\./, "")),
  );

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
