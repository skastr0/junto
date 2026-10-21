import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { LIVE_OVERSEER_ENABLED } from "@shared/features";
import { isOverseerHarness } from "@shared/harness-records";
import { resolveJuntoHome } from "@shared/junto-home";
import { join } from "node:path";
import { Effect, Result, Option, Schema } from "effect";
import { ulid } from "ulid";
import type { Message } from "@shared/work-model";
import {
  decodeOverseerArgs,
  decodeOverseerRequest,
  isOverseerMutation,
  OVERSEER_MAX_CORRELATION_BYTES,
  OVERSEER_MAX_REQUEST_BYTES,
  type OverseerRequest,
  type OverseerResult,
} from "@shared/overseer-control";
import {
  decodeOverseerHostRequest,
  type OverseerHostAssignment,
  type OverseerHostRequest,
} from "@shared/overseer-host-control";
import type { OverseerHostIdentity, OverseerLiveExecutionConstraint } from "../overseer/live/execution";
import { sortMessagesNewestFirst } from "@shared/message-delivery";
import {
  MAIL_MESSAGE_ID_SHAPE,
  isMailMessageId,
  type MailMessageId,
  mailExtensionMetadata,
  mailThreadOf,
  type MailSenderStamp,
} from "@shared/crew";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import { mailListFilterOf, mailListMatches, sinceCursorOf } from "@shared/mail-list-filter";
import { operatorFilesOf } from "@shared/mail-threads";
import { levelOfSignal, rankOf } from "@shared/wire/urgency";
import { seatStateRuntime } from "../term/agent-state";
import { probeManagedHarnessInstalls } from "../term/templates/harness-install";
import type { Task } from "@shared/work-model";
import {
  normalizePreambleText,
  seatToolPreamble,
  PREAMBLE_MAX_TEXT_LENGTH,
  PREAMBLE_TTL_MS,
  type PreambleEvent,
} from "@shared/preamble";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  type AgentSignalAttachment,
  compareSignalListOrder,
  normalizeSignalText,
  type AgentSignal,
} from "@shared/agent-signals";
import type { ActorRef } from "@shared/work-protocol";
import {
  makeAgentMessage,
  makeUserMessage,
} from "@shared/task";
import {
  isOwnMailboxTarget,
  resolveMailboxTarget,
} from "@shared/mailbox-target";
import { formatNodeRef } from "@shared/node-ref";
import {
  ContentMaterializeArgs,
  ContentPathArgs,
  ContentStatArgs,
  EmptyArgs,
  MsgListArgs,
  MSG_LIST_ARGS_SHAPE,
  MsgReactArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  MsgPromptArgs,
  MsgSentArgs,
  SeatWaitArgs,
  SeatReadArgs,
  PreambleArgs,
  SignalClearArgs,
  SignalListArgs,
  type SignalListResult,
  EnvReportArgs,
  LogsReadArgs,
  SignalRaiseArgs,
  OffboardArgs,
  OnboardArgs,
  SinceArgs,
  RulingsArgs,
  TasksCheckArgs,
  VerdictPostArgs,
  WORK_MAX_FRAME_BYTES,
  WORK_PROTOCOL_VERSION,
  WorkOpName,
  decodeWorkRequest,
  encodeWorkFrame,
  workErr,
  workOk,
  workControlDir,
  workControlSocketPath,
  type WorkErrorDetails,
  type WorkErrorBody,
  type WorkErrorType,
  type WorkOpName as WorkOp,
  type WorkResponseEnvelope,
} from "@shared/work-control";
import { ContentService } from "../content/service";
import { operatorAttachmentLines } from "../content/operator-attachments";
import { handleContentStage } from "./content-stage";
import { handleSeatReferences, onboardReferenceFields } from "../references/seat-reads";
import { noteSeatPreamble } from "./seat-preambles";
import {
  claimSignalAttachments,
  releaseSignalAttachments,
  signalAttachmentOwner,
} from "../signals/attachments";
import { signalResourcesFor } from "../signals/resource-refs";
import {
  materializeContentObject,
  taskContentRef,
} from "../content/agent-access";
import { contentObjectPath } from "../content/paths";
import { ContentStoreError } from "../content/store";
import { WorkService, type WorkOpResult } from "./service";
import { isAutomationReadOp, isAutomationWriteOp } from "@shared/automation-control";
import { handleAutomationRead, liveAutomationPorts } from "./automation-control";
import { ARTIFACT_WRITE_OPS, isArtifactOp } from "@shared/artifact-control";
import { handleArtifactOp, liveArtifactPorts } from "./artifact-control";
import { TASK_WRITE_OPS, isTaskControlOp } from "@shared/task-control";
import { handleTaskOp, liveTaskPorts } from "./task-control";
import { liveSeatObservation } from "./seat-observation-live";
import { onboardSinceSection, readSeatSince } from "./seat-since-read";
import { messageDelivery } from "./message-delivery";
import { readMailExtension } from "@shared/crew";
import { noticeTakesReply, subjectNoticeKindOf } from "@shared/subject-notice";
import { taskNodeId } from "@shared/task-model";
import { taskSubjectOf, taskThreadOf } from "@shared/task-notices";
import { subjectLabel, threadSubjectOf, type ResourceSubject } from "@shared/thread-subject";
import { isItemId, OpId } from "@shared/work-ids";
import { postSubjectComment } from "./subject-comment";
import { subjectPeopleAt } from "./subject-people";
import { handleOpOp, isOpOp } from "./op-control";
import {
  AgentSignalRepository,
  type AgentSignalRepositoryError,
} from "../signals/repository";
import { PausePlane } from "../pause-plane";
import { SeatGuidanceRepository } from "../seat-guidance/repository";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { announcedSessionRefusal } from "../seat-sessions/announced-session";
import { announceSeatOffboard, listSeatSessions } from "../seat-sessions/service";
import type { SeatSessionNotes, SeatSessionObservation } from "../seat-sessions/repository";
import { offeredCapturedSessionId } from "../term/session-id-store";
import { harnessSessionExists } from "../term/session-existence";
import {
  CONTINUATION_FRAMING,
  PREVIOUS_WITHOUT_NOTES_FRAMING,
  describeSessionDrain,
  describeTranscriptMissing,
  sessionDrainCaution,
  type SeatSession,
  gistOfNotes,
  PAST_SESSIONS_FRAMING,
  SEAT_SESSION_CONTINUATION_MAX_CHARS,
  SEAT_SESSION_NOTES_MAX_CHARS,
  type OffboardMode,
} from "@shared/seat-sessions";
import { PortraitOverrideRepository } from "../portraits/repository";
import { recoverDocumentLaunchChoices } from "@shared/launch-choices";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { TASKS_ENABLED } from "@shared/features";
import {
  compileConnectionInstructions,
  compileReach,
  coMembersByRegion,
  onboardGuidanceFor,
  renderSince,
  toolsBeyondGuidance,
} from "@shared/seat-onboarding";
import { SINCE_PER_SECTION } from "@shared/seat-since";
import { isResourceKind, resourcesInReach } from "@shared/region-reach";

/** Ops that act on the factory — refused for paused seats. Reads stay open. */
const MUTATING_OPS: ReadonlySet<string> = new Set([
  "task.check",
  ...TASK_WRITE_OPS,
  "content.materialize",
  "preamble",
  "msg.list",
  "msg.send",
  "msg.prompt",
  "verdict.post",
  "msg.read",
  "msg.reply",
  "msg.react",
  ...ARTIFACT_WRITE_OPS,
  // Agent signals stay open while paused: raising a hand to the operator is
  // not a factory act, and a paused seat may need to say it is stuck.
]);

import {
  admitWorkTarget,
  connectedCapabilities,
  containingRegion,
  factoryRoleOfNode,
  findNode,
  nodeKind,
  nodeTitle,
  regionStackFor,
  linkSeatMentions,
  mailMentionCandidates,
  regionVisibility,
  resolveWorkTarget,
  resourceMentionCandidates,
  summarizeNode,
} from "./authz";
import { resolveTaskAdmission } from "@shared/work-model";
import {
  boardContractOf,
  regionContractOf,
  rulesInForce,
  taskAdmissionState,
} from "@shared/rules";
import { regionStack } from "@shared/model/canvas";
import { flowDestinations, reachableBoards } from "@shared/flow-graph";
import { asNodeId, mailSenderRegions, seatIdentity, taskBoardTitle, type Canvas, type Node, type SeatIdentity } from "@shared/model";
import { resolveCallerAcrossCanvases } from "./caller-resolve";

import { closingFence } from "../term/closing-fence";
import { injectionSupervisor } from "../term/injection-supervisor";
import { readMachineLog, seatLogScope } from "../observability/log-file";
import { logMachine } from "../observability/logger";
import {
  OFFBOARDED_SESSION_MESSAGE,
  type ProcessPrincipal,
} from "../process-identity";
import {
  getSeatCredentialRegistry,
  type SeatCredentialRegistry,
} from "./seat-credentials";
import {
  MainAuthoringRefused,
  mainAuthoringGate,
  mainAuthoringLabelForWorkOperation,
  type MainAuthoringGate,
} from "../main-authoring-gate";
import {
  acquireControlListenerLease,
  captureControlSocketPathIdentity,
  controlListenerLeaseHeld,
  controlSocketPathOwnedByLease,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
  removeOwnedControlSocketPath,
  type ControlSocketPathIdentity,
} from "../control-filesystem";
// Local work control plane for agents: NDJSON over a Unix domain socket at
// ~/.junto/work/control.sock. Seat generation credential + edge authz;
// mutations route through WorkService. One admission path, no second identity.

// ---------------------------------------------------------------------------
// Work home. The seat credential is minted at spawn, not written to a file.

export const resolveWorkHome = (home?: string, workHome?: string): string => {
  if (workHome && workHome.trim().length > 0) return workHome.trim();
  const env = process.env.JUNTO_WORK_HOME?.trim();
  if (env) return env;
  return workControlDir(home ?? resolveJuntoHome());
};

const systemdReadinessReceipt = (): { readonly generation: string; readonly path: string } | undefined => {
  const generation = process.env.INVOCATION_ID;
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  // XDG_RUNTIME_DIR is ambient in ordinary Linux desktop sessions. Only a
  // systemd invocation id opts this process into Remote readiness publication.
  if (generation === undefined) return undefined;
  if (
    runtimeDirectory === undefined || !/^[0-9a-f]{32}$/.test(generation) ||
    !runtimeDirectory.startsWith("/") ||
    runtimeDirectory.includes("\0")
  ) {
    throw new Error("invalid systemd generation readiness environment");
  }
  return Object.freeze({
    generation,
    path: join(runtimeDirectory, "junto-remote", `ready-${generation}`),
  });
};

/**
 * Witness the exact systemd invocation after this process has bound the work
 * listener. Deep terminal, browser, and canvas checks belong to Doctor and
 * release qualification; they never block station boot.
 */
