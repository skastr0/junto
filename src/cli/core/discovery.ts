import { Schema } from "effect";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  REQUESTS_ENABLED,
  TASKS_ENABLED,
} from "../../shared/features";
import { SeatReadArgs, SeatWaitArgs, TaskWaitArgs } from "../../shared/seat-control";
import { browserCapabilities, browserExamples, browserSchemas } from "../commands/browser-contract";
import {
  ArtifactPublishCliArgs,
  BoardListArgs,
  BoardPostArgs,
  BoardTagsListArgs,
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
  OffboardArgs,
  OnboardArgs,
  SignalClearArgs,
  SignalListArgs,
  RulingsArgs,
  TasksCheckCliArgs,
  TasksClaimArgs,
  TasksRulesArgs,
  TasksCreateCliArgs,
  TasksListArgs,
  TasksShowArgs,
  TasksUpdateCliArgs,
} from "../../shared/work-control";
import { SignalRaiseCliInput } from "./signal-input";
import { Level, rankOf } from "../../shared/wire/urgency";
import { ContentStageArgs } from "../../shared/content-stage";
import { envReportCapability, envReportExamples, envReportSchema } from "../commands/env";
import { logsReadCapability, logsReadExamples, logsReadSchema } from "../commands/logs";
import { referencesCapabilities, referencesExamples, referencesSchemas } from "../commands/references";
import { overseerCapabilities, overseerExamples, overseerSchemas } from "../commands/overseer";
import { automationCapabilities, automationExamples, automationSchemas } from "../commands/automation";
import { DEFAULT_BATCH_CONCURRENCY } from "./constants";
import {
  FEW_SHOT_CLAIM,
  FEW_SHOT_COMPLETE_EVIDENCE,
  FEW_SHOT_BLOCKED,
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

import { commandSurfaceEnabled } from "./capability-invocations";
export { commandSurfaceEnabled, annotateCapabilityInvocations } from "./capability-invocations";
export type { CapabilityInvocation } from "./capability-invocations";

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
    "List this seat's inbox (no target) or a connected mailbox. Own-inbox list marks listed inbound mail read and includes sent mail with readAt; peek lists without marking anything read. Every item names its threadId (and inReplyTo when it answers one). Filters combine: threadId (one thread), from (a seat's name, node id or seat id), unread, since (an ISO 8601 time, or a message id to list what came after it) and text (contains, ignoring case).",
  schema: MsgListArgs,
  input_modes: inputModes,
};

export const msgSendSchema: CommandSchemaContract = {
  command_id: "msg.send",
  command: "msg send",
  schema_id: "msg.send.input/v1",
  description:
    "Mail a connected seat, named by its name or its node id. The mail is typed whole into its input, up to 2,500 characters, under a \"mail from\" header with its id and the reply command, and marked read; longer mail is cut with a pointer to msg read. Mail for one seat that arrives within 2 seconds of other mail is typed with it as one turn, at most 10 seconds after the first; past 6,000 characters in a turn, each further mail is one line with its id, and past 20 of those one line counts the rest. A seat that is not up gets it when it starts. threadId posts into an existing thread this seat can read.",
  schema: MsgSendArgs,
  accepts_batch: true,
  input_modes: inputModes,
};

export const msgPromptSchema: CommandSchemaContract = {
  command_id: "msg.prompt",
  command: "msg send --prompt",
  schema_id: "msg.prompt.input/v1",
  description:
    "Mail a connected seat as a prompt, named by its name or its node id: the full text is typed into its input and submitted at once as steering, as its own turn: a prompt is never batched with other mail. While a turn is running, that harness's follow-up contract says how many Enters that takes. A seat that is not up gets it when it starts.",
  schema: MsgPromptArgs,
  accepts_batch: true,
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
    "Wait for one target seat or any currently authorized peer to reach until. Choose target or any: true; timeoutMs bounds the wait to at most 600000 ms. until: replied answers with the peer's newest mail to the caller after the after message id, or after the wait began; the caller's own mail never answers.",
  schema: SeatWaitArgs,
  input_modes: inputModes,
};

