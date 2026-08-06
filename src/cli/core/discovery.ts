// S7: effect/JsonSchema → effect/JsonSchema on V4 pin (see ../effect-v4-import-map.ts)
import { Schema } from "effect";
import {
  CloseRequest,
  EvalRequest,
  GotoRequest,
  OpenRequest,
  ScreenshotRequest,
  StopRequest,
} from "../../shared/browser-control";
import { BROWSER_ENABLED } from "../../shared/features";
import {
  ArtifactPublishCliArgs,
  ContentMaterializeArgs,
  ContentPathArgs,
  ContentStatArgs,
  EmptyArgs,
  MsgListArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  PreambleArgs,
  RequestEscalateArgs,
  TasksClaimArgs,
  TasksCreateArgs,
  TasksListArgs,
  TasksUpdateArgs,
} from "../../shared/work-control";
import { DEFAULT_BATCH_CONCURRENCY } from "./constants";

export type CommandCategory = "workflow" | "diagnostic" | "discovery";

export interface CommandSchemaContract {
  readonly command_id: string;
  readonly command: string;
  readonly schema_id: string;
  readonly description: string;
  readonly schema: Schema.Top;
  readonly accepts_batch?: boolean;
  readonly input_modes?: readonly string[];
}

export interface CommandExample {
  readonly command_id: string;
  readonly command: string;
  readonly name: string;
  readonly description?: string;
  readonly args?: readonly string[];
  readonly input?: unknown;
}

export interface CommandCapability {
  readonly command_id: string;
  readonly command: string;
  readonly category: CommandCategory;
  readonly description: string;
  readonly schemas?: readonly CommandSchemaContract[];
  readonly examples?: readonly CommandExample[];
  readonly batch?: {
    readonly accepts_batch: boolean;
    readonly default_concurrency: number;
    readonly supports_concurrency_option: boolean;
  };
}

export interface CapabilityInvocation {
  readonly port: "browser.automate";
  readonly command: "vellum-command browser";
  readonly discover: "vellum-command browser pages --json";
}

const BROWSER_INVOCATION: CapabilityInvocation = {
  port: "browser.automate",
  command: "vellum-command browser",
  discover: "vellum-command browser pages --json",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invocationsForConnected = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.grants)) return entry;
    const invocations =
      BROWSER_ENABLED && entry.grants.includes("browser.automate")
        ? [BROWSER_INVOCATION]
        : [];
    return invocations.length > 0 ? { ...entry, invocations } : entry;
  });
};

/**
 * Add command realization to live edge grants. The daemon remains the authority
 * for what is held; the CLI explains how the agent can exercise a cross-plane
 * grant without requiring a harness-native tool registry.
 */
export const annotateCapabilityInvocations = <T>(value: T): T => {
  if (!isRecord(value)) return value;
  const capabilities = isRecord(value.capabilities)
    ? {
        ...value.capabilities,
        connected: invocationsForConnected(value.capabilities.connected),
      }
    : value.capabilities;
  return {
    ...value,
    connected: invocationsForConnected(value.connected),
    ...(capabilities === undefined ? {} : { capabilities }),
  } as T;
};

export const renderSchemaContract = (contract: CommandSchemaContract) => ({
  command_id: contract.command_id,
  command: contract.command,
  schema_id: contract.schema_id,
  description: contract.description,
  accepts_batch: contract.accepts_batch ?? false,
  input_modes: contract.input_modes ?? ["inline-json", "@file", "stdin"],
  schema: Schema.toJsonSchemaDocument(contract.schema).schema,
});

const inputModes = ["inline-json", "@file", "stdin"] as const;

export const tasksListSchema: CommandSchemaContract = {
  command_id: "tasks.list",
  command: "tasks list",
  schema_id: "tasks.list.input/v1",
  description: "List tasks on a connected task node.",
  schema: TasksListArgs,
  input_modes: inputModes,
};