export const publishSystemdGenerationReadiness = (): void => {
  const readiness = systemdReadinessReceipt();
  if (readiness === undefined) return;
  writeFileSync(readiness.path, `${readiness.generation}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const published = lstatSync(readiness.path);
  if (!published.isFile() || (published.mode & 0o777) !== 0o600) {
    throw new Error("systemd generation readiness receipt was not private regular file");
  }
};

// ---------------------------------------------------------------------------
// Admission: the presented seat generation credential proves which live seat
// calls. One path, one lookup — no process observation on admission.

export type WorkIdentityAdmission =
  | {
      readonly ok: true;
      readonly credential: string;
      readonly generationId: string;
      readonly principal: ProcessPrincipal;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "process_unbound"
        | "process_offboarded"
        | "seat_suspended";
      readonly message: string;
    };

/**
 * Pure work identity admission. The frame token is the seat generation
 * credential main issued at spawn: live credentials admit, suspended ones fail
 * closed until canvas reattach, revoked ones hear the offboarded sentence,
 * and unknown values are strangers. There is no second admission — a caller
 * with no live credential has no identity.
 */
export const admitWorkIdentity = (input: {
  readonly credentials: SeatCredentialRegistry;
  readonly presentedToken: string;
}): WorkIdentityAdmission => {
  const found = input.credentials.lookup(input.presentedToken);
  if (found.status === "live") {
    return {
      ok: true,
      credential: input.presentedToken,
      generationId: found.generationId,
      principal: found.principal,
    };
  }
  if (found.status === "suspended") {
    return {
      ok: false,
      reason: "seat_suspended",
      message:
        "this seat is detached from its canvas — reattach it on the canvas and retry",
    };
  }
  if (found.status === "revoked") {
    return {
      ok: false,
      reason: "process_offboarded",
      message: OFFBOARDED_SESSION_MESSAGE,
    };
  }
  return {
    ok: false,
    reason: "process_unbound",
    message:
      "connecting process presents no live seat credential — run the CLI from inside your Junto seat",
  };
};

const occupantKeyForPrincipal = (
  principal: ProcessPrincipal,
  suffix: string,
): string => {
  const base = `agent:${principal.agentKey ?? principal.bindingId ?? principal.nodeId ?? "unknown"}`;
  return `${base}@${suffix}`;
};

// ---------------------------------------------------------------------------
// Domain error mapping

/** A mail as a seat reads it names its thread, and its parent when it answers one. */
const withThread = <M extends Message>(message: M): M & { readonly threadId: string; readonly inReplyTo?: string } => {
  const inReplyTo = message.metadata?.inReplyTo;
  return {
    ...message,
    threadId: mailThreadOf(message),
    ...(typeof inReplyTo === "string" ? { inReplyTo } : {}),
  };
};

/**
 * A seat's own mail with the operator's files on it placed where the seat
 * opens them: `files`, one `Attached:` line each, the lines its delivery
 * typed. Mail with no files, or whose files are not on this machine yet,
 * reads as it is.
 */
const withMailFiles = (canvasName: string, nodeId: string) =>
  <M extends Message>(message: M): Effect.Effect<M | (M & { readonly files: ReadonlyArray<string> })> =>
    Effect.gen(function* () {
      const refs = operatorFilesOf(message);
      if (refs.length === 0) return message;
      const store = yield* Effect.serviceOption(ContentService);
      if (Option.isNone(store)) return message;
      const files = yield* operatorAttachmentLines(store.value, { canvasName, nodeId, messageId: message.messageId, refs }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return files === undefined ? message : { ...message, files };
    });

/**
 * A message id argument. A refusal names the path and the shape it wants and
 * never echoes what the caller sent.
 */
const mailIdArg = (path: string, value: string): Result.Result<string, WorkErrorBody> => {
  const trimmed = value.trim();
  return isMailMessageId(trimmed)
    ? Result.succeed(trimmed)
    : Result.fail({
        type: "InputError",
        message: `${path} must be ${MAIL_MESSAGE_ID_SHAPE}`,
        details: { path, expected: "ULID", retryable: false },
      });
};

/** A mail target: a seat, never an item inside a node. */
const resolveMailTarget = (
  board: Canvas,
  callerId: string,
  typed: string,
  op: WorkOpName,
): Result.Result<string, WorkErrorBody> => {
  const named = resolveWorkTarget(board, callerId, typed, op);
  if (Result.isFailure(named)) return Result.fail(named.failure);
  if (named.success.itemId !== undefined) {
    return Result.fail({
      type: "InputError",
      message: "mail goes to a seat; this target names an item inside a node",
      details: { path: "target", retryable: false, next_step: "send to the seat's name, node id or ref without &item" },
    });
  }
  return Result.succeed(named.success.nodeId);
};

/**
 * The thread a comment on a task joins: the task's one thread, keyed by the
 * task's id. Undefined when the node is no task node or the id is no ULID (a
 * task from before item ids), whose comments stay out of threads.
 */
const taskThreadAt = (
  board: Canvas,
  nodeId: string,
  taskId: string,
): { readonly subject: ResourceSubject; readonly threadId: string } | undefined => {
  if (findNode(board, nodeId)?.kind !== "task" || !isItemId(taskId)) return undefined;
  const task = { node: taskNodeId(asNodeId(nodeId)), taskId };
  return { subject: taskSubjectOf(task), threadId: taskThreadOf(task) };
};

/** The thread metadata a reply to `parent` carries. One rule for all mail. */
const replyThreadMetadata = (parent: Message): { readonly inReplyTo: string; readonly threadId: string } => ({
  inReplyTo: parent.messageId,
  threadId: mailThreadOf(parent),
});

/**
 * Deterministic code → wire mapping. Structured facts travel in
 * WorkServiceError.details straight from the service; nothing here is parsed
 * out of message text.
 */
const mapWorkCode = (
  code: import("./service").WorkServiceErrorCode,
  message: string,
  details?: WorkErrorDetails,
): WorkErrorBody => {
  switch (code) {
    case "reviewer_is_author":
      return { type: "ReviewerIsAuthor", message, details: { ...details, retryable: false } };
    case "scope_error":
      return { type: "ScopeError", message, details: { ...details, retryable: false } };
    case "claim_contention":
      return {
        type: "ClaimConflict",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "wait for the holder to release, or pick another task",
        },
      };
    case "operator_owned":
      return {
        type: "ClaimConflict",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "the operator works tasks at this board; pick a board agents can claim",
        },
      };
    case "illegal_transition":
      return {
        type: "InvalidTransition",
        message,
        details: {
          ...details,
          retryable: false,
        },
      };
    case "node_not_found":
    case "task_not_found":
      return {
        type: "UnknownTarget",
        message,
        details: { ...details, retryable: false },
      };
    case "canvas_not_found":
      return {
        type: "StaleNodeRef",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "the canvas for this call is not loaded; ask the operator to open it in Junto",
        },
      };
    case "illegal_kind":
      return {
        type: "ScopeError",
        message,
        details: {
          ...details,
          retryable: false,
          hint: details?.hint ?? "pick a target whose kind supports this op",
          next_step:
            details?.next_step ??
            "call a connected node of a kind that supports this op; if none is connected, ask the operator to wire an edge to one on the canvas",
        },
      };
    case "not_ready":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "finish the prerequisites before claiming this task",
        },
      };
    case "unadmitted":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "wait for the operator or for the wait before starting to pass, or pick another task",
        },
      };
    case "fork_choice":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step: details?.next_step ?? "name the next board",
        },
      };
    case "wrong_home":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "run this op on the installation that owns the task",
        },
      };
    default:
      return {
        type: "InputError",
        message,
        details: { ...details, retryable: details?.retryable ?? false },
      };
  }
};

/**
 * Seat-wire only. Operator approve / reject IPC is the door into unadmitted
 * tasks; a connected seat must not update or run checks on a submitted row
 * whose admission is not yet claimable.
 */
const refuseUnadmittedSubmitted = (
  task: Task | undefined,
  node: Node | undefined,
  contract: import("@shared/work-model").TasksContract | undefined,
): WorkErrorBody | undefined => {
  if (task === undefined || task.state !== "submitted") return undefined;
  const admission = taskAdmissionState(
    task,
    contract,
    Date.now(),
  );
  if (admission === "claimable") return undefined;
  const refusal =
    admission === "approval"
      ? `task "${task.id}" awaits operator approval at board "${node?.id ?? "?"}"`
      : admission === "waiting"
        ? `task "${task.id}" is not claimable before ${task.waitUntil} (wait before starting)`
        : `board "${node?.id ?? "?"}" is set to Me — the operator works tasks here; no seat update`;
  return {
    type: "InputError",
    message: refusal,
    details: {
      target: task.id,
      retryable: false,
      next_step:
        admission === "approval"
          ? "wait for the operator to approve this task, or claim another task"
          : admission === "waiting"
            ? "wait until the wait before starting passes, or claim another task"
            : "only the operator works tasks at this board",
    },
  };
};

type WorkMutationOutcome<T> = {
  readonly value: T;
  readonly disposition: "applied" | "queued";
  readonly message?: string;
};

const fromWorkResult = <T>(
  result: WorkOpResult<T>,
): Result.Result<WorkMutationOutcome<T>, WorkErrorBody> => {
  if (result.ok) {
    return Result.succeed({
      value: result.data,
      disposition: result.disposition,
      ...(result.message === undefined ? {} : { message: result.message }),
    });
  }
  return Result.fail(
    mapWorkCode(result.code, result.message, result.details),
  );
};

const exposeWorkMutation = <T extends object>(
  outcome: WorkMutationOutcome<T>,
): T & { readonly disposition: "applied" | "queued"; readonly message?: string } => ({
  ...outcome.value,
  disposition: outcome.disposition,
  ...(outcome.message === undefined ? {} : { message: outcome.message }),
});

const decodeArgs = <S extends Schema.Top>(
  schema: S,
  args: unknown,
): Result.Result<Schema.Schema.Type<S>, WorkErrorBody> => {
  const decoded = Schema.decodeUnknownResult(schema as never, {
    onExcessProperty: "error",
  })(args ?? {});
  if (Result.isFailure(decoded)) {
    return Result.fail({
      type: "InputError",
      message: decoded.failure.message,
      details: {
        path: "args",
        hint: "pass a JSON object matching the command schema",
        retryable: false,
      },
    });
  }
  return Result.succeed(decoded.success as never);
};

const taskIdentity = (node: Node | undefined, id: string) => {
  const identity = taskBoardTitle(node?.kind === "task" ? node : undefined, id);
  return { ...identity, ...(identity.source === "id" ? { namingHint: "Name this node to name the board." } : {}) };
};
const taskName = (node: Node | undefined, id: string) => taskIdentity(node, id).name;

/**
 * Standing rules per board a task raised here can still reach, with
 * provenance, and how incoming tasks are admitted. Pure projection of the model
 * — no work rows involved.
 */
/**
 * Trimmed contract guidance for one board. Blank or whitespace-only authored
 * values never surface (authored fields can hold them even though the editor
 * normalizes).
 */
const boardGuidance = (
  doc: Canvas,
  board: string,
): {
  instructions?: string;
  incomingHandling?: string;
  incomingDescription?: string;
  outgoingHandoff?: string;
  outgoingDescription?: string;
} => {
  const contract = boardContractOf(doc, board);
  const instructions = contract?.instructions?.trim();
  const incomingHandling = contract?.incoming?.handling?.trim();
  const incomingDescription = contract?.incoming?.description?.trim();
  // Handoff prose only surfaces when the board can send the task on.
  const hasNext = flowDestinations(doc, board).length > 0;
  const outgoingHandoff = hasNext ? contract?.outgoing?.handoff?.trim() : undefined;
  const outgoingDescription = hasNext
    ? contract?.outgoing?.description?.trim()
    : undefined;
  return {
    ...(instructions ? { instructions } : {}),
    ...(incomingHandling ? { incomingHandling } : {}),
    ...(incomingDescription ? { incomingDescription } : {}),
    ...(outgoingHandoff ? { outgoingHandoff } : {}),
    ...(outgoingDescription ? { outgoingDescription } : {}),
  };
};

/** Rules in force per reachable board, with the board's admission posture. */
const boardRulesMap = (doc: Canvas, fromNodeId: string) =>
  [...reachableBoards(doc, fromNodeId)].map((board) => {
    const node = doc.nodes.get(asNodeId(board));
    const identity = taskIdentity(node, board);
    const contract = boardContractOf(doc, node?.id ?? "");
    const incoming = contract?.incoming;
    return {
      board,
      name: identity.name,
      rules: rulesInForce(doc, board).map((entry) => ({
        id: entry.rule.id,
        text: entry.rule.text,
        provenance: entry.provenance,
      })),
      admission: resolveTaskAdmission(contract),
      ...(incoming?.description !== undefined
        ? { description: incoming.description }
        : {}),
      ...boardGuidance(doc, board),
    };
  });

/**
 * Onboard's per-board summary: what this board stands for, how many rules
 * it carries, and where work goes next. Undefined for nodes that carry no
 * board contract and no flow edges, so plain nodes stay quiet.
 */
const boardBriefing = (doc: Canvas, nodeId: string) => {
  // Tasks are a product surface: a tasks-off build carries no board summary.
  if (!TASKS_ENABLED) return undefined;
  const node = doc.nodes.get(asNodeId(nodeId));
  const identity = taskIdentity(node, nodeId);
  const contract = boardContractOf(doc, node?.id ?? "");
  const next = flowDestinations(doc, nodeId).map((destination) => {
    const destinationNode = doc.nodes.get(asNodeId(destination));
    const incoming = boardContractOf(doc, destination)?.incoming;
    return {
      board: destination,
      name: taskName(destinationNode, destination),
      ...(incoming?.description !== undefined
        ? { description: incoming.description }
        : {}),
      admission: resolveTaskAdmission(boardContractOf(doc, destination)),
    };
  });
  if (contract === undefined && next.length === 0) return undefined;
  return {
    board: {
      name: identity.name,
      ...(identity.namingHint ? { namingHint: identity.namingHint } : {}),
    },
    contract: {
      ...boardGuidance(doc, nodeId),
      rules: rulesInForce(doc, nodeId).length,
      admission: resolveTaskAdmission(contract),
    },
    next,
  };
};

const rulingsForRegionStack = (doc: Canvas, nodeId: string) =>
  regionStack(doc, asNodeId(nodeId)).flatMap((group) => {
    const rulings = regionContractOf(group)?.rulings ?? [];
    if (rulings.length === 0) return [];
    return [{
      region: group.id,
      label: group.label?.trim() || group.id,
      rulings,
    }];
  });

// ---------------------------------------------------------------------------
// Dispatch

type RunEffect = <A, E>(
  effect: Effect.Effect<A, E, WorkService | PausePlane>,
) => Promise<A>;

const PREAMBLE_TOOL = Object.freeze({
  id: "preamble",
  command: "junto preamble",
  description: "Show a short-lived thought bubble above this agent node.",
  input: { text: "..." },
});

/** Universal on every seat: how a seat raises its hand to the operator. */
const SIGNAL_TOOLS = Object.freeze([
  Object.freeze({
    id: "escalate",
    command: "junto escalate",
    description: "Needs the operator's attention; you keep working.",
    input: { text: "...", detail: "optional markdown" },
  }),
  Object.freeze({
    id: "blocked",
    command: "junto blocked",
    description: "Work is entirely blocked on the operator; stop and wait.",
    input: { text: "...", detail: "optional markdown" },
  }),
  Object.freeze({
    id: "feedback",
    command: "junto feedback",
    description: "Not blocked; the work is ready for the operator to review.",
    input: { text: "...", detail: "optional markdown" },
  }),
  Object.freeze({
    id: "signal",
    command: "junto signal list | junto signal clear [id]",
    description: "Read the operator's answers, or withdraw your own open signal.",
  }),
]);

const SIGNAL_NEXT_STEP = {
  blocked:
    "stop and wait: the operator's answer arrives in this seat as operator mail; junto signal list shows it",
  escalate:
    "keep working: the operator's answer arrives in this seat as operator mail; junto signal list shows it",
  feedback:
    "keep going or wrap up: any review arrives as operator mail; junto signal clear withdraws this if it no longer applies",
} as const;

const OVERSEER_TOOL = Object.freeze({
  id: "overseer",
  command: "junto overseer skill",
  description: "Learn Junto canvas and node administration. Human-granted authority; independent of pause/play.",
});

const ensureCaller = (
  doc: Canvas,
  nodeId: string,
): WorkErrorBody | undefined => {
  const node = findNode(doc, nodeId);
  if (!node) {
    return {
      type: "StaleNodeRef",
      message: `caller node "${nodeId}" not found on canvas`,
      details: {
        path: "caller",
        received: nodeId,
        retryable: false,
        next_step: "your node is no longer on the canvas; ask the operator to restore it",
      },
    };
  }
  return undefined;
};

const requireTarget = (
  doc: Canvas,
  callerId: string,
  targetId: string,
  op: WorkOp,
): WorkErrorBody | { readonly node: ReturnType<typeof findNode> } => {
  // Target-scoped ops: canvas physics admit (edge + role law + port facet).
  const admitted = admitWorkTarget(doc, callerId, targetId, op);
  if (Result.isFailure(admitted)) return admitted.failure;
  return { node: admitted.success.node };
};

/** Work-control caller resolved through the sole credential admission path. */
type WorkCaller = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly workHome: string;
  /** Occupant label for proof stamps / logs. */
  readonly occupant: string;
  /** Main-issued generation credential incarnation; no client-supplied generation claims. */
  readonly generation: string;
};

const mailSenderStamp = (
  board: Canvas,
  caller: WorkCaller,
  actor: ActorRef,
): MailSenderStamp => {
  const node = findNode(board, caller.nodeId);
  const terminal = node?.kind === "agent" ? node : undefined;
  const epoch = terminal?.bindingId === undefined
    ? undefined
    : seatStateRuntime.machine.getSlot(terminal.bindingId)?.epoch;
  return {
    fromSeat: actor.seatId,
    senderGeneration: epoch ?? caller.generation,
    senderHarness: terminal?.harness ?? "unknown",
    senderNodeId: caller.nodeId,
    senderName: node === undefined ? caller.nodeId : nodeTitle(node),
    ...(node === undefined ? {} : { senderRegions: mailSenderRegions(board, caller.nodeId) }),
  };
};

/** Who a mail went to, as the sender reads it back. */
const recipientOf = (board: Canvas, nodeId: string): SeatIdentity => {
  const node = findNode(board, nodeId);
  return node === undefined ? { nodeId, name: nodeId, regions: [] } : seatIdentity(board, node);
};

/** The operator, who is no node, as a reply's recipient. */
const OPERATOR_RECIPIENT: SeatIdentity = { nodeId: "operator", name: "operator", regions: [] };

/**
 * Resolve one credential-admitted actor node through the compiled execution
 * projection. Node IDs remain routing/display facts; only ActorRef carries
 * work authority.
 */
export const resolveProcessBoundActorRef = (
  actorRefs: ReadonlyArray<ActorRef>,
  caller: Pick<WorkCaller, "canvasName" | "nodeId">,
): Result.Result<ActorRef, WorkErrorBody> => {
  const matches = actorRefs.filter(
    (actor) =>
      actor.canvasName === caller.canvasName &&
      actor.nodeId === caller.nodeId,
  );
  if (matches.length === 1) return Result.succeed(matches[0]!);
  return Result.fail({
    type: "StaleNodeRef",
    message:
      matches.length === 0
        ? `caller node "${caller.nodeId}" does not resolve to a live agent`
        : `caller node "${caller.nodeId}" resolves to more than one live agent`,
    details: {
      caller: caller.nodeId,
      retryable: false,
      next_step:
        "your process does not resolve to exactly one agent node; ask the operator to check this agent on the canvas",
    },
  });
};

/**
 * An agent seat's configuration for `junto onboard`. The operator's soul,
 * instructions, and look come from their stores when this runtime has them;
 * a store that cannot answer leaves its field out rather than failing onboard.
 */
const seatConfigurationOf = (node: Node) =>
  Effect.gen(function* () {
    const terminal = node.kind === "agent" ? node : undefined;
    const harness = terminal?.harness;
    if (!harness) return undefined;
    const choices = isHarnessId(harness) ? recoverDocumentLaunchChoices(harness, terminal.launch) : {};
    const name = terminal.label.trim();
    const guidanceStore = yield* Effect.serviceOption(SeatGuidanceRepository);
    const guidance = Option.isSome(guidanceStore)
      ? yield* guidanceStore.value.get(node.id).pipe(Effect.orElseSucceed(() => null))
      : null;
    const portraitStore = yield* Effect.serviceOption(PortraitOverrideRepository);
    const look = Option.isSome(portraitStore)
      ? (yield* portraitStore.value.list().pipe(Effect.orElseSucceed(() => ({}) as Record<string, never>)))[node.id]
      : undefined;
    return {
      ...(name ? { name } : {}),
      harness,
      ...(choices.profile ? { harness_profile: choices.profile } : {}),
      ...(choices.model ? { model: choices.model } : {}),
      ...(choices.effort ? { effort: choices.effort } : {}),
      ...(choices.mode ? { mode: choices.mode } : {}),
      ...(look ? { look } : {}),
      ...(guidance?.soul ? { soul: guidance.soul } : {}),
      ...(guidance?.instructions ? { instructions: guidance.instructions } : {}),
    };
  });

/**
 * The caller seat's current harness session: its store pin, or an id
 * the seat announced that the harness's own files already prove. An
 * announced id the capture path refused, or would refuse (another seat's,
 * one this seat ended), is never offered: notes, a record or a commit
 * saved under it would belong to a session that is not this seat's.
 */
const currentSeatSession = (node: Node, repository: SeatSessionRepository["Service"]) => Effect.gen(function* () {
  const named = node.kind === "agent"
    ? yield* repository.current(node.id, node.bindingId).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  if (named?.harness === (node.kind === "agent" ? node.harness : undefined)) return named;
  const surface = node.kind === "agent" ? node : undefined;
  if (surface === undefined) return undefined;
  const captured = offeredCapturedSessionId(surface.bindingId);
  const cwd = surface?.launch?.cwd?.trim();
  if (!captured || !harnessSessionExists({ harness: surface.harness, sessionId: captured, ...(cwd ? { cwd } : {}) })) {
    return undefined;
  }
  const refusal = yield* announcedSessionRefusal(repository, { seatId: node.id, harness: surface.harness, sessionId: captured }).pipe(
    Effect.orElseSucceed(() => "the seat's sessions could not be read"),
  );
  if (refusal !== undefined) return undefined;
  return { seatId: node.id, bindingId: surface.bindingId, sessionId: captured, harness: surface.harness, ...(cwd ? { cwd } : {}) };
});

/**
 * Look for a seat's session id right now. A harness that mints its own id is
 * read at the seat's state boundaries, so in the first turn of a fresh
 * session the id can be on disk and not yet known here; an agent that
 * offboards then would be refused and left with no turn in which to try again.
 */
let seatSessionLookup: ((bindingId: string) => Promise<string | undefined>) | undefined;

/** Wired by the app to the seat's session capture. */
export const setSeatSessionLookup = (
  lookup: ((bindingId: string) => Promise<string | undefined>) | undefined,
): void => {
  seatSessionLookup = lookup;
};

/** The session found by looking once, or undefined (never a failure). */
const lookForSeatSession = (node: Node): Effect.Effect<SeatSessionObservation | undefined> => {
  const surface = node.kind === "agent" ? node : undefined;
  const lookup = seatSessionLookup;
  if (surface === undefined || lookup === undefined) return Effect.succeed(undefined);
  const cwd = surface?.launch?.cwd?.trim();
  return Effect.promise(() => lookup(surface.bindingId).catch(() => undefined)).pipe(
    Effect.map((sessionId) =>
      sessionId?.trim()
        ? { seatId: node.id, bindingId: surface.bindingId, sessionId: sessionId.trim(), harness: surface.harness, ...(cwd ? { cwd } : {}) }
        : undefined,
    ),
  );
};

const isoAt = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

/**
 * `junto onboard`'s past sessions: the last one before this session, with its
 * gist, notes and transcript, and a count of the earlier ones. Framed as
 * history, never as work to resume, with one exception: the handoff, the
 * continuation note the previous session left for this one. Absent when this
 * runtime keeps no seat sessions.
 */
/**
 * What became of a session's process after its seat moved on, for the session
 * that follows it: one line, and a caution when the transcript's tail cannot
 * be trusted (still being written, or cut mid-turn). Nothing for a session
 * that was never detached.
 */
const windDownOf = (session: SeatSession) => {
  if (session.drain === undefined) return {};
  const caution = sessionDrainCaution(session.drain);
  return {
    wind_down: describeSessionDrain(session.drain),
    ...(caution === undefined ? {} : { transcript_caution: caution }),
  };
};

/** A session's transcript, or a plain line on why it has none, never a bare null. */
const transcriptOf = (session: SeatSession) => ({
  transcript_path: session.transcriptPath ?? null,
  ...(session.transcriptMissing === undefined
    ? {}
    : { transcript_missing: describeTranscriptMissing(session.harness, session.transcriptMissing) }),
});

/** What a session that left no notes says in their place: who closed it. */
const closedWithoutNotes = (session: SeatSession): string => {
  switch (session.endedBy) {
    case "automatic":
      return "closed by Junto, no notes";
    case "operator":
      return "ended by the operator, no notes";
    case "overseer":
      return "ended by an overseer, no notes";
    case undefined:
      return "ended without notes";
    default:
      return session.endedBy satisfies never;
  }
};

const pastSessionsOf = (node: Node) =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(SeatSessionRepository);
    if (Option.isNone(store)) return undefined;
    const current = yield* currentSeatSession(node, store.value);
    const recorded = yield* listSeatSessions(node.id, current?.cwd).pipe(
      Effect.provideService(SeatSessionRepository, store.value),
    );
    const mine = recorded.find((session) => session.sessionId === current?.sessionId);
    const past = recorded.filter((session) => session !== mine);
    // The one exception to history: a continuation the session just before
    // this one left for it. Only the next session gets it, and only here.
    // It is complete by itself, in the order an agent needs it: what to do
    // next, then what happened, then where the full record lives.
    const previous = past[0];
    // Notes are read for the last session only, never the whole history.
    const notesOf = yield* store.value.notesOf(
      node.id,
      previous?.offboardedAt === undefined ? [] : [previous.sessionId],
    ).pipe(Effect.orElseSucceed((): ReadonlyMap<string, SeatSessionNotes> => new Map()));
    const continuation =
      previous?.endReason === "offboard" ? notesOf.get(previous.sessionId)?.continuation : undefined;
    const handoffNotes =
      previous !== undefined && continuation ? notesOf.get(previous.sessionId)?.notes : undefined;
    const handoff =
      previous !== undefined && continuation
        ? {
            note: CONTINUATION_FRAMING,
            from_session: previous.sessionId,
            left_at: isoAt(previous.offboardedAt ?? previous.endedAt),
            continuation,
            gist: previous.gist ?? null,
            ...(handoffNotes === undefined ? {} : { notes: handoffNotes }),
            ...transcriptOf(previous),
            ...windDownOf(previous),
          }
        : undefined;
    // A session that follows one which ended with no notes at all (Junto or
    // the operator ended it without an agent turn, or its id just changed) is
    // told so, with the one reference there is: the previous transcript.
    const endedBy = previous?.endedBy;
    const previousWithoutNotes =
      previous !== undefined &&
      previous.endedAt !== undefined &&
      previous.offboardedAt === undefined
        ? {
            note: PREVIOUS_WITHOUT_NOTES_FRAMING,
            session_id: previous.sessionId,
            harness: previous.harness,
            ended_at: isoAt(previous.endedAt),
            ended_because: previous.endReason,
            // Who ended it, when Junto did so itself: the operator, an
            // overseer, or the idle rule. Absent when nothing recorded it.
            ...(endedBy === undefined ? {} : { ended_by: endedBy }),
            ...transcriptOf(previous),
            ...windDownOf(previous),
          }
        : undefined;
    // The last session: gist and notes only when it wrote them, and who
    // closed it when it did not. The handoff already carries its notes in
    // full, so the entry points there instead of printing them twice.
    const last = previous === undefined
      ? null
      : {
          session_id: previous.sessionId,
          harness: previous.harness,
          started_at: isoAt(previous.startedAt),
          ...(previous.endedAt === undefined ? {} : { ended_at: isoAt(previous.endedAt), ended_because: previous.endReason }),
          ...(previous.offboardedAt === undefined
            ? { closed: closedWithoutNotes(previous) }
            : {
                ...(previous.gist === undefined ? {} : { gist: previous.gist }),
                ...(handoffNotes !== undefined
                  ? { notes_in: "handoff" as const }
                  : (() => {
                      const notes = notesOf.get(previous.sessionId)?.notes;
                      return notes === undefined ? {} : { notes };
                    })()),
              }),
          ...transcriptOf(previous),
          ...(previous.drain === undefined ? {} : { wind_down: describeSessionDrain(previous.drain) }),
        };
    const sessions = {
      note: PAST_SESSIONS_FRAMING,
      current: current
        ? {
            session_id: current.sessionId,
            harness: current.harness,
            transcript_path: mine?.transcriptPath ?? null,
            offboarded: mine?.offboardedAt !== undefined,
          }
        : null,
      last,
      // The sessions before the last one, counted, never listed.
      earlier: Math.max(0, past.length - 1),
    };
    return {
      sessions,
      ...(handoff ? { handoff } : {}),
      ...(previousWithoutNotes ? { previousWithoutNotes } : {}),
      ...(previous === undefined ? {} : { previousStartedAt: previous.startedAt }),
    };
  });

const dispatchOp = (
  op: WorkOp,
  args: unknown,
  caller: WorkCaller,
  version: string,
): Effect.Effect<
  unknown,
  WorkErrorBody,
  WorkService | PausePlane
> =>
  Effect.gen(function* () {
    const work = yield* WorkService;
    const pausePlane = yield* PausePlane;

    if (op === "ping") {
      return {
        pong: true,
        protocol_version: WORK_PROTOCOL_VERSION,
        version,
      };
    }

    if (op === "doctor") {
      return {
        ok: true,
        protocol_version: WORK_PROTOCOL_VERSION,
        version,
        socket: "up",
        harnesses: yield* Effect.promise(() => probeManagedHarnessInstalls()),
      };
    }

    const read = yield* work.readTopology(caller.canvasName).pipe(
      Effect.mapError(
        (e): WorkErrorBody => ({
          type: "StaleNodeRef",
          message: e.message,
          details: {
            retryable: false,
            next_step: "the canvas is not open; ask the operator to open it in Junto",
          },
        }),
      ),
    );
    const board = read.canvas;
    const callerErr = ensureCaller(board, caller.nodeId);
    if (callerErr) return yield* Effect.fail(callerErr);

    const mailboxOf = (nodeId: string) =>
      work.readMailbox(caller.canvasName, nodeId).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
    // What this seat sent into every other mailbox, newest first.
    const sentMailOf = (sender: ActorRef) =>
      Effect.gen(function* () {
        const sent: Array<Message & { readonly toNodeId: string }> = [];
        for (const node of board.nodes.values()) {
          if (node.id === caller.nodeId) continue;
          for (const message of yield* mailboxOf(node.id)) {
            if (message.metadata?.fromSeat !== sender.seatId &&
                message.metadata?.fromSeat !== caller.nodeId) continue;
            sent.push({ ...message, toNodeId: node.id });
          }
        }
        return sent.sort((a, b) => b.messageId.localeCompare(a.messageId));
      });

    // The pause plane is the factory's safety switch: on a paused canvas
    // (canvases are born paused) a seat may read but never act. Reads stay
    // open so a paused agent can still see the board.
    const paused = !pausePlane.stateFor(caller.canvasName).playing;
    if (MUTATING_OPS.has(op)) {
      if (paused) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "Paused",
          message: `agent "${caller.nodeId}" is on a paused canvas and cannot act`,
          details: {
            caller: caller.nodeId,
            retryable: true,
            next_step: "wait for the operator to play the canvas",
          },
        });
      }
    }

    if (op === "capabilities") {
      const self = findNode(board, caller.nodeId)!;
      const connected = connectedCapabilities(board, caller.nodeId);
      const overseer = self.kind === "agent" && self.overseer === true;
      return {
        node: summarizeNode(self),
        harnesses: yield* Effect.promise(() => probeManagedHarnessInstalls()),
        // Additive: derived factory role of the credentialed seat.
        role: factoryRoleOfNode(self),
        tools: overseer
          ? [PREAMBLE_TOOL, ...SIGNAL_TOOLS, OVERSEER_TOOL]
          : [PREAMBLE_TOOL, ...SIGNAL_TOOLS],
        overseer: { enabled: overseer, affectedByPause: false },
        protocol_version: WORK_PROTOCOL_VERSION,
        connected,
        co_members: regionVisibility(board, caller.nodeId),
        // Pause surface: a paused seat must distinguish pause from a broken
        // grant. Reads stay open; mutating ops still refuse with Paused.
        paused,
        ...(paused
          ? { next_step: "wait for the operator to play the canvas" }
          : {}),
      };
    }

    if (op === "onboard") {
      const decodedOnboard = decodeArgs(OnboardArgs, args ?? {});
      if (Result.isFailure(decodedOnboard)) return yield* Effect.fail(decodedOnboard.failure);
      // An empty struct admits any object, so the no-argument rule is checked here.
      if (Object.keys((args ?? {}) as object).length > 0) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "onboard takes no arguments: a seat onboards itself",
          details: { path: "args", retryable: false, hint: "junto schema show onboard" },
        });
      }
      const self = findNode(board, caller.nodeId)!;
      const seat = yield* seatConfigurationOf(self);
      const history = yield* pastSessionsOf(self);
      const region = containingRegion(board, caller.nodeId);
      const connected = connectedCapabilities(board, caller.nodeId);
      const reach = resourcesInReach(board, asNodeId(caller.nodeId)).flatMap((node) =>
        isResourceKind(node.kind) ? [{ id: node.id as string, kind: node.kind }] : [],
      );
      const overseer = self.kind === "agent" && self.overseer === true;
      const guidance = onboardGuidanceFor(seat);
      const tools = toolsBeyondGuidance(
        overseer ? [PREAMBLE_TOOL, ...SIGNAL_TOOLS, OVERSEER_TOOL] : [PREAMBLE_TOOL, ...SIGNAL_TOOLS],
        guidance,
      );
      const { briefing, references } = yield* onboardReferenceFields({ canvasName: caller.canvasName, nodeId: caller.nodeId });
      // Most stable first: what changes only when the operator edits it, then
      // who and what this seat is, then what changed since its last session,
      // then the note its last session left.
      return {
        // The few lines every seat needs. Nothing is sent to a harness at
        // session start, so this is where a seat learns what Junto asks of it.
        guidance,
        // The operator's app briefing, or why it could not be read.
        ...(briefing === undefined ? {} : { briefing }),
        // The innermost region, with every region's instruction outer to inner.
        region: region ?? null,
        // The seat as the operator configured it: name, harness and launch
        // dials, look, and the operator-authored soul and standing
        // instructions. Onboard is their only carrier, the same for every
        // harness, read live so an edit shows on the next onboard.
        ...(seat ? { seat } : {}),
        nodeRef: formatNodeRef({
          canvasName: caller.canvasName,
          nodeId: caller.nodeId,
        }),
        node: summarizeNode(self),
        // Additive: derived factory role of the credentialed seat.
        role: factoryRoleOfNode(self),
        overseer: { enabled: overseer, affectedByPause: false },
        protocol_version: WORK_PROTOCOL_VERSION,
        // Pause surface: a paused seat must distinguish pause from a broken
        // grant. Reads stay open; mutating ops still refuse with Paused.
        paused,
        ...(paused
          ? { next_step: "wait for the operator to play the canvas" }
          : {}),
        connected: connected.map((c) => ({
          id: c.id,
          kind: c.kind,
          title: c.title,
          name: c.name,
          regions: c.regions,
          role: c.role,
          grants: c.grants,
          ...(boardBriefing(board, c.id) ?? {}),
        })),
        // What each connection allows, compiled from the ports held over it:
        // a seat is never taught a command its edge does not grant.
        commands: compileConnectionInstructions(
          connected.map((c) => ({ id: c.id, kind: c.kind, ports: c.grants })),
        ),
        // The resources in this seat's region reach, by kind, each with every
        // command its kind allows: reach admits, with no edge and no port.
        reach: compileReach(reach),
        ...(references === undefined ? {} : { references }),
        // Operator-pinned precedent from the seat's own region stack. Region
        // rulings ride the Tasks gate: a tasks-off build names none.
        ...(TASKS_ENABLED
          ? { rulings: rulingsForRegionStack(board, caller.nodeId) }
          : {}),
        // The other seats in this seat's regions, by name.
        co_members: coMembersByRegion(regionVisibility(board, caller.nodeId)),
        // The seat tools the guidance does not already teach.
        tools,
        // Since your last session: replies owed and awaited, open signals,
        // silent answers since the previous session started, unread mail.
        // A read that fails or dies is logged and marked unavailable, and
        // onboard stands without it.
        since: yield* onboardSinceSection(
          readSeatSince(board, caller.canvasName, caller.nodeId, history?.previousStartedAt).pipe(Effect.map(renderSince)),
          `${caller.canvasName}/${caller.nodeId}`,
        ),
        // This seat's last session and a count of the earlier ones: history
        // for continuity, never work to resume.
        ...(history ? { sessions: history.sessions } : {}),
        // Last, the note the previous session left for this one, when it
        // continued rather than rested.
        ...(history?.handoff ? { handoff: history.handoff } : {}),
        // Or, when the previous session left nothing: say so, and where its
        // transcript is.
        ...(history?.previousWithoutNotes
          ? { previous_session_without_notes: history.previousWithoutNotes }
          : {}),
      };
    }

    // The same projection as onboard's since, capped the same way, or
    // uncapped with all.
    if (op === "since") {
      const decodedSince = decodeArgs(SinceArgs, args ?? {});
      if (Result.isFailure(decodedSince)) return yield* Effect.fail(decodedSince.failure);
      const history = yield* pastSessionsOf(findNode(board, caller.nodeId)!);
      const perSection = decodedSince.success.all === true ? Number.POSITIVE_INFINITY : SINCE_PER_SECTION;
      return renderSince(
        yield* readSeatSince(board, caller.canvasName, caller.nodeId, history?.previousStartedAt, perSection).pipe(
          Effect.mapError((): WorkErrorBody => ({
            type: "RuntimeDown",
            message: "since your last session could not be read",
            details: { retryable: true },
          })),
        ),
      );
    }

    if (op === "offboard") {
      const decoded = decodeArgs(OffboardArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const notes = decoded.success.notes.trim();
      const gist = gistOfNotes(notes);
      if (!gist) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "notes must say what happened in this session",
          details: {
            path: "args.notes",
            retryable: false,
            hint: "start with one line that sums the session up, then what is relevant and why it matters",
          },
        });
      }
      if (notes.length > SEAT_SESSION_NOTES_MAX_CHARS) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `notes must be at most ${SEAT_SESSION_NOTES_MAX_CHARS} characters`,
          details: { path: "args.notes", retryable: false, hint: "keep what the next session needs; link files instead of pasting them" },
        });
      }
      const continuation = decoded.success.continuation?.trim();
      if (continuation !== undefined && !gistOfNotes(continuation)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "the continuation must tell the next session what to pick up and why",
          details: {
            path: "args.continuation",
            retryable: false,
            hint: "or leave out --continue to close this session and let the seat rest",
          },
        });
      }
      if (continuation !== undefined && continuation.length > SEAT_SESSION_CONTINUATION_MAX_CHARS) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `the continuation must be at most ${SEAT_SESSION_CONTINUATION_MAX_CHARS} characters`,
          details: { path: "args.continuation", retryable: false, hint: "say what to pick up and why; the notes carry the rest" },
        });
      }
      const mode = continuation === undefined ? "rest" : "continue";
      const store = yield* Effect.serviceOption(SeatSessionRepository);
      if (Option.isNone(store)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "RuntimeDown",
          message: "seat sessions are unavailable in this Junto runtime",
          details: { retryable: false },
        });
      }
      // Seat identity is the credentialed caller, never an argument: a seat
      // writes only its own current session's notes.
      const self = findNode(board, caller.nodeId)!;
      // Not known yet: look once, now, before refusing.
      const current = (yield* currentSeatSession(self, store.value)) ?? (yield* lookForSeatSession(self));
      if (current === undefined) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InvalidTransition",
          message: "Junto does not know this session's id yet",
          details: {
            caller: caller.nodeId,
            retryable: true,
            next_step: "finish your current turn, then run junto offboard again",
          },
        });
      }
      const session = yield* store.value.offboard({ ...current, notes, gist, ...(continuation ? { continuation } : {}) }).pipe(
        Effect.mapError((error): WorkErrorBody => ({
          type: "InternalError",
          message: error.message,
          details: { retryable: true },
        })),
      );
      // The session is closed from the transport, once this reply has been
      // written back (see the offboard branch after dispatch): the notes are
      // in junto.db by now, and that is the only thing the close waits for.
      return {
        session_id: session.sessionId,
        gist: session.gist ?? gist,
        mode,
        disposition: "applied" as const,
        next_step:
          mode === "continue"
            ? "your notes and continuation are saved and your seat has moved on to a fresh session, which reads your continuation first; this session may finish what it is saying, but it receives nothing more and its junto commands are refused"
            : "your notes are saved and your seat has moved on: it rests until its next wake, which starts a fresh session that reads your notes; this session may finish what it is saying, but it receives nothing more and its junto commands are refused",
      };
    }

    if (op === "preamble") {
      const decoded = decodeArgs(PreambleArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const text = normalizePreambleText(decoded.success.text);
      if (!text) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: "text must be non-empty",
          details: { path: "args.text", retryable: false },
        });
      }
      if (text.length > PREAMBLE_MAX_TEXT_LENGTH) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `text must be at most ${PREAMBLE_MAX_TEXT_LENGTH} characters`,
          details: { path: "args.text", retryable: false },
        });
      }
      const event: PreambleEvent = {
        preambleId: ulid(),
        canvasName: caller.canvasName,
        nodeId: caller.nodeId,
        text,
        expiresAt: Date.now() + PREAMBLE_TTL_MS,
      };
      noteSeatPreamble(caller.canvasName, caller.nodeId, { text, expiresAt: event.expiresAt });
      return { ...event, disposition: "applied" as const };
    }

    if (op === "verdict.post") {
      const decoded = decodeArgs(VerdictPostArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const reviewer = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(reviewer)) return yield* Effect.fail(reviewer.failure);
      // The task sink is context, not the author. WorkService resolves the
      // author and revalidates the directed reviews edge to that stable seat.
      const { target, ...input } = decoded.success;
      const result = yield* work.workVerdictPost(
        caller.canvasName, target, input, reviewer.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "rulings") {
      // Region rulings ride the Tasks gate: a tasks-off build has none to read.
      if (!TASKS_ENABLED) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ScopeError",
          message: "region rulings are disabled in this Junto build",
          details: {
            caller: caller.nodeId,
            hint: "this product surface is turned off in this build",
            next_step: "stop reading rulings; this build carries no region rules",
            retryable: false,
            missing: "feature enabled in this build",
            reason: op,
          },
        });
      }
      const decoded = decodeArgs(RulingsArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      // No target: the seat's own region stack — ambient law it already lives
      // under, so no edge is involved. A named task node is admitted by reach.
      const target = decoded.success.target;
      if (target !== undefined) {
        const gate = requireTarget(board, caller.nodeId, target, op);
        if ("type" in gate) return yield* Effect.fail(gate);
      }
      return yield* work
        .workRulingsList(caller.canvasName, target ?? caller.nodeId)
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              mapWorkCode(error.code, error.message, error.details),
            ),
          ),
        );
    }

    if (op === "task.check") {
      const decoded = decodeArgs(TasksCheckArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      const task = yield* work.readTask(caller.canvasName, decoded.success.target, decoded.success.task).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      if (
        task?.claimedBy !== undefined &&
        task.claimedBy !== actor.success.seatId
      ) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ClaimConflict",
          message:
            `task "${decoded.success.task}" is claimed by another seat; only the claiming seat runs its checks`,
          details: {
            holder: task.claimedBy,
            caller: actor.success.seatId,
            retryable: false,
            next_step:
              "only the claiming seat runs checks on this task",
          },
        });
      }
      const unadmitted = refuseUnadmittedSubmitted(task, gate.node, boardContractOf(read.canvas, gate.node?.id ?? ""));
      if (unadmitted !== undefined) {
        return yield* Effect.fail(unadmitted);
      }
      const result = yield* work.workTaskCheck(
        caller.canvasName,
        decoded.success.target,
        decoded.success.task,
        decoded.success.results,
        decoded.success.next,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "msg.list") {
      const decoded = decodeArgs(MsgListArgs, args);
      if (Result.isFailure(decoded)) {
        // The schema's own message can quote the input; this one never does.
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: MSG_LIST_ARGS_SHAPE,
          details: { path: "args", retryable: false },
        });
      }
      const targetId = resolveMailboxTarget(decoded.success.target, caller);
      const own = isOwnMailboxTarget(targetId, caller.nodeId);
      const filter = mailListFilterOf(decoded.success);
      if (Result.isFailure(filter)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: filter.failure.message,
          details: { path: filter.failure.path, expected: filter.failure.expected, retryable: false },
        });
      }
      const matches = mailListMatches(filter.success);
      const filtered = <M extends Message>(items: ReadonlyArray<M>): M[] => items.filter(matches);
      const threadId = filter.success.threadId;
      const threadField = threadId === undefined ? {} : { threadId };

      if (decoded.success.taskId) {
        const gate = requireTarget(board, caller.nodeId, targetId, op);
        if ("type" in gate) return yield* Effect.fail(gate);
        const node = gate.node!;
        const kind = nodeKind(node);
        const task = yield* work.readTask(caller.canvasName, targetId, decoded.success.taskId, kind === "task" ? "task" : "requests").pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
        if (!task) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `task "${decoded.success.taskId}" not found`,
            details: { target: decoded.success.taskId, retryable: false },
          });
        }
        return { target: targetId, taskId: task.id, items: filtered(task.history) };
      }

      if (own) {
        const ownNode = findNode(board, caller.nodeId);
        if (!ownNode) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `target "${caller.nodeId}" not found`,
            details: { target: caller.nodeId, retryable: false },
          });
        }
        const reader = resolveProcessBoundActorRef(read.actorRefs, caller);
        if (Result.isFailure(reader)) return yield* Effect.fail(reader.failure);
        // Listing marks read, so the filters apply first; a peek marks nothing.
        const items = filtered(yield* mailboxOf(caller.nodeId));
        const overlaid: Message[] = [];
        for (const item of items) {
          if (item.role !== "user" || decoded.success.peek === true) {
            overlaid.push(item);
            continue;
          }
          const existingReadAt = item.metadata?.readAt;
          if (typeof existingReadAt === "number" && Number.isFinite(existingReadAt)) {
            overlaid.push(item);
            continue;
          }
          const marked = yield* work.workMessageMarkRead(
            caller.canvasName,
            caller.nodeId,
            item.messageId,
            reader.success,
          );
          const mapped = fromWorkResult(marked);
          if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
          const readAtMs = Date.parse(mapped.success.value.readAt);
          overlaid.push({
            ...item,
            metadata: {
              ...(item.metadata ?? {}),
              ...(Number.isFinite(readAtMs) ? { readAt: readAtMs } : {}),
            },
          });
        }
        return {
          target: caller.nodeId,
          ...threadField,
          items: yield* Effect.forEach(
            sortMessagesNewestFirst(overlaid).map(withThread),
            withMailFiles(caller.canvasName, caller.nodeId),
          ),
          sent: filtered(yield* sentMailOf(reader.success)).map(withThread),
        };
      }

      const gate = requireTarget(board, caller.nodeId, targetId, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      return {
        target: targetId,
        ...threadField,
        items: sortMessagesNewestFirst(filtered(yield* mailboxOf(targetId))).map(withThread),
      };
    }

    if (op === "seat.wait") {
      const decoded = decodeArgs(SeatWaitArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const seat = yield* liveSeatObservation();
      return yield* seat.waitSeat(decoded.success, caller);
    }
    if (op === "seat.read") {
      const decoded = decodeArgs(SeatReadArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const seat = yield* liveSeatObservation();
      if (decoded.success.brief === true) return yield* seat.readPeers(caller);
      return yield* seat.readSeat(decoded.success, caller);
    }

    if (op === "msg.prompt") {
      const decoded = decodeArgs(MsgPromptArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const named = resolveMailTarget(board, caller.nodeId, decoded.success.target, op);
      if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
      const input = { ...decoded.success, target: named.success };
      const gate = requireTarget(board, caller.nodeId, input.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const text = input.text.trim();
      if (!text) return yield* Effect.fail<WorkErrorBody>({
        type: "InputError", message: "text must be non-empty", details: { path: "text", retryable: false },
      });
      const sender = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sender)) return yield* Effect.fail(sender.failure);
      const messageId = ulid();
      const message = makeUserMessage({
        messageId, text, contextId: caller.canvasName,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({
            ...mailSenderStamp(board, caller, sender.success),
            mailKind: "prompt",
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            ...(input.refs === undefined ? {} : { refs: input.refs }),
          }),
        },
      });
      const appended = fromWorkResult(yield* work.workMessageAppend(
        caller.canvasName, input.target, null, message, sender.success,
      ));
      if (Result.isFailure(appended)) return yield* Effect.fail(appended.failure);
      const delivery = yield* Effect.promise(() =>
        messageDelivery.deliver(caller.canvasName, input.target, messageId),
      );
      return { ...exposeWorkMutation(appended.success), messageId, recipient: recipientOf(board, input.target), delivery };
    }

    if (op === "msg.sent") {
      const decoded = decodeArgs(MsgSentArgs, args ?? {});
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const sender = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sender)) return yield* Effect.fail(sender.failure);
      const items: Array<Message & { readonly toNodeId: string; readonly to: SeatIdentity }> = [];
      for (const node of board.nodes.values()) {
        if (decoded.success.target !== undefined && node.id !== decoded.success.target) continue;
        for (const message of yield* work.readMailbox(caller.canvasName, node.id).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)))) {
          if (message.metadata?.fromSeat !== sender.success.seatId &&
              message.metadata?.fromSeat !== caller.nodeId) continue;
          items.push({ ...message, toNodeId: node.id, to: seatIdentity(board, node) });
        }
      }
      items.sort((a, b) => b.messageId.localeCompare(a.messageId));
      return { target: caller.nodeId, items };
    }

    if (op === "msg.send") {
      const asked = decodeArgs(MsgSendArgs, args);
      if (Result.isFailure(asked)) return yield* Effect.fail(asked.failure);
      // A target is a node id or the name of a seat this one is wired to.
      const named = resolveMailTarget(board, caller.nodeId, asked.success.target, op);
      if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
      const decoded = { success: { ...asked.success, target: named.success } };
      const recipient = recipientOf(board, named.success);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const typed = decoded.success.text.trim();
      if (!typed) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const sentBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
      // A task comment is a row in its task's one thread, whose id is the task's.
      const taskThread = decoded.success.taskId === undefined
        ? undefined
        : taskThreadAt(board, decoded.success.target, decoded.success.taskId);
      let threadId: string | undefined = taskThread?.threadId;
      if (decoded.success.threadId !== undefined) {
        const asked = mailIdArg("threadId", decoded.success.threadId);
        if (Result.isFailure(asked)) return yield* Effect.fail(asked.failure);
        const askedThread = asked.success;
        if (decoded.success.taskId !== undefined && askedThread !== taskThread?.threadId) {
          return yield* Effect.fail({
            type: "InputError" as const,
            message: taskThread === undefined
              ? `task "${decoded.success.taskId}" has no thread: it is not a task on a task node, or its id is not a ULID`
              : `a comment on task "${decoded.success.taskId}" is in its thread "${taskThread.threadId}"`,
            details: { path: "threadId", retryable: false, next_step: "drop threadId: a task comment joins its task's thread" },
          });
        }
      }
      // Each @name becomes its mention link: a seat in reach of the task, or wired to this one (03).
      const linked = linkSeatMentions(board, caller.canvasName, caller.nodeId, typed, taskThread === undefined
        ? mailMentionCandidates(board, caller.nodeId)
        : resourceMentionCandidates(board, taskThread.subject.nodeId));
      if (Result.isFailure(linked)) return yield* Effect.fail(linked.failure);
      const text = linked.success;
      // A comment on a 0.10 task posts on the one comment path (03).
      if (taskThread !== undefined && taskThread.subject.kind === "task") {
        const posted = yield* postSubjectComment(
          {
            subject: { kind: "task", nodeId: taskThread.subject.nodeId, taskId: taskThread.subject.taskId },
            text,
            actor: { kind: "seat", seatId: sentBy.success.seatId, nodeId: asNodeId(caller.nodeId) },
            opId: OpId.make(ulid()),
          },
          { canvas: board, canvasName: caller.canvasName, people: yield* subjectPeopleAt(board, caller.canvasName, taskThread.subject) },
        );
        return { ...posted, recipient };
      }
      if (decoded.success.threadId !== undefined && decoded.success.taskId === undefined) {
        const askedThread = decoded.success.threadId.trim();
        // Only a thread this seat can read: its own mailbox, or mail it sent.
        // An id inside a thread stands for that thread.
        const readable = [...(yield* mailboxOf(caller.nodeId)), ...(yield* sentMailOf(sentBy.success))];
        const named = readable.find((item) => item.messageId === askedThread);
        threadId = named !== undefined
          ? mailThreadOf(named)
          : readable.some((item) => mailThreadOf(item) === askedThread) ? askedThread : undefined;
        if (threadId === undefined) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `threadId "${askedThread}" names no mail this seat can read`,
            details: {
              path: "threadId",
              target: askedThread,
              retryable: false,
              next_step: "run junto msg list to see this seat's mail and the threadId each one carries",
            },
          });
        }
      }
      // Durable body first. The transport adds the authenticated sender
      // envelope; storing it in the body would duplicate it on a retry.
      const messageId = ulid();
      const contextId = caller.canvasName;
      const message: Message = makeUserMessage({
        messageId,
        text,
        contextId,
        ...(decoded.success.taskId ? { taskId: decoded.success.taskId } : {}),
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({
            ...mailSenderStamp(board, caller, sentBy.success),
            mailKind: "notice",
            ...(decoded.success.subject === undefined ? {} : { subject: decoded.success.subject }),
            ...(decoded.success.refs === undefined ? {} : { refs: decoded.success.refs }),
          }),
          ...(threadId === undefined ? {} : { threadId }),
        },
      });
      const result = yield* work.workMessageAppend(
        caller.canvasName,
        decoded.success.target,
        decoded.success.taskId ?? null,
        message,
        sentBy.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      // A comment on a task from before item ids: the task's own channel, no thread.
      if (decoded.success.taskId !== undefined) {
        return { ...exposeWorkMutation(mapped.success), messageId, recipient };
      }
      const delivery = yield* Effect.promise(() =>
        messageDelivery.deliver(caller.canvasName, decoded.success.target, messageId),
      );
      return { ...exposeWorkMutation(mapped.success), messageId, threadId: threadId ?? messageId, recipient, delivery };
    }

    if (op === "msg.read") {
      const decoded = decodeArgs(MsgReadArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const targetId = resolveMailboxTarget(decoded.success.target, caller);
      // Own mailbox only — the seat credential is the authority (not edge OptIn ports).
      if (targetId !== caller.nodeId) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "msg.read only applies to this seat's own mailbox",
          details: {
            caller: caller.nodeId,
            target: targetId,
            next_step: `retry with target "${caller.nodeId}" (your own node) and the same messageId`,
            retryable: false,
          },
        });
      }
      const own = findNode(board, caller.nodeId);
      if (!own) {
        return yield* Effect.fail({
          type: "UnknownTarget" as const,
          message: `target "${caller.nodeId}" not found`,
          details: { target: caller.nodeId, retryable: false },
        });
      }
      const reader = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(reader)) return yield* Effect.fail(reader.failure);
      const message = yield* work.readMailMessage(caller.canvasName, caller.nodeId, decoded.success.messageId.trim()).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      const result = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        decoded.success.messageId.trim(),
        reader.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return {
        ...exposeWorkMutation(mapped.success),
        message: message === undefined ? message : yield* withMailFiles(caller.canvasName, caller.nodeId)(withThread(message)),
      };
    }

    if (op === "msg.react") {
      const decoded = decodeArgs(MsgReactArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const targetId = resolveMailboxTarget(decoded.success.target, caller);
      if (targetId !== caller.nodeId) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "msg.react only applies to this seat's own mailbox",
          details: {
            caller: caller.nodeId,
            target: targetId,
            next_step: `retry with target "${caller.nodeId}" (your own node) and the same messageId`,
            retryable: false,
          },
        });
      }
      const own = findNode(board, caller.nodeId);
      if (!own) {
        return yield* Effect.fail({
          type: "UnknownTarget" as const,
          message: `target "${caller.nodeId}" not found`,
          details: { target: caller.nodeId, retryable: false },
        });
      }
      const reactor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(reactor)) return yield* Effect.fail(reactor.failure);
      const result = yield* work.workMessageReact(
        caller.canvasName,
        caller.nodeId,
        decoded.success.messageId.trim(),
        decoded.success.reaction ?? "ack",
        reactor.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "msg.reply") {
      const asked = decodeArgs(MsgReplyArgs, args);
      if (Result.isFailure(asked)) return yield* Effect.fail(asked.failure);
      // The operator is no node: a reply to them is admitted by the mail it
      // answers, below, never by an edge.
      const toOperator = asked.success.target.trim() === "operator";
      let target = asked.success.target;
      if (!toOperator) {
        const named = resolveMailTarget(board, caller.nodeId, target, op);
        if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
        target = named.success;
        const gate = requireTarget(board, caller.nodeId, target, op);
        if ("type" in gate) return yield* Effect.fail(gate);
      }
      const decoded = { success: { ...asked.success, target } };
      const typed = decoded.success.text.trim();
      if (!typed) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const parentId = mailIdArg("inReplyTo", decoded.success.inReplyTo);
      if (Result.isFailure(parentId)) return yield* Effect.fail(parentId.failure);
      const inReplyTo = parentId.success;
      const sentBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
      // The parent is mail to this seat, and its thread is the reply's.
      const parent = yield* work.readMailMessage(caller.canvasName, caller.nodeId, inReplyTo).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      if (parent === undefined) {
        return yield* Effect.fail({
          type: "UnknownTarget" as const,
          message: `inReplyTo "${inReplyTo}" is not mail in this seat's mailbox`,
          details: {
            path: "inReplyTo",
            target: inReplyTo,
            retryable: false,
            next_step: "run junto msg list to see this seat's mail",
          },
        });
      }
      // A stored row's fromSeat is its authenticated author, never what the
      // sender wrote: the repository stamps it from sentBy on every mailbox
      // row (admitMailboxMessage), and the exchange takes a row authored as
      // the operator only from the machine that edits the canvas
      // (writtenByItsAuthor, editorTakesFromNoPeer).
      if (toOperator && !(parent.metadata?.fromSeat === OPERATOR_SEAT_ID && parent.metadata?.senderName === "operator")) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "a seat writes to the operator only in reply to mail the operator sent it",
          details: {
            caller: caller.nodeId,
            target: "operator",
            retryable: false,
            next_step: "reply to the seat that sent this mail, or report with junto feedback",
          },
        });
      }
      // A reply in a subject thread posts to the subject, whoever wrote the
      // parent (03 section 4), on the one comment path. Reach to the
      // subject's node admits it there, as for any comment.
      const subject = threadSubjectOf(parent);
      if (subject !== undefined) {
        const kind = subjectNoticeKindOf(parent);
        const refused = kind !== undefined && !noticeTakesReply(kind)
          ? "a refusal notice takes no reply"
          : toOperator || target !== subject.nodeId
            ? `a reply in this thread posts to ${subjectLabel(subject)}, not to its sender`
            : undefined;
        if (refused !== undefined) {
          return yield* Effect.fail({
            type: "InputError" as const,
            message: refused,
            details: {
              path: "target",
              target: subject.nodeId,
              retryable: false,
              next_step: kind === "refusal"
                ? "follow the next step the refusal names"
                : `retry with target "${subject.nodeId}" and the same inReplyTo`,
            },
          });
        }
      }
      // Each @name becomes its mention link: a seat in reach of the subject, or wired to this one (03).
      const linked = linkSeatMentions(board, caller.canvasName, caller.nodeId, typed, subject === undefined
        ? mailMentionCandidates(board, caller.nodeId)
        : resourceMentionCandidates(board, subject.nodeId));
      if (Result.isFailure(linked)) return yield* Effect.fail(linked.failure);
      const text = linked.success;
      // Mark the parent mail read on own inbox first (idempotent).
      const marked = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        inReplyTo,
        sentBy.success,
      );
      const markedMapped = fromWorkResult(marked);
      if (Result.isFailure(markedMapped)) return yield* Effect.fail(markedMapped.failure);
      if (subject !== undefined) {
        const base = {
          text,
          actor: { kind: "seat" as const, seatId: sentBy.success.seatId, nodeId: asNodeId(caller.nodeId) },
          opId: OpId.make(ulid()),
          threadId: mailThreadOf(parent) as MailMessageId,
          inReplyTo: inReplyTo as MailMessageId,
        };
        const context = { canvas: board, canvasName: caller.canvasName, people: yield* subjectPeopleAt(board, caller.canvasName, subject) };
        const posted = yield* postSubjectComment(
          subject.kind === "task"
            ? { ...base, subject: { kind: "task", nodeId: subject.nodeId, taskId: subject.taskId } }
            : subject.kind === "artifact"
              ? { ...base, subject: { kind: "artifact", nodeId: subject.nodeId, artifactId: subject.artifactId } }
              : { ...base, subject: { kind: "page", nodeId: subject.nodeId } },
          context,
        );
        return {
          ...posted,
          inReplyTo,
          recipient: recipientOf(board, subject.nodeId),
          read: exposeWorkMutation(markedMapped.success),
        };
      }
      const thread = replyThreadMetadata(parent);
      const metadata = {
        factoryMail: true,
        ...mailExtensionMetadata({
          ...mailSenderStamp(board, caller, sentBy.success),
          mailKind: "notice",
          ...(decoded.success.refs === undefined ? {} : { refs: decoded.success.refs }),
        }),
        ...thread,
      };
      const result = toOperator
        ? yield* work.workOperatorReply(
            caller.canvasName,
            caller.nodeId,
            makeAgentMessage({
              messageId: ulid(),
              text,
              contextId: caller.canvasName,
              metadata: { ...metadata, toNodeId: "operator" },
            }),
            sentBy.success,
          )
        : yield* work.workMessageAppend(
            caller.canvasName,
            decoded.success.target,
            null,
            makeUserMessage({ messageId: ulid(), text, contextId: caller.canvasName, metadata }),
            sentBy.success,
          );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return {
        ...exposeWorkMutation(mapped.success),
        ...thread,
        recipient: toOperator ? OPERATOR_RECIPIENT : recipientOf(board, target),
        read: exposeWorkMutation(markedMapped.success),
      };
    }

    if (isOpOp(op)) {
      return yield* handleOpOp(op, args, { canvasName: caller.canvasName, nodeId: asNodeId(caller.nodeId), canvas: board });
    }

    if (op === "content.stage") {
      return yield* handleContentStage({ canvasName: caller.canvasName, nodeId: caller.nodeId }, args);
    }

    if (isAutomationReadOp(op)) {
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      return yield* handleAutomationRead(op, args, {
        canvas: board,
        canvasName: caller.canvasName,
        actor: { kind: "seat", seatId: actor.success.seatId, nodeId: asNodeId(caller.nodeId) },
      }, liveAutomationPorts);
    }

    if (isTaskControlOp(op)) {
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      return yield* handleTaskOp(op, args, {
        canvas: board,
        canvasName: caller.canvasName,
        actor: { kind: "seat", seatId: actor.success.seatId, nodeId: asNodeId(caller.nodeId) },
      }, liveTaskPorts);
    }

    if (isArtifactOp(op)) {
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      return yield* handleArtifactOp(op, args, {
        canvas: board,
        canvasName: caller.canvasName,
        actor: { kind: "seat", seatId: actor.success.seatId, nodeId: asNodeId(caller.nodeId) },
      }, liveArtifactPorts);
    }

    if (op === "references.list" || op === "references.read") {
      return yield* handleSeatReferences(op, args, { canvasName: caller.canvasName, nodeId: caller.nodeId });
    }

    if (op === "env.report") {
      const decoded = decodeArgs(EnvReportArgs, args ?? {});
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      // The seat's own resolution, from the same service the region screen
      // and the overseer doctor read. Names, origins and status only.
      const { regionEnvironmentService } = yield* Effect.promise(
        () => import("../region-env/live"),
      );
      const report = yield* Effect.promise(() =>
        regionEnvironmentService()
          .seatReportFor(read.canvas, caller.nodeId)
          .catch(() => undefined),
      );
      if (report === undefined) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "RuntimeDown",
          message: "this seat's region environment could not be read",
          details: { retryable: true },
        });
      }
      return report;
    }

    if (op === "logs.read") {
      const decoded = decodeArgs(LogsReadArgs, args ?? {});
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      // The caller is the credential's seat; `seat` in the query only narrows
      // inside what that seat may read: its own rows, seats it holds
      // terminal.read to, and rows that name no seat.
      const visible = new Set([
        caller.nodeId,
        ...connectedCapabilities(board, caller.nodeId)
          .filter((peer) => peer.grants.includes("terminal.read"))
          .map((peer) => peer.id),
      ]);
      return yield* readMachineLog(resolveJuntoHome(), logMachine(), decoded.success, seatLogScope(visible)).pipe(
        Effect.mapError((error): WorkErrorBody => ({
          type: "RuntimeDown",
          message: "this machine's log could not be read",
          details: { retryable: true, ...(error.code === undefined ? {} : { reason: error.code }) },
        })),
      );
    }

    if (op === "signal.raise" || op === "signal.clear" || op === "signal.list") {
      const signalsOption = yield* Effect.serviceOption(AgentSignalRepository);
      if (Option.isNone(signalsOption)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "RuntimeDown",
          message: "agent signals are unavailable in this Junto runtime",
          details: { retryable: false },
        });
      }
      const signals = signalsOption.value;
      const seat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
      const signalError = (error: AgentSignalRepositoryError): WorkErrorBody =>
        error._tag === "AgentSignalNotFound"
          ? {
              type: "UnknownTarget",
              message: error.message,
              details: {
                target: error.signalId,
                retryable: false,
                next_step: "run junto signal list to see this seat's open signals",
              },
            }
          : {
              type: "InternalError",
              message: error.message,
              details: { retryable: true },
            };

      if (op === "signal.list") {
        const decoded = decodeArgs(SignalListArgs, args ?? {});
        if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
        const since = decoded.success.since === undefined ? undefined : sinceCursorOf(decoded.success.since);
        if (since !== undefined && Result.isFailure(since)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: since.failure.message,
            details: { path: "args.since", expected: since.failure.expected, retryable: false },
          });
        }
        const listed = yield* signals.listSeat(seat, since?.success).pipe(Effect.mapError(signalError));
        // The capped listing says what it left out and how to page to it.
        const closedListed = listed.filter((signal) => signal.state !== "open").length;
        const closedTotal = since === undefined
          ? yield* signals.countClosedSeat(seat).pipe(Effect.mapError(signalError))
          : closedListed;
        // The operator's answer files, each placed where this seat opens it.
        const store = yield* Effect.serviceOption(ContentService);
        const filesOf = (signal: (typeof listed)[number]) => {
          const refs = signal.response?.attachments ?? [];
          if (refs.length === 0 || Option.isNone(store)) return Effect.succeed({});
          return operatorAttachmentLines(store.value, {
            canvasName: signal.canvasName,
            nodeId: signal.nodeId,
            messageId: `answer-${signal.signalId}`,
            refs,
          }).pipe(
            Effect.map((responseFiles) => ({ responseFiles })),
            Effect.orElseSucceed(() => ({})),
          );
        };
        const sorted = [...listed].sort(compareSignalListOrder);
        const files = yield* Effect.forEach(sorted, filesOf);
        const result: SignalListResult = {
          signals: sorted.map((signal, index) => {
            const level = levelOfSignal(signal.kind);
            return { ...signal, level, rank: rankOf(level), ...files[index] };
          }),
          open: listed.filter((signal) => signal.state === "open").length,
          ...(closedTotal > closedListed
            ? {
                closed_not_listed: closedTotal - closedListed,
                next_step: "junto signal list --since <ISO time or signal id> lists every closed signal from then on",
              }
            : {}),
        };
        return result;
      }

      if (op === "signal.clear") {
        const decoded = decodeArgs(SignalClearArgs, args ?? {});
        if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
        const withdrawn = yield* signals
          .withdraw(seat, decoded.success.signalId)
          .pipe(Effect.mapError(signalError));
        yield* Effect.forEach(withdrawn, releaseSignalAttachments, { discard: true });
        return { signals: withdrawn, disposition: "applied" as const };
      }

      const decoded = decodeArgs(SignalRaiseArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const text = normalizeSignalText(decoded.success.text);
      if (!text || text.length > AGENT_SIGNAL_MAX_TEXT_LENGTH) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `text must be one sentence of 1 to ${AGENT_SIGNAL_MAX_TEXT_LENGTH} characters`,
          details: {
            path: "args.text",
            retryable: false,
            hint: "put the longer explanation in --detail",
          },
        });
      }
      const detail = decoded.success.detail?.trim() || undefined;
      if (detail !== undefined && detail.length > AGENT_SIGNAL_MAX_DETAIL_LENGTH) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `detail must be at most ${AGENT_SIGNAL_MAX_DETAIL_LENGTH} characters`,
          details: { path: "args.detail", retryable: false },
        });
      }
      // Attached files: the seat uploaded them already. They are judged here,
      // whatever the CLI already checked, and held under the signal's id
      // before the signal itself is written.
      const signalId = ulid();
      let attachments: ReadonlyArray<AgentSignalAttachment> = [];
      if (decoded.success.attach !== undefined && decoded.success.attach.length > 0) {
        const contentOption = yield* Effect.serviceOption(ContentService);
        if (Option.isNone(contentOption)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "RuntimeDown",
            message: "attachments are unavailable in this Junto runtime",
            details: { retryable: false, next_step: "raise the signal without --attach" },
          });
        }
        // A task or an artifact is named as the seat typed it: resolved here
        // in its reach to the canonical ref, then judged with the rest.
        const named = yield* signalResourcesFor(board, caller.canvasName, asNodeId(caller.nodeId), decoded.success.attach);
        attachments = yield* claimSignalAttachments(
          contentOption.value,
          { ...seat, signalId },
          named.inputs,
          named.resources,
        ).pipe(
          Effect.mapError((refused): WorkErrorBody => ({
            type: "InputError",
            message: refused.message,
            details: { path: `args.${refused.path}`, retryable: false },
          })),
        );
      }
      // Pre-baked replies: each one line the operator can send as-is. The
      // wire already bounds their count and length; what is left to do here
      // is fold each to a single line and drop the ones that fold to none.
      const suggestions = decoded.success.suggest
        ?.map((suggestion) => normalizeSignalText(suggestion))
        .filter((suggestion): suggestion is string => suggestion.length > 0);
      const signal = yield* signals
        .raise({
          ...seat,
          signalId,
          kind: decoded.success.kind,
          text,
          ...(detail ? { detail } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
        })
        .pipe(
          Effect.mapError(signalError),
          // The signal was not written: nothing may keep holding its files.
          Effect.tapError(() =>
            attachments.length === 0
              ? Effect.void
              : Effect.serviceOption(ContentService).pipe(
                  Effect.flatMap((content) =>
                    Option.isNone(content)
                      ? Effect.void
                      : content.value.releaseOwner(signalAttachmentOwner({ ...seat, signalId })).pipe(Effect.ignore),
                  ),
                ),
          ),
        );
      return {
        signal,
        disposition: "applied" as const,
        next_step: SIGNAL_NEXT_STEP[signal.kind],
      };
    }

    // Exhaustiveness — Schema already gates ops
    void EmptyArgs;
    return yield* Effect.fail({
      type: "ProtocolError" as const,
      message: `unsupported op`,
      details: { retryable: false },
    });
  });