export const seatReadSchema: CommandSchemaContract = {
  command_id: "seat.read",
  command: "seat read",
  schema_id: "seat.read.input/v1",
  description:
    "Read an authorized peer's settled terminal window through terminal.read. Reads are bounded to 2000 lines and 64 KiB; follow is bounded to 600 seconds. since requires sinceGeneration; replacements are explicit. Grants no input, resize, or signal authority. Names the peer (id, name, regions outermost first), since when it has been in its state, when its terminal last printed, its own live preamble, and the 5 newest mails between caller and peer both ways (with threadId), marking none read. brief: true with no target reads every connected peer the caller holds terminal.read on, without screens, and counts the rest as withheld.",
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
    "Reply to mail: send text to target (a seat's name or its node id) and mark inReplyTo read on own mailbox. The reply joins the parent's thread. Target \"operator\" answers mail the operator sent this seat.",
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

export const onboardSchema: CommandSchemaContract = {
  command_id: "onboard",
  command: "onboard",
  schema_id: "onboard.input/v1",
  description:
    "Load this seat's briefing. past_notes: how many of the latest offboard notes to include inline (default 5). Usually run with no input.",
  schema: OnboardArgs,
};

export const offboardSchema: CommandSchemaContract = {
  command_id: "offboard",
  command: "offboard",
  schema_id: "offboard.input/v1",
  description:
    "End this session: markdown notes on what happened, what is relevant, and why it matters; the first line is the one-line summary. Plain markdown, @file, or - for stdin also work. Offboard ends the session the moment it returns: run it last. Without continuation the seat rests until its next wake. With continuation (--continue on the command line), a note for the next session on what to pick up and why: Junto starts that session right away, and it reads the note first.",
  schema: OffboardArgs,
  input_modes: ["markdown", "inline-json", "@file", "stdin"],
};

export const preambleSchema: CommandSchemaContract = {
  command_id: "preamble",
  command: "preamble",
  schema_id: "preamble.input/v1",
  description: "Show a short-lived thought bubble above this agent node.",
  schema: PreambleArgs,
  input_modes: inputModes,
};

const signalInputModes = ["sentence", "inline", "file", "stdin"] as const;

const signalRaiseSchema = (
  kind: "escalate" | "blocked" | "feedback",
  description: string,
): CommandSchemaContract => ({
  command_id: `signal.${kind}`,
  command: kind,
  schema_id: `signal.${kind}.input/v1`,
  description,
  // What the agent writes: files by path, text inline. The CLI uploads them and sends references.
  schema: SignalRaiseCliInput,
  input_modes: signalInputModes,
});

export const signalEscalateSchema = signalRaiseSchema(
  "escalate",
  "Needs the operator's attention; you keep working. Input is one sentence (or {\"text\",\"detail\"}); --detail adds markdown. kind is set by the command.",
);
export const signalBlockedSchema = signalRaiseSchema(
  "blocked",
  "Work is entirely blocked on the operator; stop and wait. The answer arrives as operator mail.",
);
export const signalFeedbackSchema = signalRaiseSchema(
  "feedback",
  "Not blocked: the work is ready for the operator to review.",
);

export const signalListSchema: CommandSchemaContract = {
  command_id: "signal.list",
  command: "signal list",
  schema_id: "signal.list.input/v1",
  description: `This seat's signals with the operator's answers. Each carries its level on the urgency ladder and that level's rank (${rankOf(Level.offline)} ${Level.offline} to ${rankOf(Level.blocked)} ${Level.blocked}, higher more urgent). Open signals come first, then the most urgent, then the oldest; open counts the open ones.`,
  schema: SignalListArgs,
};

export const signalClearSchema: CommandSchemaContract = {
  command_id: "signal.clear",
  command: "signal clear",
  schema_id: "signal.clear.input/v1",
  description: "Withdraw one open signal of this seat by id, or all of them when no id is given.",
  schema: SignalClearArgs,
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

/**
 * Not a command: the work op the CLI uses to send a file. Documented so an
 * agent that looks it up learns what it is and how it is normally reached.
 */
export const contentStageSchema: CommandSchemaContract = {
  command_id: "content.stage",
  command: "content.stage",
  schema_id: "content.stage.input/v1",
  description:
    "Work op, not a command: a seat puts a file of its own into the content store, in pieces, and gets a ContentRef to name it by. Agents normally reach it through --attach on escalate, blocked and feedback, not by calling it. First piece {bytesBase64} answers {stageId, byteLength}; each next piece {stageId, bytesBase64}; the last carries done {mediaType, displayName?, expected?} and answers {ref}. A small file is one call with bytesBase64 and done. A piece is at most 4 MiB of raw bytes. A path never crosses.",
  schema: ContentStageArgs,
  input_modes: ["inline-json"],
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

const declaredSchemas: ReadonlyArray<CommandSchemaContract> = [
  onboardSchema,
  offboardSchema,
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
  signalEscalateSchema,
  signalBlockedSchema,
  signalFeedbackSchema,
  signalListSchema,
  signalClearSchema,
  artifactPublishSchema,
  contentPathSchema,
  contentStatSchema,
  contentMaterializeSchema,
  boardListSchema,
  boardPostSchema,
  boardTagsSchema,
  envReportSchema,
  logsReadSchema,
  ...referencesSchemas,
  contentStageSchema,
  ...overseerSchemas,
  ...automationSchemas,
  // Inline on purpose: a module const would keep the browser rows in the machine bundle.
  ...((typeof __JUNTO_MACHINE_BUILD__ === "boolean" && __JUNTO_MACHINE_BUILD__) ? [] : BROWSER_ENABLED ? browserSchemas : []),
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
    command_id: "msg.send",
    command: "msg send",
    name: "post into a thread",
    input: { target: "seat-b", text: "one more thing", threadId: "01JB2C3D4E5F6G7H8J9K0M1N2P" },
    args: ["msg", "send", '{"target":"seat-b","text":"one more thing","threadId":"01JB2C3D4E5F6G7H8J9K0M1N2P"}'],
  },
  {
    command_id: "msg.prompt",
    command: "msg send --prompt",
    name: "prompt a connected seat",
    description: "Requires msg.prompt. The full text lands in the seat's input at once as steering, idle or mid-turn. A running turn uses that harness's follow-up contract.",
    input: { target: "seat-b", text: "Please review the API contract." },
    args: ["msg", "send", "--prompt", '{"target":"seat-b","text":"Please review the API contract."}'],
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
    command_id: "seat.wait",
    command: "seat wait",
    name: "wait for a peer to reply to your mail",
    description: "after is the last mail id you saw from the peer; without it, only mail sent after the wait began answers.",
    input: { target: "seat-b", until: "replied", after: "01M59CMKZRATKFG5E69JZM0BT0", timeoutMs: 30000 },
    args: ["seat", "wait", "seat-b", "--until", "replied", "--after", "01M59CMKZRATKFG5E69JZM0BT0", "--timeout", "30s"],
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
    name: "read every peer at once without screens",
    description: "Each readable peer with its identity, state, preamble and recent mail; withheld counts connected seats you may not read.",
    input: { brief: true },
    args: ["seat", "read", "--brief"],
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
      inReplyTo: "01JB2C3D4E5F6G7H8J9K0M1N2P",
    },
    args: [
      "msg",
      "reply",
      '{"target":"seat-b","text":"ack, starting","inReplyTo":"01JB2C3D4E5F6G7H8J9K0M1N2P"}',
    ],
  },
  {
    command_id: "msg.reply",
    command: "msg reply",
    name: "answer the operator",
    input: { target: "operator", text: "done, see 1a2b3c4", inReplyTo: "01JB2C3D4E5F6G7H8J9K0M1N2Q" },
    args: ["msg", "reply", '{"target":"operator","text":"done, see 1a2b3c4","inReplyTo":"01JB2C3D4E5F6G7H8J9K0M1N2Q"}'],
  },
  {
    command_id: "msg.list",
    command: "msg list",
    name: "open own inbox",
    input: {},
    args: ["msg", "list"],
  },
  {
    command_id: "msg.list",
    command: "msg list",
    name: "read one thread",
    input: { threadId: "01JB2C3D4E5F6G7H8J9K0M1N2P" },
    args: ["msg", "list", '{"threadId":"01JB2C3D4E5F6G7H8J9K0M1N2P"}'],
  },
  {
    command_id: "msg.list",
    command: "msg list",
    name: "peek at unread mail from one seat",
    input: { from: "seat-b", unread: true, peek: true },
    args: ["msg", "list", '{"from":"seat-b","unread":true,"peek":true}'],
  },
  {
    command_id: "msg.list",
    command: "msg list",
    name: "search recent mail",
    input: { since: "2026-10-19T09:00:00Z", text: "release" },
    args: ["msg", "list", '{"since":"2026-10-19T09:00:00Z","text":"release"}'],
  },
  {
    command_id: "msg.react",
    command: "msg react",
    name: "ack without reply",
    input: { messageId: "msg_01" },
    args: ["msg", "react", '{"messageId":"msg_01"}'],
  },
  {
    command_id: "offboard",
    command: "offboard",
    name: "hand off at a stopping point",
    description:
      "Notes for the next session of this seat: what happened, what is relevant, why it matters. The seat rests until its next wake.",
    input: {
      notes:
        "Importer parses all three feeds; retry on 429 is next.\n\n- Parser lives in src/import/feed.ts, tests in tests/feed.test.ts.\n- Why it matters: the nightly sync fails without retries.",
    },
    args: [
      "offboard",
      "Importer parses all three feeds; retry on 429 is next.\n\n- Parser lives in src/import/feed.ts, tests in tests/feed.test.ts.\n- Why it matters: the nightly sync fails without retries.",
    ],
  },
  {
    command_id: "offboard",
    command: "offboard",
    name: "hand off mid-work and continue",
    description:
      "Notes on this session, plus a note for the fresh session Junto starts right away: what to pick up and why.",
    input: {
      notes: "Importer parses all three feeds; retry on 429 is half done.\n\n- Parser lives in src/import/feed.ts.",
      continuation:
        "Finish the 429 retry in src/import/feed.ts (backoff is written, the test is not). Why: the nightly sync fails without it.",
    },
    args: [
      "offboard",
      "Importer parses all three feeds; retry on 429 is half done.\n\n- Parser lives in src/import/feed.ts.",
      "--continue",
      "Finish the 429 retry in src/import/feed.ts (backoff is written, the test is not). Why: the nightly sync fails without it.",
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
    command_id: "signal.blocked",
    command: "blocked",
    name: "blocked on the operator",
    description: "Stop and wait: the operator's answer arrives as operator mail.",
    input: {
      text: FEW_SHOT_BLOCKED.args[1],
      detail: FEW_SHOT_BLOCKED.args[3],
    },
    args: FEW_SHOT_BLOCKED.args,
  },
  {
    command_id: "signal.blocked",
    command: "blocked",
    name: "a question with its likely answers",
    description:
      "When the question has two likely answers, pre-bake them: they show ahead of the operator's quick replies, and whichever is picked sends as the answer.",
    input: { text: "Which store for the run log?", suggest: ["Use sqlite", "Keep JSON"] },
    args: ["blocked", "Which store for the run log?", "--suggest", "Use sqlite", "--suggest", "Keep JSON"],
  },
  {
    command_id: "signal.escalate",
    command: "escalate",
    name: "needs attention, still working",
    input: { text: "The migration touches billing tables; please confirm before I ship." },
    args: ["escalate", "The migration touches billing tables; please confirm before I ship."],
  },
  {
    command_id: "signal.feedback",
    command: "feedback",
    name: "ready for review",
    input: { text: "The onboarding redesign is up on the branch for review." },
    args: ["feedback", "The onboarding redesign is up on the branch for review."],
  },
  {
    command_id: "signal.feedback",
    command: "feedback",
    name: "ready for review, with screenshots",
    description:
      "Attach the files the operator should look at: they show as pictures on the card, and Before and After captions set up a comparison.",
    input: {
      text: "The agent rail redesign is ready to review.",
      attach: [
        { path: "/abs/shots/before.png", caption: "Before" },
        { path: "/abs/shots/after.png", caption: "After" },
      ],
    },
    args: [
      "feedback",
      "The agent rail redesign is ready to review.",
      "--attach",
      "Before=/abs/shots/before.png",
      "--attach",
      "After=/abs/shots/after.png",
    ],
  },
  {
    command_id: "signal.feedback",
    command: "feedback",
    name: "ready for review, with a code block and a diff",
    description:
      "Text you type is attached as it is: a code block with its language, and any unified diff (no repository needed). Both show highlighted on the card. A diff can come from a pipe: git diff | junto feedback \"...\" --diff -",
    input: {
      text: "The retry guard is in; here is the change.",
      attach: [
        { code: "if (attempt > MAX_RETRIES) throw new GiveUp();", language: "ts", caption: "The guard" },
        { diff: "--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-const MAX_RETRIES = 3;\n+const MAX_RETRIES = 5;\n", caption: "The change" },
      ],
    },
    args: [
      "feedback",
      "The retry guard is in; here is the change.",
      "--code",
      "The guard=ts:if (attempt > MAX_RETRIES) throw new GiveUp();",
      "--diff",
      "The change=--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-const MAX_RETRIES = 3;\n+const MAX_RETRIES = 5;\n",
    ],
  },
  {
    command_id: "signal.escalate",
    command: "escalate",
    name: "two texts read as a change",
    description:
      "A before and an after, shown as a diff. From two files with --compare; two texts typed inline go in the JSON form.",
    input: {
      text: "Which wording do you want on the empty state?",
      attach: [{ before: "Nothing here yet.", after: "No signals. You are all caught up.", language: "txt", caption: "Empty state" }],
    },
    args: ["escalate", "Which wording do you want on the empty state?", "--compare", "Empty state=/abs/before.txt,/abs/after.txt"],
  },
  {
    command_id: "signal.feedback",
    command: "feedback",
    name: "ready for review, with the commit",
    description:
      "A commit in your folder, by anything git resolves (HEAD, a branch, an id). The card shows the commit and its diff.",
    input: {
      text: "The migration is committed and ready to review.",
      attach: [{ commit: "HEAD", caption: "The migration" }],
    },
    args: ["feedback", "The migration is committed and ready to review.", "--commit", "The migration=HEAD"],
  },
  {
    command_id: "signal.feedback",
    command: "feedback",
    name: "ready for review, with a video at a web address",
    description:
      "A video that lives somewhere else. The operator sees the whole address; nothing is fetched until they press play. A video file on disk is attached with --attach.",
    input: {
      text: "The recorded run is up.",
      attach: [{ url: "https://media.example.com/runs/onboarding.mp4", caption: "The run" }],
    },
    args: ["feedback", "The recorded run is up.", "--video", "The run=https://media.example.com/runs/onboarding.mp4"],
  },
  {
    command_id: "signal.list",
    command: "signal list",
    name: "read the operator's answers, most urgent open signal first",
    input: {},
    args: ["signal", "list"],
  },
  {
    command_id: "signal.clear",
    command: "signal clear",
    name: "withdraw a signal",
    input: { signalId: "01J0000000000000000000000" },
    args: ["signal", "clear", "01J0000000000000000000000"],
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
  // Inline on purpose: a module const would keep the browser rows in the machine bundle.
  ...((typeof __JUNTO_MACHINE_BUILD__ === "boolean" && __JUNTO_MACHINE_BUILD__) ? [] : BROWSER_ENABLED ? browserExamples : []),
  ...envReportExamples,
  ...logsReadExamples,
  ...referencesExamples,
  ...overseerExamples,
  ...automationExamples,
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
      "The one loader: short guidance, your seat (name, harness, soul, standing instructions), region briefing, connections with the commands each allows, co-members, and this seat's past sessions.",
    schemas: [onboardSchema],
  },
  {
    command_id: "offboard",
    command: "offboard",
    category: "workflow",
    description:
      "End this session with notes: plain at a stopping point (the seat rests), or --continue mid-work (a fresh session starts right away and reads your note first).",
    schemas: [offboardSchema],
    examples: allExamples.filter((e) => e.command_id === "offboard"),
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
    command: "msg send --prompt",
    category: "workflow",
    description: "Send a message whose full text is typed into the seat's input (batch-capable).",
    schemas: [msgPromptSchema],
    examples: allExamples.filter((e) => e.command_id === "msg.prompt"),
    batch: {
      accepts_batch: true,
      default_concurrency: DEFAULT_BATCH_CONCURRENCY,
      supports_concurrency_option: true,
    },
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
    description: "Reply to mail and mark parent read (batch-capable).",
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
    command_id: "signal.escalate",
    command: "escalate",
    category: "workflow",
    description: "Raise a hand: needs attention, work continues.",
    schemas: [signalEscalateSchema],
    examples: allExamples.filter((e) => e.command_id === "signal.escalate"),
  },
  {
    command_id: "signal.blocked",
    command: "blocked",
    category: "workflow",
    description: "Raise a hand: entirely blocked on the operator.",
    schemas: [signalBlockedSchema],
    examples: allExamples.filter((e) => e.command_id === "signal.blocked"),
  },
  {
    command_id: "signal.feedback",
    command: "feedback",
    category: "workflow",
    description: "Raise a hand: ready for the operator's review.",
    schemas: [signalFeedbackSchema],
    examples: allExamples.filter((e) => e.command_id === "signal.feedback"),
  },
  {
    command_id: "signal.list",
    command: "signal list",
    category: "workflow",
    description: "Read this seat's signals and the operator's answers.",
    schemas: [signalListSchema],
    examples: allExamples.filter((e) => e.command_id === "signal.list"),
  },
  {
    command_id: "signal.clear",
    command: "signal clear",
    category: "workflow",
    description: "Withdraw this seat's own open signal.",
    schemas: [signalClearSchema],
    examples: allExamples.filter((e) => e.command_id === "signal.clear"),
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
  // Inline on purpose: a module const would keep the browser rows in the machine bundle.
  ...((typeof __JUNTO_MACHINE_BUILD__ === "boolean" && __JUNTO_MACHINE_BUILD__) ? [] : BROWSER_ENABLED ? browserCapabilities : []),
  envReportCapability,
  logsReadCapability,
  ...referencesCapabilities,
  ...overseerCapabilities,
  ...automationCapabilities,
];

/** Capability rows follow their command: a disabled surface is not discoverable. */
export const commandCapabilities: ReadonlyArray<CommandCapability> =
  declaredCapabilities.filter((capability) =>
    commandSurfaceEnabled(capability.command_id),
  );