export const tasksClaimSchema: CommandSchemaContract = {
  command_id: "tasks.claim",
  command: "tasks claim",
  schema_id: "tasks.claim.input/v1",
  description: "Claim a task (submitted → working).",
  schema: TasksClaimArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const tasksCreateSchema: CommandSchemaContract = {
  command_id: "tasks.create",
  command: "tasks create",
  schema_id: "tasks.create.input/v2",
  description:
    "Create a proposal on a connected task node for operator review. Same authoring fields as executable tasks (brief, required metadata.details description, reason, media, dependsOn, finishCriteria); approval mints a submitted Task.",
  schema: TasksCreateArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const tasksUpdateSchema: CommandSchemaContract = {
  command_id: "tasks.update",
  command: "tasks update",
  schema_id: "tasks.update.input/v2",
  description:
    "Transition a task to a new task state. On completed, optional completionEvidence supplies artifacts + git commits for finish-criteria gates.",
  schema: TasksUpdateArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const msgListSchema: CommandSchemaContract = {
  command_id: "msg.list",
  command: "msg list",
  schema_id: "msg.list.input/v1",
  description: "List messages on a connected agent/task node.",
  schema: MsgListArgs,
  input_modes: inputModes,
};

export const msgSendSchema: CommandSchemaContract = {
  command_id: "msg.send",
  command: "msg send",
  schema_id: "msg.send.input/v1",
  description: "Append a message to a connected node.",
  schema: MsgSendArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const msgReadSchema: CommandSchemaContract = {
  command_id: "msg.read",
  command: "msg read",
  schema_id: "msg.read.input/v1",
  description:
    "Mark a mailbox message as read (own seat only). Stops re-delivery pressure when PTY ack is enough but agent must self-heal.",
  schema: MsgReadArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const msgReplySchema: CommandSchemaContract = {
  command_id: "msg.reply",
  command: "msg reply",
  schema_id: "msg.reply.input/v1",
  description:
    "Reply to factory mail: send text to target and mark inReplyTo read on own mailbox.",
  schema: MsgReplyArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const preambleSchema: CommandSchemaContract = {
  command_id: "preamble",
  command: "preamble",
  schema_id: "preamble.input/v1",
  description: "Show a short-lived thought bubble above this agent node.",
  schema: PreambleArgs,
  input_modes: inputModes,
};

export const requestEscalateSchema: CommandSchemaContract = {
  command_id: "request.escalate",
  command: "escalate",
  schema_id: "request.escalate.input/v1",
  description:
    "Escalate to the operator: create a request, block this seat, return a stop directive. Subsequent work ops return Blocked until the request is answered.",
  schema: RequestEscalateArgs,
  input_modes: inputModes,
};

export const artifactPublishSchema: CommandSchemaContract = {
  command_id: "artifact.publish",
  command: "artifact publish",
  schema_id: "artifact.publish.input/v2",
  description:
    "Publish an artifact; raw parts may use path and optional task provenance names the exact task sink and id.",
  schema: ArtifactPublishCliArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const contentPathSchema: CommandSchemaContract = {
  command_id: "content.path",
  command: "content path",
  schema_id: "content.path.input/v1",
  description:
    "Resolve an authorized task ContentRef to its verified canonical local path.",
  schema: ContentPathArgs,
  input_modes: inputModes,
};

export const contentStatSchema: CommandSchemaContract = {
  command_id: "content.stat",
  command: "content stat",
  schema_id: "content.stat.input/v1",
  description:
    "Read availability, identity, metadata, and local path for an authorized task ContentRef.",
  schema: ContentStatArgs,
  input_modes: inputModes,
};

export const contentMaterializeSchema: CommandSchemaContract = {
  command_id: "content.materialize",
  command: "content materialize",
  schema_id: "content.materialize.input/v1",
  description:
    "Stream an authorized task ContentRef into a stable Vellum Command task-scoped workspace path.",
  schema: ContentMaterializeArgs,
  input_modes: inputModes,
};

const browserSchema = (
  operation: string,
  command: string,
  description: string,
  schema: Schema.Top,
): CommandSchemaContract => ({
  command_id: `browser.${operation}`,
  command: `browser ${command}`,
  schema_id: `browser.${operation}.input/v1`,
  description,
  schema,
  input_modes: ["positional"],
});

export const browserPagesSchema = browserSchema(
  "pages",
  "pages",
  "List page nodes admitted by the caller's live browser.automate edges.",
  EmptyArgs,
);
export const browserOpenSchema = browserSchema(
  "open",
  "open <vellum-ref>",
  "Open or reuse a granted page session.",
  OpenRequest,
);
export const browserGotoSchema = browserSchema(
  "goto",
  "goto <sessionId> <url>",
  "Navigate an admitted browser session.",
  GotoRequest,
);
export const browserEvalSchema = browserSchema(
  "eval",
  "eval <sessionId> <code>",
  "Evaluate JavaScript in an admitted browser session.",
  EvalRequest,
);
export const browserScreenshotSchema = browserSchema(
  "screenshot",
  "shot <sessionId>",
  "Capture a server-owned PNG from an admitted browser session.",
  ScreenshotRequest,
);
export const browserCloseSchema = browserSchema(
  "close",
  "close <sessionId>",
  "Detach a browser surface while keeping its session warm.",
  CloseRequest,
);
export const browserStopSchema = browserSchema(
  "stop",
  "stop <sessionId>",
  "Destroy an admitted browser session.",
  StopRequest,
);

export const allSchemas: ReadonlyArray<CommandSchemaContract> = [
  tasksListSchema,
  tasksCreateSchema,
  tasksClaimSchema,
  tasksUpdateSchema,
  msgListSchema,
  msgSendSchema,
  msgReadSchema,
  msgReplySchema,
  preambleSchema,
  requestEscalateSchema,
  artifactPublishSchema,
  contentPathSchema,
  contentStatSchema,
  contentMaterializeSchema,
  ...(BROWSER_ENABLED
    ? [
        browserPagesSchema,
        browserOpenSchema,
        browserGotoSchema,
        browserEvalSchema,
        browserScreenshotSchema,
        browserCloseSchema,
        browserStopSchema,
      ]
    : []),
];

export const allExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "tasks.create",
    command: "tasks create",
    name: "propose work",
    description: "Create an attributed proposal for operator review.",
    input: {
      target: "n7",
      brief: "Add keyboard navigation",
      metadata: {
        title: "Keyboard navigation",
        details: "Cover the task board first.",
      },
    },
    args: [
      "tasks",
      "create",
      '{"target":"n7","brief":"Add keyboard navigation","metadata":{"title":"Keyboard navigation","details":"Cover the task board first."}}',
    ],
  },
  {
    command_id: "tasks.create",
    command: "tasks create",
    name: "propose with deps and finish criteria",
    description:
      "Same authoring contract as task create: dependsOn + finishCriteria carry onto the minted Task on approve.",
    input: {
      target: "n7",
      brief: "Ship media migration graph",
      reason: "needs prior content-ref work complete",
      dependsOn: ["t_prereq"],
      finishCriteria: {
        description: "graph claimable and media uses ContentRef",
        git: { minCommits: 1 },
      },
      metadata: {
        title: "Media migration graph",
        details: "Wire ContentRef media and make the graph claimable.",
      },
    },
    args: [
      "tasks",
      "create",
      '{"target":"n7","brief":"Ship media migration graph","reason":"needs prior content-ref work complete","dependsOn":["t_prereq"],"finishCriteria":{"description":"graph claimable and media uses ContentRef","git":{"minCommits":1}},"metadata":{"title":"Media migration graph","details":"Wire ContentRef media and make the graph claimable."}}',
    ],
  },
  {
    command_id: "tasks.claim",
    command: "tasks claim",
    name: "claim one",
    description: "Claim task t1 on target node n7.",
    args: ["tasks", "claim", '{"target":"n7","task":"t1"}'],
    input: { target: "n7", task: "t1" },
  },
  {
    command_id: "tasks.claim",
    command: "tasks claim",
    name: "batch claim",
    description: "Claim several tasks with bounded concurrency.",
    args: ["tasks", "claim", "@claims.json", "--concurrency", "5"],
    input: [
      { target: "n7", task: "t1" },
      { target: "n7", task: "t2" },
    ],
  },
  {
    command_id: "tasks.update",
    command: "tasks update",
    name: "complete",
    input: { target: "n7", task: "t1", state: "completed", note: "done" },
    args: [
      "tasks",
      "update",
      '{"target":"n7","task":"t1","state":"completed","note":"done"}',
    ],
  },
  {
    command_id: "tasks.update",
    command: "tasks update",
    name: "complete with evidence",
    input: {
      target: "n7",
      task: "t1",
      state: "completed",
      note: "done",
      completionEvidence: {
        artifacts: [{ artifactId: "a1", nodeId: "art1" }],
        git: { commits: ["abc123"] },
      },
    },
    args: [
      "tasks",
      "update",
      '{"target":"n7","task":"t1","state":"completed","completionEvidence":{"artifacts":[{"artifactId":"a1","nodeId":"art1"}],"git":{"commits":["abc123"]}}}',
    ],
  },
  {
    command_id: "msg.send",
    command: "msg send",
    name: "note on task",
    input: { target: "n7", text: "working", taskId: "t1" },
    args: ["msg", "send", '{"target":"n7","text":"working","taskId":"t1"}'],
  },
  {
    command_id: "msg.read",
    command: "msg read",
    name: "ack mailbox",
    input: { target: "seat-a", messageId: "msg_01" },
    args: ["msg", "read", '{"target":"seat-a","messageId":"msg_01"}'],
  },
  {
    command_id: "msg.reply",
    command: "msg reply",
    name: "reply to mail",
    input: {
      target: "seat-b",
      text: "ack, starting",
      inReplyTo: "msg_01",
    },
    args: [
      "msg",
      "reply",
      '{"target":"seat-b","text":"ack, starting","inReplyTo":"msg_01"}',
    ],
  },
  {
    command_id: "preamble",
    command: "preamble",
    name: "share a brief thought",
    description: "Show a sentence above this agent node for about 30 seconds.",
    input: {
      text: "Inspecting the task and choosing the smallest safe change.",
    },
    args: [
      "preamble",
      '{"text":"Inspecting the task and choosing the smallest safe change."}',
    ],
  },
  {
    command_id: "request.escalate",
    command: "escalate",
    name: "block until answer",
    description:
      "File a request and block this seat. Server returns stop_directive; further work ops return Blocked.",
    input: {
      target: "req1",
      brief: "need API key for staging",
      reason: "cannot continue without operator secret",
    },
    args: [
      "escalate",
      '{"target":"req1","brief":"need API key for staging","reason":"cannot continue without operator secret"}',
    ],
  },
  {
    command_id: "artifact.publish",
    command: "artifact publish",
    name: "publish file",
    input: {
      target: "art1",
      name: "report",
      parts: [{ kind: "raw", path: "/abs/x.png" }],
      task: { target: "tasks", id: "t1" },
    },
    args: [
      "artifact",
      "publish",
      '{"target":"art1","name":"report","parts":[{"kind":"raw","path":"/abs/x.png"}],"task":{"target":"tasks","id":"t1"}}',
    ],
  },
  {
    command_id: "tasks.list",
    command: "tasks list",
    name: "list",
    input: { target: "n7" },
    args: ["tasks", "list", '{"target":"n7"}'],
  },
  {
    command_id: "content.path",
    command: "content path",
    name: "resolve task content",
    description: "Resolve a ContentRef carried by task t1 on target n7.",
    input: {
      target: "n7",
      task: "t1",
      ref: {
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 12,
        mediaType: "application/octet-stream",
      },
    },
    args: [
      "content",
      "path",
      '{"target":"n7","task":"t1","ref":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":12,"mediaType":"application/octet-stream"}}',
    ],
  },
  {
    command_id: "content.stat",
    command: "content stat",
    name: "inspect task content",
    input: {
      target: "n7",
      task: "t1",
      ref: {
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 12,
        mediaType: "application/octet-stream",
      },
    },
    args: [
      "content",
      "stat",
      '{"target":"n7","task":"t1","ref":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":12,"mediaType":"application/octet-stream"}}',
    ],
  },
  {
    command_id: "content.materialize",
    command: "content materialize",
    name: "materialize task content",
    input: {
      target: "n7",
      task: "t1",
      name: "record.bin",
      ref: {
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 12,
        mediaType: "application/octet-stream",
      },
    },
    args: [
      "content",
      "materialize",
      '{"target":"n7","task":"t1","name":"record.bin","ref":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":12,"mediaType":"application/octet-stream"}}',
    ],
  },
  ...(BROWSER_ENABLED
    ? [
        {
          command_id: "browser.pages",
          command: "browser pages",
          name: "list granted pages",
          args: ["browser", "pages", "--json"],
          input: {},
        },
        {
          command_id: "browser.open",
          command: "browser open <vellum-ref>",
          name: "open a granted page",
          args: [
            "browser",
            "open",
            "vellum://canvas/work?node=page-1",
            "--json",
          ],
          input: { ref: "vellum://canvas/work?node=page-1" },
        },
      ]
    : []),
];

export const commandCapabilities: ReadonlyArray<CommandCapability> = [
  {
    command_id: "ping",
    command: "ping",
    category: "diagnostic",
    description: "Liveness probe against the work control socket.",
  },
  {
    command_id: "doctor",
    command: "doctor",
    category: "diagnostic",
    description:
      "Env socket+token present, perms 0600, protocol version match.",
  },
  {
    command_id: "capabilities",
    command: "capabilities",
    category: "discovery",
    description: "Live wiring from the caller's edges as a contract.",
  },
  {
    command_id: "onboard",
    command: "onboard",
    category: "discovery",
    description:
      "Node, region, connected, co-members, capabilities from live state.",
  },
  {
    command_id: "schema.list",
    command: "schema list",
    category: "discovery",
    description: "List JSON input schemas.",
  },
  {
    command_id: "schema.show",
    command: "schema show",
    category: "discovery",
    description: "Show one JSON input schema.",
  },
  {
    command_id: "examples.list",
    command: "examples list",
    category: "discovery",
    description: "List executable examples.",
  },
  {
    command_id: "examples.show",
    command: "examples show",
    category: "discovery",
    description: "Show examples for one command.",
  },
  {
    command_id: "tasks.list",
    command: "tasks list",
    category: "workflow",
    description: "List tasks on a connected target.",
    schemas: [tasksListSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.list"),
  },
  {
    command_id: "tasks.create",
    command: "tasks create",
    category: "workflow",
    description: "Create one or more proposals (batch-capable).",
    schemas: [tasksCreateSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.create"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "tasks.claim",
    command: "tasks claim",
    category: "workflow",
    description: "Claim one or more tasks (batch-capable).",
    schemas: [tasksClaimSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.claim"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "tasks.update",
    command: "tasks update",
    category: "workflow",
    description: "Update task state (batch-capable).",
    schemas: [tasksUpdateSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.update"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "msg.list",
    command: "msg list",
    category: "workflow",
    description: "List messages.",
    schemas: [msgListSchema],
  },
  {
    command_id: "msg.send",
    command: "msg send",
    category: "workflow",
    description: "Send a message (batch-capable).",
    schemas: [msgSendSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.send"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "msg.read",
    command: "msg read",
    category: "workflow",
    description: "Mark a mailbox message read (own seat; batch-capable).",
    schemas: [msgReadSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.read"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "msg.reply",
    command: "msg reply",
    category: "workflow",
    description: "Reply to factory mail and mark parent read (batch-capable).",
    schemas: [msgReplySchema],
    examples: allExamples.filter((e) => e.command_id === "msg.reply"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "preamble",
    command: "preamble",
    category: "workflow",
    description: "Show a short-lived thought bubble above this agent node.",
    schemas: [preambleSchema],
    examples: allExamples.filter((e) => e.command_id === "preamble"),
  },
  {
    command_id: "request.escalate",
    command: "escalate",
    category: "workflow",
    description:
      "Escalate to operator: create request, block seat, return stop directive.",
    schemas: [requestEscalateSchema],
    examples: allExamples.filter((e) => e.command_id === "request.escalate"),
  },
  {
    command_id: "artifact.publish",
    command: "artifact publish",
    category: "workflow",
    description: "Publish an artifact (batch-capable).",
    schemas: [artifactPublishSchema],
    examples: allExamples.filter((e) => e.command_id === "artifact.publish"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "content.path",
    command: "content path",
    category: "workflow",
    description: "Resolve an authorized task ContentRef to a local path.",
    schemas: [contentPathSchema],
    examples: allExamples.filter((e) => e.command_id === "content.path"),
  },
  {
    command_id: "content.stat",
    command: "content stat",
    category: "workflow",
    description: "Inspect availability for an authorized task ContentRef.",
    schemas: [contentStatSchema],
    examples: allExamples.filter((e) => e.command_id === "content.stat"),
  },
  {
    command_id: "content.materialize",
    command: "content materialize",
    category: "workflow",
    description:
      "Materialize an authorized task ContentRef into the task workspace.",
    schemas: [contentMaterializeSchema],
    examples: allExamples.filter((e) => e.command_id === "content.materialize"),
  },
  ...(BROWSER_ENABLED
    ? [
        {
          command_id: "browser.pages",
          command: "browser pages",
          category: "discovery" as const,
          description:
            "List page nodes granted through browser.automate edges.",
          schemas: [browserPagesSchema],
          examples: allExamples.filter((e) => e.command_id === "browser.pages"),
        },
        {
          command_id: "browser.open",
          command: "browser open",
          category: "workflow" as const,
          description: "Open or reuse a granted page session.",
          schemas: [browserOpenSchema],
          examples: allExamples.filter((e) => e.command_id === "browser.open"),
        },
        {
          command_id: "browser.goto",
          command: "browser goto",
          category: "workflow" as const,
          description: "Navigate an admitted browser session.",
          schemas: [browserGotoSchema],
        },
        {
          command_id: "browser.eval",
          command: "browser eval",
          category: "workflow" as const,
          description: "Evaluate JavaScript in an admitted browser session.",
          schemas: [browserEvalSchema],
        },
        {
          command_id: "browser.screenshot",
          command: "browser shot",
          category: "workflow" as const,
          description: "Capture a server-owned page screenshot.",
          schemas: [browserScreenshotSchema],
        },
        {
          command_id: "browser.close",
          command: "browser close",
          category: "workflow" as const,
          description:
            "Detach a browser surface while keeping its session warm.",
          schemas: [browserCloseSchema],
        },
        {
          command_id: "browser.stop",
          command: "browser stop",
          category: "workflow" as const,
          description: "Destroy an admitted browser session.",
          schemas: [browserStopSchema],
        },
      ]
    : []),
];