// ---------------------------------------------------------------------------
// Server

export interface WorkControlServer {
  readonly socketPath: string;
  readonly credentials: SeatCredentialRegistry;
  readonly workHome: string;
  /** Synchronously closes transport admission before any async teardown. */
  beginShutdown(): void;
  /** Bounded, retryable fixed-point drain of every admitted transport lifetime. */
  drainOnQuit(): Promise<WorkControlShutdownReceipt>;
  /** beginShutdown + drainOnQuit. */
  close(): Promise<WorkControlShutdownReceipt>;
}

export interface WorkControlRetainedCounts {
  readonly lineHandlers: number;
  readonly dispatches: number;
  readonly listenerClosures: number;
  readonly sockets: number;
  readonly socketPaths: number;
}

export interface WorkControlShutdownReceipt {
  readonly clean: boolean;
  readonly rounds: number;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly retainedCounts: WorkControlRetainedCounts;
  readonly retainedLabels: ReadonlyArray<string>;
}

export interface WorkControlServerOptions {
  readonly run: RunEffect;
  readonly version: string;
  readonly home?: string;
  readonly workHome?: string;
  /** Seat credential registry (defaults to the shared main-process registry). */
  readonly credentials?: SeatCredentialRegistry;
  /** Test seam; production uses the process-global main authoring authority. */
  readonly authoringGate?: MainAuthoringGate;
  /** Main-process delivery for the seat-local, ephemeral preamble surface. */
  readonly onPreamble?: (event: PreambleEvent) => void;
  /** Main-process delivery of a seat's raised or withdrawn agent signal. */
  readonly onAgentSignal?: (signal: AgentSignal) => void;
  /** Called only after live credential and seat delegation admission. */
  readonly onOverseer?: (
    request: OverseerRequest,
    caller: Pick<WorkCaller, "canvasName" | "nodeId">,
    signal: AbortSignal,
    live?: OverseerLiveExecutionConstraint,
  ) => Promise<OverseerResult>;
  /** Private controller protocol, reached only by the admitted native harness occupant. */
  readonly onOverseerLive?: (
    request: OverseerHostRequest,
    identity: OverseerHostIdentity,
    signal: AbortSignal,
  ) => Promise<OverseerHostAssignment>;
  readonly validateOverseerLive?: (
    request: OverseerRequest,
    identity: OverseerHostIdentity,
  ) => Promise<OverseerLiveExecutionConstraint>;
}

