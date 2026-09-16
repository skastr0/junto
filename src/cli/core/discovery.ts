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
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  PAD_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "../../shared/features";
import { MANAGED_PROMPT_IMMEDIATE_MAX } from "../../shared/managed-prompt";
import { SeatReadArgs, SeatWaitArgs, TaskWaitArgs } from "../../shared/seat-control";
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
  MsgPromptArgs,
  MsgReactArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  MsgSentArgs,
  VerdictPostArgs,
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
import { overseerCapabilities, overseerExamples, overseerSchemas } from "../commands/overseer";
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

/**
 * One predicate for every discovery surface a feature gate can silence:
 * schemas, examples, capability rows, and edge-grant invocations. A disabled
 * product command is never advertised, so an agent cannot discover its way
 * back to a surface the kernel already refuses.
 */
export const commandSurfaceEnabled = (commandId: string): boolean => {
  if (commandId.startsWith("tasks.")) return TASKS_ENABLED;
  if (commandId.startsWith("content.")) return TASKS_ENABLED;
  if (commandId.startsWith("board.")) return BOARD_ENABLED;
  if (commandId.startsWith("pad.")) return PAD_ENABLED;
  if (commandId === "sheet.read") return SHEET_ENABLED;
  if (commandId.startsWith("request.")) return REQUESTS_ENABLED;
  if (commandId.startsWith("artifact.")) return ARTIFACTS_ENABLED;
  if (commandId.startsWith("browser.")) return BROWSER_ENABLED;
  return true;
};

const BROWSER_INVOCATION: CapabilityInvocation = {
  port: "browser.automate",
  command: "junto browser",
  discover: "junto browser pages --json",
};

const PAD_READ_INVOCATIONS: ReadonlyArray<CapabilityInvocation> = [
  {
    port: "pad.read",
    command: "junto pad read",
    discover: "junto schema show pad.read",
  },
  {
    port: "pad.read",
    command: "junto pad digest",
    discover: "junto schema show pad.digest",
  },
  {
    port: "pad.read",
    command: "junto pad svg",
    discover: "junto schema show pad.svg",
  },
  {
    port: "pad.read",
    command: "junto pad look-here",
    discover: "junto schema show pad.look-here",
  },
  {
    port: "pad.read",
    command: "junto pad get",
    discover: "junto schema show pad.get",
  },
  {
    port: "pad.read",
    command: "junto pad tagged",
    discover: "junto schema show pad.tagged",
  },
];

const SHEET_READ_INVOCATION: CapabilityInvocation = {
  port: "sheet.read",
  command: "junto sheet read",
  discover: "junto schema show sheet.read",
};

const PAD_PATCH_INVOCATION: CapabilityInvocation = {
  port: "pad.patch",
  command: "junto pad patch",
  discover: "junto schema show pad.patch",
};

const CREW_INVOCATIONS: ReadonlyArray<CapabilityInvocation> = [
  {
    port: "msg.prompt",
    command: "junto msg prompt",
    discover: "junto schema show msg.prompt",
  },
  {
    port: "seat.wait",
    command: "junto seat wait",
    discover: "junto schema show seat.wait",
  },
  {
    port: "terminal.read",
    command: "junto seat read",
    discover: "junto schema show seat.read",
  },
  {
    port: "verdict.post",
    command: "junto verdict post",
    discover: "junto schema show verdict.post",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invocationsForConnected = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.grants)) return entry;
    const grants = entry.grants;
    const invocations: CapabilityInvocation[] = [];
    if (BROWSER_ENABLED && entry.grants.includes("browser.automate")) {
      invocations.push(BROWSER_INVOCATION);
    }
    if (PAD_ENABLED && entry.grants.includes("pad.read")) {
      invocations.push(...PAD_READ_INVOCATIONS);
    }
    if (PAD_ENABLED && entry.grants.includes("pad.patch")) {
      invocations.push(PAD_PATCH_INVOCATION);
    }
    if (SHEET_ENABLED && entry.grants.includes("sheet.read")) {
      invocations.push(SHEET_READ_INVOCATION);
    }
    invocations.push(
      ...CREW_INVOCATIONS.filter((invocation) => grants.includes(invocation.port)),
    );
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

