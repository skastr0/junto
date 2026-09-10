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
  BoardListArgs,
  BoardPostArgs,
  BoardTagsListArgs,
  PadGetArgs,
  PadLookHereArgs,
  PadPatchArgs,
  PadReadArgs,
  SheetReadArgs,
  PadTargetArgs,
  ContentMaterializeArgs,
  ContentPathArgs,
  ContentStatArgs,
  EmptyArgs,
  MsgListArgs,
  MsgReactArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  PreambleArgs,
  RequestEscalateArgs,
  RulingsArgs,
  TasksCheckCliArgs,
  TasksClaimArgs,
  TasksRulesArgs,
  TasksCreateCliArgs,
  TasksListArgs,
  TasksShowArgs,
  TasksUpdateCliArgs,
} from "../../shared/work-control";
import { DEFAULT_BATCH_CONCURRENCY } from "./constants";
import {
  FEW_SHOT_CLAIM,
  FEW_SHOT_COMPLETE_EVIDENCE,
  FEW_SHOT_ESCALATE,
} from "../../shared/doctrine-few-shots";

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
  readonly port: string;
  readonly command: string;
  readonly discover: string;
}

const BROWSER_INVOCATION: CapabilityInvocation = {
  port: "browser.automate",
  command: "vellum-command browser",
  discover: "vellum-command browser pages --json",
};

const PAD_READ_INVOCATIONS: ReadonlyArray<CapabilityInvocation> = [
  {
    port: "pad.read",
    command: "vellum-command pad read",
    discover: "vellum-command schema show pad.read",
  },
  {
    port: "pad.read",
    command: "vellum-command pad digest",
    discover: "vellum-command schema show pad.digest",
  },
  {
    port: "pad.read",
    command: "vellum-command pad svg",
    discover: "vellum-command schema show pad.svg",
  },
  {
    port: "pad.read",
    command: "vellum-command pad look-here",
    discover: "vellum-command schema show pad.look-here",
  },
  {
    port: "pad.read",
    command: "vellum-command pad get",
    discover: "vellum-command schema show pad.get",
  },
  {
    port: "pad.read",
    command: "vellum-command pad tagged",
    discover: "vellum-command schema show pad.tagged",
  },
];

const SHEET_READ_INVOCATION: CapabilityInvocation = {
  port: "sheet.read",
  command: "vellum-command sheet read",
  discover: "vellum-command schema show sheet.read",
};