export interface WorkControlRuntime {
  /** Tests may lower, never raise, the graceful peer-close window. */
  readonly shutdownGraceMs?: number;
  /** Tests may lower, never raise, the complete transport drain deadline. */
  readonly shutdownDeadlineMs?: number;
  /**
   * Explicit accepted-peer ceiling. Unset means no application quota.
   * Frame, time, and shutdown limits still apply.
   */
  readonly maxActiveClients?: number;
}

export interface WorkControlReadinessPort {
  /**
   * True only while at least one main-owned listener still holds its lease,
   * owns the hardened socket entry, and admits new work.
   */
  readonly ready: () => boolean;
}

const liveWorkControlListeners = new Map<symbol, () => boolean>();

/**
 * Private main-process observation port. It carries no path, token, peer
 * identity, or dispatch authority, so Doctor cannot turn it into a client
 * admission bypass.
 */
export const workControlReadiness: WorkControlReadinessPort = Object.freeze({
  ready: () => {
    for (const observe of liveWorkControlListeners.values()) {
      try {
        if (observe()) return true;
      } catch {
        // A raced listener teardown is not ready.
      }
    }
    return false;
  },
});

const WORK_CONTROL_SHUTDOWN_GRACE_MS = 100;
const WORK_CONTROL_SHUTDOWN_DEADLINE_MS = 2_000;