export const tasksWaitSchema: CommandSchemaContract = {
  command_id: "tasks.wait",
  command: "tasks wait",
  schema_id: "tasks.wait.input/v1",
  description:
    "Wait for one authorized task to become completed, input-required, or rejected. timeoutMs bounds the wait to at most 600000 ms.",
  schema: TaskWaitArgs,
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

export const msgPromptSchema: CommandSchemaContract = {
  command_id: "msg.prompt",
  command: "msg prompt",
  schema_id: "msg.prompt.input/v1",
  description:
    `Request immediate full-body delivery through msg.prompt, without automatic interruption. Bodies over ${MANAGED_PROMPT_IMMEDIATE_MAX} characters return InputError (oversize), unless fallback: notice is explicit. Create with text, or retry the existing messageId without replacing its body. A timeout after dispatch is uncertain: inspect msg sent before retrying; never recreate blindly.`,
  schema: MsgPromptArgs,
  input_modes: inputModes,
};

export const msgSentSchema: CommandSchemaContract = {
  command_id: "msg.sent",
  command: "msg sent",
  schema_id: "msg.sent.input/v1",
  description:
    "Read this sender's delivery and read receipts, optionally filtered by target. Does not mark the recipient's mailbox read.",
  schema: MsgSentArgs,
  input_modes: inputModes,
};

export const verdictPostSchema: CommandSchemaContract = {
  command_id: "verdict.post",
  command: "verdict post",
  schema_id: "verdict.post.input/v1",
  description:
    "Post a durable green or blocking verdict through a current reviews edge. Task target is the task board; subject carries taskId, epoch, and subjectHash from tasks.show. Blocking requires findings and rejects the task with a new epoch. Reviewer identity is process-bound; self-review is refused.",
  schema: VerdictPostArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const seatWaitSchema: CommandSchemaContract = {
  command_id: "seat.wait",
  command: "seat wait",
  schema_id: "seat.wait.input/v1",
  description:
    "Wait for one target seat or any currently authorized peer to reach until. Choose target or any: true; timeoutMs bounds the wait to at most 600000 ms.",
  schema: SeatWaitArgs,
  input_modes: inputModes,
};

export const seatReadSchema: CommandSchemaContract = {
  command_id: "seat.read",
  command: "seat read",
  schema_id: "seat.read.input/v1",
  description:
    "Read an authorized peer's settled terminal window through terminal.read. Reads are bounded to 2000 lines and 64 KiB; follow is bounded to 600 seconds. since requires sinceGeneration; replacements are explicit. Grants no input, resize, or signal authority.",
  schema: SeatReadArgs,
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
    "Publish an artifact; parts pass ContentRefs or legacy raw bytesBase64 (local file paths are rejected — ingest content first) and optional task provenance names the exact task sink and id.",
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
    "Stream an authorized task ContentRef into a stable Junto task-scoped workspace path.",
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
  "open <junto-ref>",
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

const declaredSchemas: ReadonlyArray<CommandSchemaContract> = [
  tasksListSchema,
  tasksCreateSchema,
  tasksClaimSchema,
  tasksUpdateSchema,
  tasksShowSchema,
  tasksWaitSchema,
  tasksRulesSchema,
  tasksCheckSchema,
  rulingsSchema,
  msgListSchema,
  msgSendSchema,
  msgPromptSchema,
  msgSentSchema,
  verdictPostSchema,
  msgReadSchema,
  msgReplySchema,
  msgReactSchema,
  seatWaitSchema,
  seatReadSchema,
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
  ...overseerSchemas,
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

/** Schemas a feature gate has turned off never leave discovery. */
export const allSchemas: ReadonlyArray<CommandSchemaContract> =
  declaredSchemas.filter((contract) => commandSurfaceEnabled(contract.command_id));

const declaredExamples: ReadonlyArray<CommandExample> = [
  {
    command_id: "verdict.post",
    command: "verdict post",
    name: "review the exact staged task subject",
    description: "Use the current epoch and subjectHash returned by tasks show. Identity comes from the reviewer process.",
    input: {
      target: "task-board", subject: { kind: "task", taskId: "task-1", epoch: 1, subjectHash: "a".repeat(64) },
      kind: "green", findings: [],
    },
    args: ["verdict", "post", JSON.stringify({
      target: "task-board", subject: { kind: "task", taskId: "task-1", epoch: 1, subjectHash: "a".repeat(64) },
      kind: "green", findings: [],
    })],
  },
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
    command_id: "tasks.wait",
    command: "tasks wait",
    name: "wait for task completion",
    input: { target: "n7", taskId: "t1", until: "completed", timeoutMs: 30000 },
    args: ["tasks", "wait", '{"target":"n7","taskId":"t1","until":"completed","timeoutMs":30000}'],
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
    command_id: "msg.prompt",
    command: "msg prompt",
    name: "request a short immediate prompt",
    description: "Requires msg.prompt and an idle seat with an empty composer; never interrupts.",
    input: { target: "seat-b", text: "Please review the API contract." },
    args: ["msg", "prompt", '{"target":"seat-b","text":"Please review the API contract."}'],
  },
  {
    command_id: "msg.prompt",
    command: "msg prompt",
    name: "retry an existing prompt",
    description: "After a pre-write refusal, wait for readiness and retry the returned messageId. Do not send a replacement body.",
    input: { target: "seat-b", messageId: "msg_01" },
    args: ["msg", "prompt", '{"target":"seat-b","messageId":"msg_01"}'],
  },
  {
    command_id: "msg.prompt",
    command: "msg prompt",
    name: "explicitly allow notice fallback",
    input: { target: "seat-b", text: "Please review the API contract.", fallback: "notice" },
    args: ["msg", "prompt", '{"target":"seat-b","text":"Please review the API contract.","fallback":"notice"}'],
  },
  {
    command_id: "msg.sent",
    command: "msg sent",
    name: "inspect own sent receipts",
    input: {},
    args: ["msg", "sent"],
  },
  {
    command_id: "msg.sent",
    command: "msg sent",
    name: "inspect receipts for a peer",
    input: { target: "seat-b" },
    args: ["msg", "sent", '{"target":"seat-b"}'],
  },
  {
    command_id: "seat.wait",
    command: "seat wait",
    name: "wait for an idle peer with JSON",
    input: { target: "seat-b", until: "idle", timeoutMs: 30000 },
    args: ["seat", "wait", '{"target":"seat-b","until":"idle","timeoutMs":30000}'],
  },
  {
    command_id: "seat.wait",
    command: "seat wait",
    name: "wait for an idle peer with flags",
    input: { target: "seat-b", until: "idle", timeoutMs: 30000 },
    args: ["seat", "wait", "seat-b", "--until", "idle", "--timeout", "30s"],
  },
  {
    command_id: "seat.wait",
    command: "seat wait",
    name: "wait for attention on any authorized peer",
    description: "--any watches only peers whose live edges grant seat.wait.",
    input: { any: true, until: "attention", timeoutMs: 30000 },
    args: ["seat", "wait", "--any", "--until", "attention", "--timeout", "30s"],
  },
  {
    command_id: "seat.read",
    command: "seat read",
    name: "read a settled peer window with JSON",
    input: { target: "seat-b", lines: 40 },
    args: ["seat", "read", '{"target":"seat-b","lines":40}'],
  },
  {
    command_id: "seat.read",
    command: "seat read",
    name: "read a settled peer window with flags",
    input: { target: "seat-b", lines: 40 },
    args: ["seat", "read", "seat-b", "--lines", "40"],
  },
  {
    command_id: "seat.read",
    command: "seat read",
    name: "follow a peer for at most five seconds",
    input: { target: "seat-b", follow: true, maxSeconds: 5 },
    args: ["seat", "read", "seat-b", "--follow", "--max-seconds", "5"],
  },
  {
    command_id: "seat.read",
    command: "seat read",
    name: "follow from a generation-bound cursor",
    description: "Use seq and generation from the preceding read. A replaced generation is reported explicitly.",
    input: { target: "seat-b", since: 12, sinceGeneration: "generation-1", follow: true, maxSeconds: 5 },
    args: ["seat", "read", '{"target":"seat-b","since":12,"sinceGeneration":"generation-1","follow":true,"maxSeconds":5}'],
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
          command: "browser open <junto-ref>",
          name: "open a granted page",
          args: [
            "browser",
            "open",
            "junto://canvas/work?node=page-1",
            "--json",
          ],
          input: { ref: "junto://canvas/work?node=page-1" },
        },
      ]
    : []),
  ...overseerExamples,
];

/** Examples follow their command: a disabled surface has no runnable recipe. */
export const allExamples: ReadonlyArray<CommandExample> =
  declaredExamples.filter((example) => commandSurfaceEnabled(example.command_id));

const declaredCapabilities: ReadonlyArray<CommandCapability> = [
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
    command_id: "tasks.wait",
    command: "tasks wait",
    category: "workflow",
    description: "Wait for an authorized task state with a bounded deadline.",
    schemas: [tasksWaitSchema],
    examples: allExamples.filter((e) => e.command_id === "tasks.wait"),
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
    command_id: "msg.prompt",
    command: "msg prompt",
    category: "workflow",
    description: "Attempt a short immediate prompt or retry its existing messageId, without automatic interruption.",
    schemas: [msgPromptSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.prompt"),
  },
  {
    command_id: "msg.sent",
    command: "msg sent",
    category: "workflow",
    description: "Inspect the admitted sender's receipts without marking recipient mail read.",
    schemas: [msgSentSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.sent"),
  },
  {
    command_id: "seat.wait",
    command: "seat wait",
    category: "workflow",
    description: "Wait for one authorized peer or any authorized peer to reach a named seat state.",
    schemas: [seatWaitSchema],
    examples: allExamples.filter((e) => e.command_id === "seat.wait"),
  },
  {
    command_id: "verdict.post",
    command: "verdict post",
    category: "workflow",
    description: "Review an exact task epoch and refs through a current directed reviews edge.",
    schemas: [verdictPostSchema],
    examples: allExamples.filter((e) => e.command_id === "verdict.post"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
  },
  {
    command_id: "seat.read",
    command: "seat read",
    category: "workflow",
    description: "Read or follow a bounded settled terminal window through a live terminal.read grant.",
    schemas: [seatReadSchema],
    examples: allExamples.filter((e) => e.command_id === "seat.read"),
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
  ...overseerCapabilities,
];

/** Capability rows follow their command: a disabled surface is not discoverable. */
export const commandCapabilities: ReadonlyArray<CommandCapability> =
  declaredCapabilities.filter((capability) =>
    commandSurfaceEnabled(capability.command_id),
  );