const PAD_PATCH_INVOCATION: CapabilityInvocation = {
  port: "pad.patch",
  command: "vellum-command pad patch",
  discover: "vellum-command schema show pad.patch",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invocationsForConnected = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.grants)) return entry;
    const invocations: CapabilityInvocation[] = [];
    if (BROWSER_ENABLED && entry.grants.includes("browser.automate")) {
      invocations.push(BROWSER_INVOCATION);
    }
    if (entry.grants.includes("pad.read")) {
      invocations.push(...PAD_READ_INVOCATIONS);
    }
    if (entry.grants.includes("pad.patch")) {
      invocations.push(PAD_PATCH_INVOCATION);
    }
    if (entry.grants.includes("sheet.read")) {
      invocations.push(SHEET_READ_INVOCATION);
    }
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
  description: "Claim a task for this seat (submitted → working).",
  schema: TasksClaimArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const tasksCreateSchema: CommandSchemaContract = {
  command_id: "tasks.create",
  command: "tasks create",
  schema_id: "tasks.create.input/v3",
  description:
    "Create one Task with a stable TaskId on a connected Tasks node. dependsOn accepts existing TaskIds on this board. rules addresses task-specific rules to boards on the task path. Omitted admission requires Approval; waitFor (\"12h\", \"7d\", or ms) delays the first claim.",
  schema: TasksCreateCliArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const tasksUpdateSchema: CommandSchemaContract = {
  command_id: "tasks.update",
  command: "tasks update",
  schema_id: "tasks.update.input/v4",
  description:
    "Transition a task to a new state. On completed, completionEvidence supplies artifacts, git commits, claims for rules in force, and path waivers; next names the next board, handoffNote carries the handoff, and waitFor delays claiming there. On rejected, defect sends the task back to an earlier visited board; defect.target defaults to the previous board.",
  schema: TasksUpdateCliArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const tasksShowSchema: CommandSchemaContract = {
  command_id: "tasks.show",
  command: "tasks show",
  schema_id: "tasks.show.input/v1",
  description:
    "Show one task with its visits. Prior boards expose handoff notes and cited refs, never their interiors.",
  schema: TasksShowArgs,
  input_modes: inputModes,
};

export const tasksRulesSchema: CommandSchemaContract = {
  command_id: "tasks.rules",
  command: "tasks rules",
  schema_id: "tasks.rules.input/v1",
  description:
    "Rules in force at a board, with provenance. Name a task to also get readiness: unanswered rules and required checks for each next board.",
  schema: TasksRulesArgs,
  input_modes: inputModes,
};

export const tasksCheckSchema: CommandSchemaContract = {
  command_id: "tasks.check",
  command: "tasks check",
  schema_id: "tasks.check.input/v1",
  description:
    "Run this board's outgoing checks and the next board's incoming checks in the seat environment, then submit the results. Name next when the path forks.",
  schema: TasksCheckCliArgs,
  input_modes: inputModes,
};

export const rulingsSchema: CommandSchemaContract = {
  command_id: "rulings",
  command: "rulings",
  schema_id: "rulings.input/v1",
  description:
    "Operator-pinned rulings across a region stack, outer to inner. No target: this seat's own stack.",
  schema: RulingsArgs,
  input_modes: inputModes,
};

export const msgListSchema: CommandSchemaContract = {
  command_id: "msg.list",
  command: "msg list",
  schema_id: "msg.list.input/v1",
  description:
    "List this seat's inbox (no target) or a connected mailbox. Own-inbox list marks listed inbound mail read and includes sent mail with readAt.",
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
    "Mark one mailbox message read (own seat only). Own `msg list` already does this for every listed item.",
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

export const msgReactSchema: CommandSchemaContract = {
  command_id: "msg.react",
  command: "msg react",
  schema_id: "msg.react.input/v1",
  description:
    "Acknowledge own-inbox mail without a reply (reaction defaults to ack).",
  schema: MsgReactArgs,
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

export const boardListSchema: CommandSchemaContract = {
  command_id: "board.list",
  command: "board list",
  schema_id: "board.list.input/v1",
  description:
    "List topics/posts on a connected board plus metadata of connected actors.",
  schema: BoardListArgs,
  input_modes: inputModes,
};

export const boardPostSchema: CommandSchemaContract = {
  command_id: "board.post",
  command: "board post",
  schema_id: "board.post.input/v1",
  description:
    "Post under a topic; optional tags (actor node ids) soft-notify tagged seats.",
  schema: BoardPostArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const boardTagsSchema: CommandSchemaContract = {
  command_id: "board.tags",
  command: "board tags",
  schema_id: "board.tags.input/v1",
  description:
    "List posts on a connected board that tag this process-bound seat.",
  schema: BoardTagsListArgs,
  input_modes: inputModes,
};

export const padReadSchema: CommandSchemaContract = {
  command_id: "pad.read",
  command: "pad read",
  schema_id: "pad.read.input/v1",
  description:
    "Read a connected pad (grant pad.read): revision, IR, digest, SVG. Optional pinId adds look-here. Agents never write the factory canvas.",
  schema: PadReadArgs,
  input_modes: inputModes,
};

export const sheetReadSchema: CommandSchemaContract = {
  command_id: "sheet.read",
  command: "sheet read",
  schema_id: "sheet.read.input/v1",
  description:
    "Read a connected sheet (grant sheet.read): columns, rows, and a markdown table. Sheets are operator-authored; there is no write port.",
  schema: SheetReadArgs,
  input_modes: inputModes,
};

export const padPatchSchema: CommandSchemaContract = {
  command_id: "pad.patch",
  command: "pad patch",
  schema_id: "pad.patch.input/v1",
  description:
    "Apply PadPatch on a connected pad (grant pad.patch). Agents may upsert shapes, edges, and pin posts. Agent ink or image upserts are refused. Mentions must be inbound actor node ids.",
  schema: PadPatchArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const padDigestSchema: CommandSchemaContract = {
  command_id: "pad.digest",
  command: "pad digest",
  schema_id: "pad.digest.input/v1",
  description:
    "Text IR of a connected pad (grant pad.read). Working copy for a wired seat — not the factory canvas.",
  schema: PadTargetArgs,
  input_modes: inputModes,
};

export const padSvgSchema: CommandSchemaContract = {
  command_id: "pad.svg",
  command: "pad svg",
  schema_id: "pad.svg.input/v1",
  description:
    "SVG picture of a connected pad (grant pad.read). Agents read the page; they never write the factory canvas.",
  schema: PadTargetArgs,
  input_modes: inputModes,
};

export const padLookHereSchema: CommandSchemaContract = {
  command_id: "pad.look-here",
  command: "pad look-here",
  schema_id: "pad.look-here.input/v1",
  description:
    "Crop around a pin on a connected pad (grant pad.read). pinId required. Mentions are inbound wired actors — @ cannot name an unwired agent.",
  schema: PadLookHereArgs,
  input_modes: inputModes,
};

export const padGetSchema: CommandSchemaContract = {
  command_id: "pad.get",
  command: "pad get",
  schema_id: "pad.get.input/v1",
  description:
    "Compact focused items from a connected pad (grant pad.read). Optional id returns that item. Agents never write the factory canvas.",
  schema: PadGetArgs,
  input_modes: inputModes,
};

export const padTaggedSchema: CommandSchemaContract = {
  command_id: "pad.tagged",
  command: "pad tagged",
  schema_id: "pad.tagged.input/v1",
  description:
    "Pins that mention this process-bound seat (grant pad.read). Mention universe is inbound actor edges; unwired names are refused on pad.patch.",
  schema: PadTargetArgs,
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
  tasksShowSchema,
  tasksRulesSchema,
  tasksCheckSchema,
  rulingsSchema,
  msgListSchema,
  msgSendSchema,
  msgReadSchema,
  msgReplySchema,
  msgReactSchema,
  preambleSchema,
  requestEscalateSchema,
  artifactPublishSchema,
  contentPathSchema,
  contentStatSchema,
  contentMaterializeSchema,
  boardListSchema,
  boardPostSchema,
  boardTagsSchema,
  padReadSchema,
  padPatchSchema,
  sheetReadSchema,
  padDigestSchema,
  padSvgSchema,
  padLookHereSchema,
  padGetSchema,
  padTaggedSchema,
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
    name: "create a Task for Approval",
    description:
      "Create one stable-ID Task that requires operator approval. Agent-created tasks default to Approval.",
    input: {
      target: "n7",
      brief: "Add keyboard navigation",
      metadata: {
        title: "Keyboard navigation",
        details: "Cover the task board first.",
      },
      admission: "approval",
    },
    args: [
      "tasks",
      "create",
      '{"target":"n7","brief":"Add keyboard navigation","metadata":{"title":"Keyboard navigation","details":"Cover the task board first."},"admission":"approval"}',
    ],
  },
  {
    command_id: "tasks.create",
    command: "tasks create",
    name: "create with TaskId dependencies and finish criteria",
    description:
      "dependsOn names existing TaskIds on this board. Dependencies, finish criteria, and this TaskId persist at creation.",
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
    args: FEW_SHOT_CLAIM.args,
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
    args: FEW_SHOT_COMPLETE_EVIDENCE.args,
  },
  {
    command_id: "tasks.update",
    command: "tasks update",
    name: "answer rules and send on",
    description:
      "Complete at this board with a claim for each rule, then send the task to the named next board.",
    input: {
      target: "n7",
      task: "t1",
      state: "completed",
      note: "review passed",
      completionEvidence: {
        artifacts: [],
        claims: [
          { ruleId: "r1", text: "ran the suite; all green", refs: ["abc123"] },
        ],
      },
      next: "n8",
      handoffNote: "tests pass and the keyboard path is documented",
      waitFor: "12h",
    },
    args: [
      "tasks",
      "update",
      '{"target":"n7","task":"t1","state":"completed","note":"review passed","completionEvidence":{"artifacts":[],"claims":[{"ruleId":"r1","text":"ran the suite; all green","refs":["abc123"]}]},"next":"n8","handoffNote":"tests pass and the keyboard path is documented","waitFor":"12h"}',
    ],
  },
  {
    command_id: "tasks.update",
    command: "tasks update",
    name: "send back with a defect",
    description: "Send the task back to the previous board with the reason on record.",
    input: {
      target: "n7",
      task: "t1",
      state: "rejected",
      defect: { summary: "the brief names an endpoint that does not exist", refs: ["abc123"] },
    },
    args: [
      "tasks",
      "update",
      '{"target":"n7","task":"t1","state":"rejected","defect":{"summary":"the brief names an endpoint that does not exist","refs":["abc123"]}}',
    ],
  },
  {
    command_id: "tasks.show",
    command: "tasks show",
    name: "show",
    input: { target: "n7", task: "t1" },
    args: ["tasks", "show", '{"target":"n7","task":"t1"}'],
  },
  {
    command_id: "tasks.rules",
    command: "tasks rules",
    name: "rules in force",
    description: "The rules in force at this board, with provenance.",
    input: { target: "n7" },
    args: ["tasks", "rules", '{"target":"n7"}'],
  },
  {
    command_id: "tasks.rules",
    command: "tasks rules",
    name: "readiness for a task",
    description: "Which rules are unanswered and which checks are complete.",
    input: { target: "n7", task: "t1" },
    args: ["tasks", "rules", '{"target":"n7","task":"t1"}'],
  },
  {
    command_id: "tasks.check",
    command: "tasks check",
    name: "run checks",
    description:
      "Resolve and run the applicable checks locally, then submit their results.",
    input: { target: "n7", task: "t1" },
    args: ["tasks", "check", '{"target":"n7","task":"t1"}'],
  },
  {
    command_id: "tasks.check",
    command: "tasks check",
    name: "run checks for a next board",
    description:
      "Name the next board when the path forks; its incoming checks join this board's outgoing checks.",
    input: { target: "n7", task: "t1", next: "n8" },
    args: ["tasks", "check", '{"target":"n7","task":"t1","next":"n8"}'],
  },
  {
    command_id: "rulings",
    command: "rulings",
    name: "own region stack",
    input: {},
    args: ["rulings"],
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
    command_id: "msg.list",
    command: "msg list",
    name: "open own inbox",
    input: {},
    args: ["msg", "list"],
  },
  {
    command_id: "msg.react",
    command: "msg react",
    name: "ack without reply",
    input: { messageId: "msg_01" },
    args: ["msg", "react", '{"messageId":"msg_01"}'],
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
    args: FEW_SHOT_ESCALATE.args,
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
  {
    command_id: "sheet.read",
    command: "sheet read",
    name: "read sheet",
    description: "Read the columns, rows, and markdown table of a wired sheet.",
    input: { target: "sheet-1" },
    args: ["sheet", "read", '{"target":"sheet-1"}'],
  },
  {
    command_id: "pad.read",
    command: "pad read",
    name: "read pad",
    description: "Read revision, IR, digest, and SVG on a wired pad.",
    input: { target: "pad-1" },
    args: ["pad", "read", '{"target":"pad-1"}'],
  },
  {
    command_id: "pad.read",
    command: "pad read",
    name: "read with look-here",
    description: "Read the pad and crop around pin-1.",
    input: { target: "pad-1", pinId: "pin-1" },
    args: ["pad", "read", '{"target":"pad-1","pinId":"pin-1"}'],
  },
  {
    command_id: "pad.patch",
    command: "pad patch",
    name: "upsert box",
    description:
      "Upsert a named box. Agent ink/image upserts are refused; mentions must be inbound actors.",
    input: {
      target: "pad-1",
      patches: [
        {
          op: "upsert",
          layer: "shape",
          shape: {
            id: "box-1",
            type: "box",
            x: 0,
            y: 0,
            w: 80,
            h: 40,
            z: 0,
            text: "inbox",
          },
        },
      ],
    },
    args: [
      "pad",
      "patch",
      '{"target":"pad-1","patches":[{"op":"upsert","layer":"shape","shape":{"id":"box-1","type":"box","x":0,"y":0,"w":80,"h":40,"z":0,"text":"inbox"}}]}',
    ],
  },
  {
    command_id: "pad.patch",
    command: "pad patch",
    name: "pin mention",
    description:
      "Place a pin that mentions a wired inbound actor. Unwired names are refused.",
    input: {
      target: "pad-1",
      patches: [
        {
          op: "pin.upsert",
          pin: { id: "pin-1", x: 16, y: 16, mentions: ["agent-1"] },
        },
      ],
    },
    args: [
      "pad",
      "patch",
      '{"target":"pad-1","patches":[{"op":"pin.upsert","pin":{"id":"pin-1","x":16,"y":16,"mentions":["agent-1"]}}]}',
    ],
  },
  {
    command_id: "pad.digest",
    command: "pad digest",
    name: "text IR",
    input: { target: "pad-1" },
    args: ["pad", "digest", '{"target":"pad-1"}'],
  },
  {
    command_id: "pad.svg",
    command: "pad svg",
    name: "picture",
    input: { target: "pad-1" },
    args: ["pad", "svg", '{"target":"pad-1"}'],
  },
  {
    command_id: "pad.look-here",
    command: "pad look-here",
    name: "crop pin",
    description: "Crop the page around pin-1.",
    input: { target: "pad-1", pinId: "pin-1" },
    args: ["pad", "look-here", '{"target":"pad-1","pinId":"pin-1"}'],
  },
  {
    command_id: "pad.get",
    command: "pad get",
    name: "focused items",
    input: { target: "pad-1" },
    args: ["pad", "get", '{"target":"pad-1"}'],
  },
  {
    command_id: "pad.get",
    command: "pad get",
    name: "one item",
    input: { target: "pad-1", id: "box-1" },
    args: ["pad", "get", '{"target":"pad-1","id":"box-1"}'],
  },
  {
    command_id: "pad.tagged",
    command: "pad tagged",
    name: "pins mentioning this seat",
    description: "List pins that mention the process-bound seat.",
    input: { target: "pad-1" },
    args: ["pad", "tagged", '{"target":"pad-1"}'],
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
            "vellum-command://canvas/work?node=page-1",
            "--json",
          ],
          input: { ref: "vellum-command://canvas/work?node=page-1" },
        },
      ]
    : []),
];

export const commandCapabilities: ReadonlyArray<CommandCapability> = [
  {
    command_id: "desktop-install",
    command: "desktop-install",
    category: "workflow",
    description: "First-install a signed Linux desktop archive without launching it; existing installations update through the app.",
    examples: [{
      command_id: "desktop-install",
      command: "desktop-install",
      name: "Install verified Linux desktop files",
      args: ["--release", "release.json", "--archive", "vellum-runtime-0.2.1-linux-x64.tar.gz", "--sources", "sources.json"],
    }],
  },
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
    description: "Create one or more tasks on a connected sink (batch-capable).",
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
    command_id: "tasks.show",
    command: "tasks show",
    category: "workflow",
    description: "Show one task with its visits (onion-scoped for seats).",
    schemas: [tasksShowSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.show"),
  },
  {
    command_id: "tasks.rules",
    command: "tasks rules",
    category: "workflow",
    description: "Rules in force at a board, plus readiness for a named task.",
    schemas: [tasksRulesSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.rules"),
  },
  {
    command_id: "tasks.check",
    command: "tasks check",
    category: "workflow",
    description:
      "Run this move's outgoing and incoming checks in the seat environment and submit the results.",
    schemas: [tasksCheckSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.check"),
  },
  {
    command_id: "rulings",
    command: "rulings",
    category: "workflow",
    description: "Operator-pinned rulings over a region stack.",
    schemas: [rulingsSchema],
    examples: allExamples.filter((e) => e.command_id === "rulings"),
  },
  {
    command_id: "msg.list",
    command: "msg list",
    category: "workflow",
    description:
      "List own inbox (marks listed mail read; includes sent with readAt) or a peer mailbox.",
    schemas: [msgListSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.list"),
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
    command_id: "msg.react",
    command: "msg react",
    category: "workflow",
    description: "Acknowledge own-inbox mail without a reply (batch-capable).",
    schemas: [msgReactSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.react"),
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
  {
    command_id: "pad.read",
    command: "pad read",
    category: "workflow",
    description:
      "Read a connected pad (grant pad.read): revision, IR, digest, SVG.",
    schemas: [padReadSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.read"),
  },
  {
    command_id: "sheet.read",
    command: "sheet read",
    category: "workflow",
    description:
      "Read a connected sheet (grant sheet.read): columns, rows, markdown table.",
    schemas: [sheetReadSchema],
    examples: allExamples.filter((e) => e.command_id === "sheet.read"),
  },
  {
    command_id: "pad.patch",
    command: "pad patch",
    category: "workflow",
    description:
      "Apply PadPatch (grant pad.patch). Agent ink/image refused; mentions must be inbound actors.",
    schemas: [padPatchSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.patch"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "pad.digest",
    command: "pad digest",
    category: "workflow",
    description: "Text IR of a connected pad (grant pad.read).",
    schemas: [padDigestSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.digest"),
  },
  {
    command_id: "pad.svg",
    command: "pad svg",
    category: "workflow",
    description: "SVG picture of a connected pad (grant pad.read).",
    schemas: [padSvgSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.svg"),
  },
  {
    command_id: "pad.look-here",
    command: "pad look-here",
    category: "workflow",
    description:
      "Crop around a pin (grant pad.read). Mentions are inbound wired actors.",
    schemas: [padLookHereSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.look-here"),
  },
  {
    command_id: "pad.get",
    command: "pad get",
    category: "workflow",
    description: "Focused items from a connected pad (grant pad.read).",
    schemas: [padGetSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.get"),
  },
  {
    command_id: "pad.tagged",
    command: "pad tagged",
    category: "workflow",
    description:
      "Pins mentioning this process-bound seat (grant pad.read).",
    schemas: [padTaggedSchema],
    examples: allExamples.filter((e) => e.command_id === "pad.tagged"),
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