/** A positive finite override, or no application client quota. */
const explicitClientCeiling = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
};

type WorkControlFlightKind =
  | "line-handler"
  | "dispatch"
  | "listener-close"
  | "socket-close";

interface WorkControlFlight {
  readonly id: number;
  readonly kind: WorkControlFlightKind;
  readonly label: string;
  promise: Promise<unknown>;
  status: "pending" | "fulfilled" | "rejected";
}

interface WorkControlSocket {
  readonly id: number;
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

const boundedRuntimeValue = (value: number | undefined, ceiling: number): number =>
  value === undefined || !Number.isFinite(value) || value <= 0
    ? ceiling
    : Math.min(Math.floor(value), ceiling);

interface WorkControlDeadline {
  readonly elapsed: Promise<void>;
  readonly hasElapsed: () => boolean;
  readonly cancel: () => void;
}

/** One process-timer deadline; never recomputed from the mutable wall clock. */
const startDeadline = (durationMs: number): WorkControlDeadline => {
  let elapsed = false;
  let resolveElapsed!: () => void;
  const elapsedPromise = new Promise<void>((resolve) => {
    resolveElapsed = resolve;
  });
  const timer = setTimeout(() => {
    elapsed = true;
    resolveElapsed();
  }, durationMs);
  return Object.freeze({
    elapsed: elapsedPromise,
    hasElapsed: () => elapsed,
    cancel: () => clearTimeout(timer),
  });
};

const waitBeforeDeadline = async (
  durationMs: number,
  deadline: WorkControlDeadline,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveWait) => {
        timer = setTimeout(resolveWait, durationMs);
      }),
      deadline.elapsed,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const yieldBeforeDeadline = async (deadline: WorkControlDeadline): Promise<void> => {
  let immediate: ReturnType<typeof setImmediate> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveTurn) => {
        immediate = setImmediate(resolveTurn);
      }),
      deadline.elapsed,
    ]);
  } finally {
    if (immediate !== undefined) clearImmediate(immediate);
  }
};

