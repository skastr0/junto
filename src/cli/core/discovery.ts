import { JSONSchema, Schema } from "effect";
import {
  ArtifactPublishCliArgs,
  EmptyArgs,
  MsgListArgs,
  MsgSendArgs,
  RequestCreateArgs,
  RequestEscalateArgs,
  TasksClaimArgs,
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
  readonly schema: Schema.Schema.AnyNoContext;
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

export const renderSchemaContract = (contract: CommandSchemaContract) => ({
  command_id: contract.command_id,
  command: contract.command,
  schema_id: contract.schema_id,
  description: contract.description,
  accepts_batch: contract.accepts_batch ?? false,
  input_modes: contract.input_modes ?? ["inline-json", "@file", "stdin"],
  schema: JSONSchema.make(contract.schema),
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

export const tasksUpdateSchema: CommandSchemaContract = {
  command_id: "tasks.update",
  command: "tasks update",
  schema_id: "tasks.update.input/v1",
  description: "Transition a task to a new task state.",
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

export const requestCreateSchema: CommandSchemaContract = {
  command_id: "request.create",
  command: "request create",
  schema_id: "request.create.input/v1",
  description: "Create an input-required request on a connected requests node.",
  schema: RequestCreateArgs,
  accepts_batch: true,
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
  schema_id: "artifact.publish.input/v1",
  description: "Publish an artifact; raw parts may use path (CLI b64s at boundary).",
  schema: ArtifactPublishCliArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const allSchemas: ReadonlyArray<CommandSchemaContract> = [
  tasksListSchema,
  tasksClaimSchema,
  tasksUpdateSchema,
  msgListSchema,
  msgSendSchema,
  requestCreateSchema,
  requestEscalateSchema,
  artifactPublishSchema,
];

export const allExamples: ReadonlyArray<CommandExample> = [
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
    command_id: "msg.send",
    command: "msg send",
    name: "note on task",
    input: { target: "n7", text: "working", taskId: "t1" },
    args: ["msg", "send", '{"target":"n7","text":"working","taskId":"t1"}'],
  },
  {
    command_id: "request.create",
    command: "request create",
    name: "ask operator",
    input: {
      target: "req1",
      brief: "approve deploy?",
      reason: "prod deploy is gated on operator sign-off",
      metadata: { urgency: "high" },
    },
    args: [
      "request",
      "create",
      '{"target":"req1","brief":"approve deploy?","reason":"prod deploy is gated on operator sign-off","metadata":{"urgency":"high"}}',
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
    },
    args: [
      "artifact",
      "publish",
      '{"target":"art1","name":"report","parts":[{"kind":"raw","path":"/abs/x.png"}]}',
    ],
  },
  {
    command_id: "tasks.list",
    command: "tasks list",
    name: "list",
    input: { target: "n7" },
    args: ["tasks", "list", '{"target":"n7"}'],
  },
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
    description: "Env socket+token present, perms 0600, protocol version match.",
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
    description: "Node, region, connected, co-members, capabilities from live state.",
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
    command_id: "request.create",
    command: "request create",
    category: "workflow",
    description: "Create a request (batch-capable).",
    schemas: [requestCreateSchema],
    examples: allExamples.filter((e) => e.command_id === "request.create"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
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
];

void EmptyArgs;