const allSettledBefore = async (
  promises: ReadonlyArray<Promise<unknown>>,
  deadline: WorkControlDeadline,
): Promise<
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly outcomes: ReadonlyArray<PromiseSettledResult<unknown>> }
> => {
  if (deadline.hasElapsed()) return { timedOut: true };
  return Promise.race([
    Promise.allSettled(promises).then((outcomes) => ({
      timedOut: false as const,
      outcomes,
    })),
    deadline.elapsed.then(() => ({ timedOut: true as const })),
  ]);
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });

const respond = (socket: Socket, envelope: WorkResponseEnvelope): void => {
  if (socket.destroyed) return;
  try {
    socket.write(encodeWorkFrame(envelope));
  } catch {
    // client gone
  }
};

/**
 * Write a reply and run `then` once it has left this process. `then` always
 * runs, exactly once: a client that is already gone, or a write that fails,
 * must not stop what follows the reply.
 */
export const respondThen = (socket: Pick<Socket, "destroyed" | "write">, envelope: WorkResponseEnvelope, then: () => void): void => {
  let ran = false;
  const once = (): void => {
    if (ran) return;
    ran = true;
    then();
  };
  if (socket.destroyed) {
    once();
    return;
  }
  try {
    socket.write(encodeWorkFrame(envelope), once);
  } catch {
    once();
  }
};

type WorkDispatchResult = Result.Result<unknown, WorkErrorBody>;

/** Every main-minted principal anchor participates in generation identity. */
const samePrincipalAnchors = (
  left: ProcessPrincipal | undefined,
  right: ProcessPrincipal,
): boolean =>
  left !== undefined &&
  left.agentKey === right.agentKey &&
  left.bindingId === right.bindingId &&
  left.canvasName === right.canvasName &&
  left.nodeId === right.nodeId;

const revokedProcessIdentity = (): WorkErrorBody => ({
  type: "AuthError",
  message: "process identity became stale while the work operation was running",
  details: {
    retryable: false,
    missing: "current process identity",
    next_step:
      "run the command again from the current Junto agent session",
  },
});

const overseerDispatchError = (error: unknown): WorkErrorBody => ({
  type: "InternalError",
  message: error instanceof Error ? error.message : String(error),
  details: { retryable: false },
});

/**
 * Drain the captured overseer Promise on interruption. Effect.tryPromise
 * aborts its signal without awaiting the underlying Promise, which would let
 * process revocation settle this dispatch while inner authoring-gate / native
 * cleanup is still in flight.
 */
const awaitOverseerPromise = (
  evaluate: (signal: AbortSignal) => Promise<OverseerResult>,
): Effect.Effect<OverseerResult, WorkErrorBody> =>
  Effect.callback<OverseerResult, WorkErrorBody>((resume, signal) => {
    let flight: Promise<OverseerResult>;
    try {
      flight = Promise.resolve(evaluate(signal));
    } catch (error) {
      resume(Effect.fail(overseerDispatchError(error)));
      return;
    }
    void flight.then(
      (value) => resume(Effect.succeed(value)),
      (error) => resume(Effect.fail(overseerDispatchError(error))),
    );
    // Keep the Effect pending until the captured Promise (including inner
    // lease / acquisition finalizers) actually settles. AbortSignal only
    // refuses later mutations; it cannot roll back work already in flight.
    return Effect.promise(() =>
      flight.then(
        () => undefined,
        () => undefined,
      ),
    );
  });

/**
 * Effect v4 calls its interruptible async constructor `callback`. The listener
 * re-reads this call's credential on every registry notification for its
 * generation: a reanchor may have moved the principal, while any other
 * generation's event cannot affect this call and is ignored. Termination is
 * terminal: once revoked, no later event revives the watcher.
 */
const watchSeatCredentialRevocation = (
  credentials: SeatCredentialRegistry,
  credential: string,
  principal: ProcessPrincipal,
  generationId: string,
): Effect.Effect<WorkDispatchResult> =>
  Effect.callback<WorkDispatchResult>((resume) => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    const stopListening = (): void => {
      active = false;
      const stop = unsubscribe;
      unsubscribe = undefined;
      try {
        stop?.();
      } catch {
        // Revocation is fail-closed; a test/alternate registry cannot keep a
        // completed watcher subscribed by throwing from its cleanup hook.
      }
    };

    const finishRevoked = (): void => {
      if (!active) return;
      stopListening();
      resume(Effect.succeed(Result.fail(revokedProcessIdentity())));
    };

    const verifyCurrentIdentity = (): void => {
      if (!active) return;
      let current: ProcessPrincipal | undefined;
      try {
        const found = credentials.lookup(credential);
        if (found.status !== "live" || found.generationId !== generationId) {
          finishRevoked();
          return;
        }
        current = found.principal;
      } catch {
        finishRevoked();
        return;
      }
      if (!samePrincipalAnchors(current, principal)) finishRevoked();
    };

    try {
      const stop = credentials.subscribe((event) => {
        if (event.generationId !== generationId) return;
        verifyCurrentIdentity();
      });
      if (active) {
        unsubscribe = stop;
      } else {
        // A custom registry may synchronously notify during subscribe.
        try {
          stop();
        } catch {
          // Already fail-closed above.
        }
      }
    } catch {
      finishRevoked();
    }

    // Close the synchronous admission-to-subscription window as well. This is
    // deliberately after subscribe so any concurrent lifecycle change either
    // notifies us or is visible in this lookup.
    verifyCurrentIdentity();

    // The race interrupts this watcher on operation success, failure, or outer
    // interruption. A revocation winner unsubscribes before resuming above.
    return Effect.sync(stopListening);
  });

export const startWorkControlServer = async (
  options: WorkControlServerOptions,
  runtime: WorkControlRuntime = {},
): Promise<WorkControlServer> => {
  const workHome = resolveWorkHome(options.home, options.workHome);
  prepareControlDirectory(workHome);

  const socketPath = workControlSocketPath(workHome);
  const credentials = options.credentials ?? getSeatCredentialRegistry();
  const authoringGate = options.authoringGate ?? mainAuthoringGate;

  const shutdownGraceMs = boundedRuntimeValue(
    runtime.shutdownGraceMs,
    WORK_CONTROL_SHUTDOWN_GRACE_MS,
  );
  const shutdownDeadlineMs = boundedRuntimeValue(
    runtime.shutdownDeadlineMs,
    WORK_CONTROL_SHUTDOWN_DEADLINE_MS,
  );
  const maxActiveClients = explicitClientCeiling(runtime.maxActiveClients);
  const readinessAuthority = Symbol("work-control-listener");
  let shuttingDown = false;
  let nextFlightId = 0;
  let nextSocketId = 0;
  let listenerCloseFlight: Promise<void> | undefined;
  let drainFlight: Promise<WorkControlShutdownReceipt> | undefined;
  const activeFlights = new Map<number, WorkControlFlight>();
  const shutdownJournal = new Map<number, WorkControlFlight>();
  const sockets = new Map<number, WorkControlSocket>();
  const admittedClients = new Set<Socket>();

  const retainFlight = <A>(
    kind: WorkControlFlightKind,
    label: string,
    promise: Promise<A>,
  ): Promise<A> => {
    const flight: WorkControlFlight = {
      id: ++nextFlightId,
      kind,
      label,
      promise,
      status: "pending",
    };
    activeFlights.set(flight.id, flight);
    if (shuttingDown) shutdownJournal.set(flight.id, flight);
    void promise.then(
      () => {
        flight.status = "fulfilled";
        activeFlights.delete(flight.id);
      },
      () => {
        flight.status = "rejected";
        activeFlights.delete(flight.id);
      },
    );
    return promise;
  };

  const retainOperation = <A>(
    kind: Extract<WorkControlFlightKind, "line-handler" | "dispatch">,
    label: string,
    operation: () => Promise<A>,
  ): Promise<A> => {
    // Publish a settlement token before invoking caller-controlled code. The
    // operation factory may synchronously re-enter shutdown, so the registry
    // must already contain this exact lifetime before that call is possible.
    let resolveStarted!: (value: A) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<A>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    void started.catch(() => undefined);
    const flight: WorkControlFlight = {
      id: ++nextFlightId,
      kind,
      label,
      promise: started,
      status: "pending",
    };
    activeFlights.set(flight.id, flight);
    if (shuttingDown) shutdownJournal.set(flight.id, flight);

    let promise: Promise<A>;
    try {
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }
    // Retain the actual task once caller code returns it; the pre-publication
    // token above mirrors only the otherwise-unavoidable synchronous gap.
    flight.promise = promise;
    void promise.then(resolveStarted, rejectStarted);
    void promise.then(
      () => {
        flight.status = "fulfilled";
        activeFlights.delete(flight.id);
      },
      () => {
        flight.status = "rejected";
        activeFlights.delete(flight.id);
      },
    );
    return promise;
  };

  const server: Server = createServer((socket) => {
    if (
      shuttingDown ||
      (maxActiveClients !== undefined && admittedClients.size >= maxActiveClients)
    ) {
      socket.end();
      return;
    }
    admittedClients.add(socket);
    let buffer = Buffer.alloc(0);
    let closed = false;

    const handleLine = async (line: string): Promise<void> => {
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        respond(
          socket,
          workErr("ProtocolError", "malformed JSON frame", {
            retryable: false,
            hint: "send one NDJSON object per line",
          }),
        );
        return;
      }

      const decoded = decodeWorkRequest(raw);
      if (Result.isFailure(decoded)) {
        respond(
          socket,
          workErr("ProtocolError", decoded.failure.message, {
            retryable: false,
            path: "request",
            hint: "request must be {token, op, args?}",
          }),
        );
        return;
      }

      const req = decoded.success;
      if (req.op === "overseer" && req.id !== undefined &&
        Buffer.byteLength(JSON.stringify(req.id), "utf8") > OVERSEER_MAX_CORRELATION_BYTES) {
        // Do not echo the oversized id into another oversized frame.
        respond(socket, workErr("InputError", "overseer correlation id exceeds its byte limit", {
          retryable: false, path: "id",
        }, req.op));
        return;
      }

      // The frame token is the seat generation credential; the socket file
      // permissions prove owner-local reach. Admission is one registry lookup.
      const admission = admitWorkIdentity({
        credentials,
        presentedToken: req.token,
      });
      if (!admission.ok) {
        respond(
          socket,
          workErr(
            "AuthError",
            admission.message,
            {
              retryable: admission.reason === "seat_suspended",
              next_step:
                admission.reason === "process_offboarded"
                  ? "finish what you are doing and stop; nothing more reaches this session and its junto calls are refused"
                  : admission.reason === "process_unbound"
                    ? "this process holds no live seat credential; only agents started from the canvas can call work ops — ask the operator to start you from an agent node"
                    : "reattach the seat on the canvas, then retry",
              missing: "seat credential",
            },
            req.op,
            req.id,
          ),
        );
        return;
      }

      try {
        // Live authority resolve + dispatch are one Effect and one retained
        // runtime fiber. Revocation wins the race and interrupts whichever
        // service await is live, rather than merely checking identity again.
        // The admitted seat, for the tool preamble told after a success.
        let admittedSeat: Pick<WorkCaller, "canvasName" | "nodeId"> | undefined;
        // The admitted seat's terminal binding, for the onboarding proof.
        let admittedBindingId: string | undefined;
        let sealedForOffboard = false;
        const liveAuthorityAndDispatch: Effect.Effect<
          WorkDispatchResult,
          never,
          WorkService | PausePlane
        > = Effect.gen(function* () {
          const liveDocsResult = yield* Effect.flatMap(
            WorkService,
            (work) => work.listTopologies(admission.principal.canvasName),
          ).pipe(Effect.result);
          if (Result.isFailure(liveDocsResult)) {
            return Result.fail({
              type: "StaleNodeRef",
              message: "live canvas authority is unavailable",
              details: {
                retryable: true,
                next_step: "retry shortly; if this persists, ask the operator to check that Junto is running with its canvases loaded",
              },
            });
          }

          const callerResolved = resolveCallerAcrossCanvases(
            liveDocsResult.success.map((canvas) => ({ canvasName: canvas.name, doc: canvas })),
            admission.principal,
          );
          if (!callerResolved.ok) {
            return Result.fail({
              type:
                callerResolved.code === "ambiguous"
                  ? "ScopeError"
                  : "StaleNodeRef",
              message: callerResolved.message,
              details: {
                retryable: false,
                next_step:
                  "your process does not match exactly one agent node; ask the operator to check the canvas",
              },
            });
          }

          // Managed seats bind their process by agent key, not binding id, so
          // the onboarding proof key comes from the resolved caller node's
          // terminal binding.
          const callerNode = callerResolved.caller.node;
          admittedBindingId =
            admission.principal.bindingId ??
            (callerNode.kind === "agent"
              ? callerNode.bindingId
              : undefined);
          // The offboard has arrived, from the seat's own process: from this
          // instant nothing more is typed into the session, the second half
          // of a delivery already in flight (its submit) included. Sealing
          // only once the notes were saved left that long for a carriage
          // return to land. A seat sealed already (a close in flight) is
          // left as it is.
          if (req.op === "offboard" && admittedBindingId !== undefined && !closingFence.sealed(admittedBindingId)) {
            closingFence.seal(admittedBindingId);
            sealedForOffboard = true;
          }
          const occupant = occupantKeyForPrincipal(
            admission.principal,
            `gen:${admission.generationId}`,
          );
          const caller: WorkCaller = {
            canvasName: callerResolved.caller.canvasName,
            nodeId: callerResolved.caller.nodeId,
            workHome,
            occupant,
            generation: admission.generationId,
          };
          admittedSeat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
          const nativeController = callerNode.kind === "agent" && isOverseerHarness(callerNode.harness);
          if (!LIVE_OVERSEER_ENABLED && (nativeController || req.op === "overseer.live")) {
            return Result.fail<WorkErrorBody>({
              type: "ScopeError", message: "Live conversation is disabled in this Junto build",
            });
          }
          const controllerIdentity = (): OverseerHostIdentity | undefined => {
            const node = callerResolved.caller.node;
            if (!nativeController || node.kind !== "agent") return undefined;
            // The caller is the seat its generation credential names. A
            // descendant holding the seat's credential is the seat.
            return {
              canvasName: caller.canvasName, nodeId: caller.nodeId,
              bindingId: node.bindingId, generationId: admission.generationId,
            };
          };
          if (req.op === "overseer.live") {
            const identity = controllerIdentity();
            if (identity === undefined) return Result.fail<WorkErrorBody>({
              type: "AuthError", message: "the Live controller protocol belongs to the native Overseer seat",
            });
            const decoded = decodeOverseerHostRequest(req.args);
            if (Result.isFailure(decoded)) return Result.fail<WorkErrorBody>({
              type: "InputError", message: decoded.failure.message,
            });
            if (options.onOverseerLive === undefined) return Result.fail<WorkErrorBody>({
              type: "RuntimeDown", message: "Live conversations are unavailable in this runtime",
            });
            return yield* Effect.tryPromise({
              try: (signal) => options.onOverseerLive!(decoded.success, identity, signal),
              catch: (error): WorkErrorBody => ({
                type: "RuntimeDown", message: error instanceof Error ? error.message : "Live controller connection failed",
              }),
            }).pipe(Effect.result);
          }
          // Administrative commands do not enter the ordinary factory
          // paused/blocked or edge-scoped dispatcher. Identity and delegation
          // remain mandatory, including on a configured Remote projection.
          if (req.op === "overseer") {
            const node = callerResolved.caller.node;
            if (node.kind !== "agent" || node.overseer !== true) {
              const operation = (req.args as { readonly operation?: unknown } | null | undefined)?.operation;
              // Seats read automations; only the operator and overseers write them (plan 07).
              if (typeof operation === "string" && isAutomationWriteOp(operation)) {
                return Result.fail<WorkErrorBody>({
                  type: "ScopeError",
                  message: "only the operator and overseers write automations; seats read them",
                  details: {
                    reason: "not_permitted",
                    retryable: false,
                    caller: caller.nodeId,
                    next_step: "junto automation show reads it; ask the operator or an overseer to change it",
                  },
                });
              }
              return Result.fail<WorkErrorBody>({
                type: "ScopeError",
                message: "only a human-enabled overseer seat may administer the canvas",
                details: { retryable: false, caller: caller.nodeId },
              });
            }
            if (Buffer.byteLength(JSON.stringify(req.args ?? null), "utf8") > OVERSEER_MAX_REQUEST_BYTES) {
              return Result.fail<WorkErrorBody>({
                type: "InputError", message: "overseer request exceeds the request byte limit",
                details: { retryable: false },
              });
            }
            const decoded = decodeOverseerRequest(req.args);
            if (Result.isFailure(decoded)) {
              return Result.fail<WorkErrorBody>({
                type: "InputError", message: decoded.failure.message,
                details: { retryable: false },
              });
            }
            const argumentsResult = decodeOverseerArgs(decoded.success.operation, decoded.success.args);
            if (Result.isFailure(argumentsResult)) {
              return Result.fail<WorkErrorBody>({
                type: "InputError", message: argumentsResult.failure.message,
                details: { retryable: false },
              });
            }
            const execute = options.onOverseer;
            if (execute === undefined) {
              return Result.fail<WorkErrorBody>({
                type: "RuntimeDown",
                message: "overseer administration is unavailable in this runtime",
                details: { retryable: false },
              });
            }
            let live: OverseerLiveExecutionConstraint | undefined;
            if (nativeController || decoded.success.live !== undefined) {
              if (!LIVE_OVERSEER_ENABLED) return Result.fail<WorkErrorBody>({
                type: "ScopeError", message: "Live conversation is disabled in this Junto build",
              });
              const identity = controllerIdentity();
              if (identity === undefined || options.validateOverseerLive === undefined ||
                (isOverseerMutation(decoded.success.operation) && decoded.success.live === undefined)) {
                return Result.fail<WorkErrorBody>({ type: "AuthError", message: "native Overseer mutations require a current correlated Live request" });
              }
              if (decoded.success.live !== undefined) {
                const validated = yield* Effect.tryPromise({
                  try: () => options.validateOverseerLive!(decoded.success, identity),
                  catch: (error): WorkErrorBody => ({ type: "AuthError", message: error instanceof Error ? error.message : "Live request is no longer current" }),
                }).pipe(Effect.result);
                if (Result.isFailure(validated)) return validated;
                live = validated.success;
              }
            }
            const result = yield* awaitOverseerPromise(
              (signal) =>
                {
                  live?.assertCurrent();
                  return execute(decoded.success, {
                  canvasName: caller.canvasName,
                  nodeId: caller.nodeId,
                  }, signal, live);
                },
            ).pipe(Effect.result);
            if (live?.settle !== undefined && Result.isSuccess(result)) {
              yield* Effect.tryPromise({
                try: () => live!.settle!(result.success as OverseerResult),
                catch: (error): WorkErrorBody => ({ type: "InternalError", message: error instanceof Error ? error.message : "Live receipt could not be recorded" }),
              }).pipe(Effect.result);
            }
            return result;
          }
          if (nativeController && !["ping", "doctor", "capabilities", "onboard", "since"].includes(req.op)) {
            return Result.fail<WorkErrorBody>({
              type: "AuthError", message: "native Overseer mutations must use correlated overseer tools",
            });
          }
          return yield* dispatchOp(
            req.op,
            req.args,
            caller,
            options.version,
          ).pipe(Effect.result);
        });

        const revocationWatcher = watchSeatCredentialRevocation(
          credentials,
          admission.credential,
          admission.principal,
          admission.generationId,
        );
        const run = () =>
          retainOperation(
            "dispatch",
            `dispatch:${req.op}`,
            () =>
              // Watcher first is deliberate: Effect starts race contestants in
              // argument order, so subscribe + initial resolve happen before
              // liveDocuments can execute or suspend.
              options.run(
                Effect.raceFirst(
                  revocationWatcher,
                  liveAuthorityAndDispatch,
                ),
              ),
          );
        const authoringLabel = mainAuthoringLabelForWorkOperation(req.op);
        // Both read and authorial operations retain their actual runtime
        // promise even if this socket goes away before the response is written.
        // The main authoring gate remains the mutation authority; this
        // transport registry additionally supplies native-loop finality.
        const outcome = await (authoringLabel === undefined ? run() : authoringGate.run(authoringLabel, run)).catch(
          (error: unknown) => {
            // The offboard never ran to an answer: the session goes on.
            if (sealedForOffboard) closingFence.release(admittedBindingId);
            throw error;
          },
        );

        if (Result.isFailure(outcome)) {
          const body = outcome.failure;
          // Refused: the session goes on, so it may be typed into again.
          if (sealedForOffboard) closingFence.release(admittedBindingId);
          respond(
            socket,
            workErr(body.type, body.message, body.details, req.op, req.id),
          );
          return;
        }
        // Onboarded means exactly this: `junto onboard` answered the seat's
        // own process. No other work-plane call counts.
        if (req.op === "onboard") injectionSupervisor.noteOnboarded(admittedBindingId);
        // The offboard is saved. The fence has been up since it arrived
        // (above); the close itself follows the reply (below).
        if (req.op === "offboard") {
          closingFence.seal(admittedBindingId);
          injectionSupervisor.noteOffboardSaved(admittedBindingId);
        }
        if (req.op === "preamble" && options.onPreamble) {
          const value = outcome.success as {
            readonly preambleId?: unknown;
            readonly canvasName?: unknown;
            readonly nodeId?: unknown;
            readonly text?: unknown;
            readonly expiresAt?: unknown;
          };
          if (
            typeof value.preambleId === "string" &&
            typeof value.canvasName === "string" &&
            typeof value.nodeId === "string" &&
            typeof value.text === "string" &&
            typeof value.expiresAt === "number"
          ) {
            options.onPreamble({
              preambleId: value.preambleId,
              canvasName: value.canvasName,
              nodeId: value.nodeId,
              text: value.text,
              expiresAt: value.expiresAt,
            });
          }
        }
        // Anything else the seat did through Junto is told as a short preamble.
        if (options.onPreamble && admittedSeat !== undefined) {
          const told = seatToolPreamble({
            preambleId: ulid(),
            canvasName: admittedSeat.canvasName,
            nodeId: admittedSeat.nodeId,
            op: req.op,
            now: Date.now(),
          });
          if (told !== undefined) options.onPreamble(told);
        }
        if (
          (req.op === "signal.raise" || req.op === "signal.clear") &&
          options.onAgentSignal
        ) {
          const value = outcome.success as {
            readonly signal?: AgentSignal;
            readonly signals?: ReadonlyArray<AgentSignal>;
          };
          for (const signal of value.signals ?? (value.signal ? [value.signal] : [])) {
            options.onAgentSignal(signal);
          }
        }
        if (req.op === "offboard" && admittedSeat !== undefined) {
          // The close cuts the turn in flight, the agent's own CLI call
          // included, so its answer is written out first.
          const seat = admittedSeat;
          const saved = outcome.success as { readonly session_id: string; readonly mode: OffboardMode };
          respondThen(socket, workOk(req.op, outcome.success, req.id), () =>
            announceSeatOffboard({
              seatId: seat.nodeId,
              canvasName: seat.canvasName,
              sessionId: saved.session_id,
              at: Date.now(),
              mode: saved.mode,
            }),
          );
        } else {
          respond(socket, workOk(req.op, outcome.success, req.id));
        }
      } catch (error) {
        if (error instanceof MainAuthoringRefused) {
          respond(
            socket,
            workErr(
              "RuntimeDown",
              error.message,
              {
                retryable: false,
                next_step: "Junto is shutting down; wait for it to come back, then retry",
              },
              req.op,
              req.id,
            ),
          );
          return;
        }
        respond(
          socket,
          workErr(
            "InternalError",
            error instanceof Error ? error.message : String(error),
            { retryable: false },
            req.op,
            req.id,
          ),
        );
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (closed || shuttingDown) {
        buffer = Buffer.alloc(0);
        if (!socket.destroyed) socket.end();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > WORK_MAX_FRAME_BYTES) {
        respond(
          socket,
          workErr("ProtocolError", `frame exceeds ${WORK_MAX_FRAME_BYTES} bytes`, {
            retryable: false,
          }),
        );
        buffer = Buffer.alloc(0);
        socket.destroy();
        return;
      }
      while (true) {
        if (shuttingDown) {
          buffer = Buffer.alloc(0);
          if (!socket.destroyed) socket.end();
          break;
        }
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) break;
        const lineBuf = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        const line = lineBuf.toString("utf8").replace(/\r$/, "").trim();
        if (line.length === 0) continue;
        const retained = retainOperation(
          "line-handler",
          "line-handler",
          () => handleLine(line),
        );
        void retained.catch(() => {
          if (!shuttingDown) {
            respond(
              socket,
              workErr("InternalError", "work control request failed", {
                retryable: false,
              }),
            );
          }
        });
      }
    });

    socket.on("error", () => {
      closed = true;
    });
    socket.on("close", () => {
      closed = true;
      admittedClients.delete(socket);
    });

    void WorkOpName;
  });

  server.on("connection", (socket: Socket) => {
    const id = ++nextSocketId;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolveSocketClosed) => {
      resolveClosed = resolveSocketClosed;
    });
    const record: WorkControlSocket = { id, socket, closed };
    sockets.set(id, record);
    void retainFlight("socket-close", "socket", closed);
    socket.once("close", () => {
      sockets.delete(id);
      resolveClosed();
    });
    if (shuttingDown && !socket.destroyed) socket.end();
  });

  const listenerLease = await acquireControlListenerLease(socketPath);
  try {
    await removeObservedSocket(listenerLease);
  } catch (error) {
    await releaseControlListenerLease(listenerLease);
    throw error;
  }

  let socketIdentity: ControlSocketPathIdentity | undefined;
  let socketPathCleanupBlocked = false;

  /** Exact bound inode still at the pathname — independent of a live kernel lease. */
  const pathMatchesCapturedIdentity = (): boolean => {
    if (socketIdentity === undefined) return false;
    try {
      const current = lstatSync(socketPath, { bigint: true });
      return (
        current.isSocket() &&
        !current.isSymbolicLink() &&
        current.dev === socketIdentity.dev &&
        current.ino === socketIdentity.ino &&
        current.birthtimeNs === socketIdentity.birthtimeNs &&
        current.uid === socketIdentity.uid
      );
    } catch {
      return false;
    }
  };

  const ownsSocketPath = (): boolean => {
    if (socketIdentity === undefined) return false;
    try {
      return controlSocketPathOwnedByLease(listenerLease, socketIdentity);
    } catch {
      return false;
    }
  };

  const unlinkOwnedSocket = (): void => {
    if (
      socketIdentity !== undefined &&
      controlListenerLeaseHeld(listenerLease)
    ) {
      removeOwnedControlSocketPath(listenerLease, socketIdentity);
      return;
    }
    if (pathMatchesCapturedIdentity()) {
      unlinkSync(socketPath);
    }
  };

  const closeListenerWithoutDeletingReplacement = async (): Promise<void> => {
    if (existsSync(socketPath) && !pathMatchesCapturedIdentity()) {
      // Node/libuv may unlink the originally-bound pathname during close even
      // when another process has replaced that directory entry. Node exposes
      // no identity-checked unlink/close primitive, so an observed replacement
      // makes listener close unsafe until that path leaves. Keep this check and
      // close call adjacent with no await or caller-controlled seam; scheduler
      // preemption between them is the irreducible Node pathname race.
      // Identity is lease-independent so a lost lease still allows close of
      // the exact inode we bound.
      socketPathCleanupBlocked = true;
      server.unref();
      throw new Error("refusing to close work listener over a replacement path");
    }
    await closeServer(server);
    try {
      unlinkOwnedSocket();
      socketPathCleanupBlocked = false;
    } finally {
      if (controlListenerLeaseHeld(listenerLease)) {
        await releaseControlListenerLease(listenerLease);
      }
    }
  };

  const ensureListenerClose = (): void => {
    if (
      (!server.listening && !controlListenerLeaseHeld(listenerLease)) ||
      listenerCloseFlight !== undefined
    ) return;
    const close = closeListenerWithoutDeletingReplacement();
    listenerCloseFlight = close;
    void retainFlight("listener-close", "listener", close);
    void close.then(
      () => {
        if (listenerCloseFlight === close) listenerCloseFlight = undefined;
      },
      () => {
        if (listenerCloseFlight === close) listenerCloseFlight = undefined;
      },
    );
  };

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      server.once("error", onError);
      server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
        server.off("error", onError);
        try {
          // Learn and harden the just-published pathname in the listen callback
          // itself: no promise turn or caller-controlled code may intervene.
          socketIdentity = captureControlSocketPathIdentity(listenerLease);
          chmodSync(socketPath, 0o600);
          const hardened = lstatSync(socketPath, { bigint: true });
          if (
            !hardened.isSocket() ||
            !controlSocketPathOwnedByLease(listenerLease, socketIdentity)
          ) {
            throw new Error(
              "work control socket identity changed during permission hardening",
            );
          }
          resolveListen();
        } catch (error) {
          rejectListen(error);
        }
      });
    });
  } catch (error) {
    await closeListenerWithoutDeletingReplacement().catch(() => undefined);
    throw error;
  }

  server.on("error", (error) => {
    console.error("[work-control] server error:", error);
  });

  const withdrawReadiness = (): void => {
    liveWorkControlListeners.delete(readinessAuthority);
  };
  server.once("close", withdrawReadiness);
  liveWorkControlListeners.set(
    readinessAuthority,
    () =>
      !shuttingDown &&
      server.listening &&
      controlListenerLeaseHeld(listenerLease) &&
      ownsSocketPath(),
  );

  const beginShutdown = (): void => {
    withdrawReadiness();
    if (shuttingDown) return;
    // This state flip is the cut line. It precedes every async close step and
    // is checked both at socket acceptance and at each NDJSON frame boundary.
    // Path unlink waits for listener close — early unlink opens a replacement race.
    shuttingDown = true;
    for (const flight of activeFlights.values()) {
      shutdownJournal.set(flight.id, flight);
    }
    ensureListenerClose();
    for (const { socket } of sockets.values()) {
      if (!socket.destroyed) socket.end();
    }
  };

  const retainedSnapshot = (): {
    readonly counts: WorkControlRetainedCounts;
    readonly labels: ReadonlyArray<string>;
  } => {
    const pending = [...shutdownJournal.values()].filter(
      (flight) => flight.status === "pending",
    );
    const countKind = (kind: WorkControlFlightKind): number =>
      pending.filter((flight) => flight.kind === kind).length;
    const listenerClosures = Math.max(
      countKind("listener-close"),
      server.listening || controlListenerLeaseHeld(listenerLease) ? 1 : 0,
    );
    const socketPaths = pathMatchesCapturedIdentity() || socketPathCleanupBlocked ? 1 : 0;
    const counts: WorkControlRetainedCounts = {
      lineHandlers: countKind("line-handler"),
      dispatches: countKind("dispatch"),
      listenerClosures,
      sockets: sockets.size,
      socketPaths,
    };
    const labels = new Set(
      pending
        .filter((flight) => flight.kind !== "socket-close")
        .map((flight) => flight.label),
    );
    if (sockets.size > 0) labels.add("socket");
    if (server.listening || controlListenerLeaseHeld(listenerLease)) labels.add("listener");
    if (socketPaths > 0) labels.add("socket-path");
    return { counts, labels: [...labels].sort() };
  };

  const runDrain = async (
    deadline: WorkControlDeadline,
  ): Promise<WorkControlShutdownReceipt> => {
    let rounds = 0;
    let settled = 0;
    let fulfilled = 0;
    let rejected = 0;

    const gracefulSocketFlights = [...sockets.values()].map((entry) => entry.closed);
    if (gracefulSocketFlights.length > 0) {
      const graceDeadline = startDeadline(
        Math.min(shutdownGraceMs, shutdownDeadlineMs),
      );
      try {
        await Promise.race([
          Promise.allSettled(gracefulSocketFlights),
          graceDeadline.elapsed,
          deadline.elapsed,
        ]);
      } finally {
        graceDeadline.cancel();
      }
    }
    for (const { socket } of sockets.values()) {
      if (!socket.destroyed) socket.destroy();
    }

    for (;;) {
      for (const { socket } of sockets.values()) {
        if (!socket.destroyed) socket.destroy();
      }
      if (!server.listening) {
        try {
          unlinkOwnedSocket();
        } catch {
          // Retained in the explicit deadline receipt below.
        }
      }

      const round = [...shutdownJournal.values()];
      if (round.length > 0) {
        const outcome = await allSettledBefore(
          round.map((flight) => flight.promise),
          deadline,
        );
        if (outcome.timedOut) break;
        rounds += 1;
        settled += outcome.outcomes.length;
        fulfilled += outcome.outcomes.filter((entry) => entry.status === "fulfilled").length;
        rejected += outcome.outcomes.filter((entry) => entry.status === "rejected").length;
        for (const flight of round) shutdownJournal.delete(flight.id);
        // A settling handler may publish its dispatch in a continuation.
        // Give that continuation one native turn before testing the fixed point.
        await yieldBeforeDeadline(deadline);
        continue;
      }

      const retained = retainedSnapshot();
      const clean = Object.values(retained.counts).every((count) => count === 0);
      if (clean) {
        return Object.freeze({
          clean: true,
          rounds,
          settled,
          fulfilled,
          rejected,
          retainedCounts: Object.freeze(retained.counts),
          retainedLabels: Object.freeze(retained.labels),
        });
      }
      if (deadline.hasElapsed()) break;
      await waitBeforeDeadline(5, deadline);
    }

    const settledAtDeadline = [...shutdownJournal.values()].filter(
      (flight) => flight.status !== "pending",
    );
    if (settledAtDeadline.length > 0) {
      const outcomes = await Promise.allSettled(
        settledAtDeadline.map((flight) => flight.promise),
      );
      rounds += 1;
      settled += outcomes.length;
      fulfilled += outcomes.filter((entry) => entry.status === "fulfilled").length;
      rejected += outcomes.filter((entry) => entry.status === "rejected").length;
      for (const flight of settledAtDeadline) shutdownJournal.delete(flight.id);
    }
    const retained = retainedSnapshot();
    const clean = Object.values(retained.counts).every((count) => count === 0);
    return Object.freeze({
      clean,
      rounds,
      settled,
      fulfilled,
      rejected,
      retainedCounts: Object.freeze(retained.counts),
      retainedLabels: Object.freeze(retained.labels),
    });
  };

  const drainOnQuit = (): Promise<WorkControlShutdownReceipt> => {
    if (drainFlight !== undefined) return drainFlight;

    let resolveDrain!: (receipt: WorkControlShutdownReceipt) => void;
    let rejectDrain!: (error: unknown) => void;
    const publishedDrain = new Promise<WorkControlShutdownReceipt>((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    // Publish before beginShutdown: Server.close(), socket.end(), and peer
    // listeners are callback seams that may synchronously re-enter this API.
    drainFlight = publishedDrain;
    void publishedDrain.then(
      () => {
        if (drainFlight === publishedDrain) drainFlight = undefined;
      },
      () => {
        if (drainFlight === publishedDrain) drainFlight = undefined;
      },
    );

    const deadline = startDeadline(shutdownDeadlineMs);
    try {
      beginShutdown();
      // An earlier bounded attempt may have refused listener close to preserve
      // a foreign replacement. Each explicit retry re-evaluates ownership.
      ensureListenerClose();
      void runDrain(deadline).then(
        (receipt) => {
          deadline.cancel();
          resolveDrain(receipt);
        },
        (error) => {
          deadline.cancel();
          rejectDrain(error);
        },
      );
    } catch (error) {
      deadline.cancel();
      rejectDrain(error);
    }
    return publishedDrain;
  };

  return {
    socketPath,
    credentials,
    workHome,
    beginShutdown,
    drainOnQuit,
    close: drainOnQuit,
  };
};
