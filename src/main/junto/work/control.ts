import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import { resolveJuntoHome } from "@shared/junto-home";
import { join } from "node:path";
import { Effect, Result, Option, Schema } from "effect";
import { ulid } from "ulid";
import type { Artifact, CanvasDoc, CanvasNode, Message, Part } from "@shared/canvas";
import { actorDeliverySurfaceOf, isManagedAgentNode } from "@shared/actor-surface";
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
import { mailExtensionMetadata, type MailSenderStamp } from "@shared/crew";
import { seatStateRuntime } from "../term/agent-state";
import { probeManagedHarnessInstalls } from "../term/templates/harness-install";
import type { BoardAuthor, Task } from "@shared/work-model";
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
  artifactPublishAuthority,
  extractProofStamp,
  globalStampRuntime,
} from "@shared/proof-stamps";
import {
  ArtifactPublishArgs,
  BoardCreateTopicArgs,
  BoardListArgs,
  BoardMarkReadArgs,
  BoardPostArgs,
  BoardTagsListArgs,
  PadPatchArgs,
  PadReadArgs,
  SheetReadArgs,
  ContentMaterializeArgs,
  ContentPathArgs,
  ContentStatArgs,
  EmptyArgs,
  MsgListArgs,
  MsgReactArgs,
  MsgReadArgs,
  MsgReplyArgs,
  MsgSendArgs,
  MsgPromptArgs,
  MsgSentArgs,
  SeatWaitArgs,
  SeatReadArgs,
  TaskWaitArgs,
  PreambleArgs,
  RelayTriggerArgs,
  SignalClearArgs,
  SignalListArgs,
  SignalRaiseArgs,
  RulingsArgs,
  TasksCheckArgs,
  TasksClaimArgs,
  TasksCreateArgs,
  TasksListArgs,
  TasksRulesArgs,
  TasksShowArgs,
  TasksUpdateArgs,
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
  workControlTokenPath,
  type WorkErrorDetails,
  type WorkErrorBody,
  type WorkErrorType,
  type WorkOpName as WorkOp,
  type WorkResponseEnvelope,
} from "@shared/work-control";
import { CanvasesService } from "../canvases";
import { ContentService } from "../content/service";
import {
  materializeContentObject,
  taskContentRef,
  taskItemsForNode,
} from "../content/agent-access";
import { contentObjectPath } from "../content/paths";
import { ContentStoreError } from "../content/store";
import { WorkService, type WorkOpResult } from "./service";
import { liveSeatObservation } from "./seat-observation-live";
import { messageDelivery } from "./message-delivery";
import { readMailExtension } from "@shared/crew";
import { manualSchedulerFire } from "../kernel/cycle";
import {
  AgentSignalRepository,
  type AgentSignalRepositoryError,
} from "../signals/repository";
import { PausePlane } from "../pause-plane";
import { seatPaused } from "@shared/pause";
import { RELAY_ENABLED, TASKS_ENABLED } from "@shared/features";

/** Ops that act on the factory — refused for paused seats. Reads stay open. */
const MUTATING_OPS: ReadonlySet<string> = new Set([
  "tasks.claim",
  "tasks.create",
  "tasks.update",
  "tasks.check",
  "content.materialize",
  "preamble",
  "msg.list",
  "msg.send",
  "msg.prompt",
  "verdict.post",
  "msg.read",
  "msg.reply",
  "msg.react",
  "artifact.publish",
  "board.create_topic",
  "board.post",
  "board.mark_read",
  "pad.patch",
  "relay.trigger",
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
  regionVisibility,
  summarizeNode,
} from "./authz";
import { resolveTaskAdmission } from "@shared/work-model";
import {
  boardContractOf,
  regionContractOf,
  rulesInForce,
  taskAdmissionState,
} from "@shared/rules";
import { regionStack } from "@shared/graph";
import { sheetToMarkdown } from "@shared/sheet";
import { flowDestinations, reachableBoards } from "@shared/flow-graph";
import { resolveCallerAcrossCanvases } from "./caller-resolve";
import {
  tasksNodeIdentity,
  tasksNodeName,
} from "@shared/tasks-node-identity";
import { injectionSupervisor } from "../term/injection-supervisor";
import {
  admitProcessIdentity,
  getProcessIdentityMap,
  type PeerPidReader,
  type ProcessIdentityDenial,
  type ProcessIdentityMap,
  type ProcessIdentityResult,
  type ProcessPrincipal,
  readUnixPeerPid,
} from "../process-identity";
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
  rotateControlFileToken,
  type ControlSocketPathIdentity,
} from "../control-filesystem";
// Local work control plane for agents: NDJSON over a Unix domain socket at
// ~/.junto/work/control.sock. Token + process-bind identity + edge authz;
// mutations route through WorkService. One admission path, no second identity.

// ---------------------------------------------------------------------------
// Token rotation (browser control pattern)

export const resolveWorkHome = (home?: string, workHome?: string): string => {
  if (workHome && workHome.trim().length > 0) return workHome.trim();
  const env = process.env.JUNTO_WORK_HOME?.trim();
  if (env) return env;
  return workControlDir(home ?? resolveJuntoHome());
};

export const rotateWorkToken = (tokenPath: string): string => {
  return rotateControlFileToken(tokenPath);
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
 * Witness the exact systemd invocation after this process has rotated its
 * token and bound the work listener. Deep terminal, browser, and canvas checks
 * belong to Doctor and release qualification; they never block station boot.
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

export const workTokenMatches = (
  presented: string | undefined,
  expected: string,
): boolean => {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};

// ---------------------------------------------------------------------------
// Admission: the local work-file token proves reach; process-bind proves who.

export type WorkIdentityAdmission =
  | {
      readonly ok: true;
      readonly peerPid: number;
      readonly principal: ProcessPrincipal;
    }
  | {
      readonly ok: false;
      readonly reason: "auth" | "process_unbound" | "peer_pid_unavailable";
      readonly message: string;
      readonly denial?: ProcessIdentityDenial;
    };

/**
 * Pure work identity admission. One path: the local work-file token proves the
 * caller reached us, and process-bind proves which seat it is. There is no
 * second admission — a caller with no live Junto process has no identity.
 */
export const admitWorkIdentity = (input: {
  readonly localToken: string;
  readonly presentedToken: string;
  readonly processIdentity: ProcessIdentityResult | (() => ProcessIdentityResult);
}): WorkIdentityAdmission => {
  if (workTokenMatches(input.presentedToken, input.localToken)) {
    const identity =
      typeof input.processIdentity === "function"
        ? input.processIdentity()
        : input.processIdentity;
    if (!identity.ok) {
      return {
        ok: false,
        reason:
          identity.denial === "peer_pid_unavailable"
            ? "peer_pid_unavailable"
            : "process_unbound",
        message: identity.message,
        denial: identity.denial,
      };
    }
    return {
      ok: true,
      peerPid: identity.peerPid,
      principal: identity.principal,
    };
  }

  return {
    ok: false,
    reason: "auth",
    message: "invalid or missing work control token",
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
  node: CanvasNode | undefined,
): WorkErrorBody | undefined => {
  if (task === undefined || task.state !== "submitted") return undefined;
  const admission = taskAdmissionState(
    task,
    boardContractOf(node),
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

/**
 * Standing rules per board a task raised here can still reach, with
 * provenance, and how incoming tasks are admitted. Pure projection of the document
 * — no work rows involved.
 */
/**
 * Trimmed contract guidance for one board. Blank or whitespace-only authored
 * values never surface (JSON Canvas can hold them even though the editor
 * normalizes).
 */
const boardGuidance = (
  doc: CanvasDoc,
  board: string,
): {
  instructions?: string;
  incomingHandling?: string;
  incomingDescription?: string;
  outgoingHandoff?: string;
  outgoingDescription?: string;
} => {
  const contract = boardContractOf(
    doc.nodes.find((node) => node.id === board),
  );
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
const boardRulesMap = (doc: CanvasDoc, fromNodeId: string) =>
  [...reachableBoards(doc, fromNodeId)].map((board) => {
    const node = doc.nodes.find((candidate) => candidate.id === board);
    const identity = tasksNodeIdentity(node, board);
    const contract = boardContractOf(node);
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
const boardBriefing = (doc: CanvasDoc, nodeId: string) => {
  // Tasks are a product surface: a tasks-off build carries no board summary.
  if (!TASKS_ENABLED) return undefined;
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  const identity = tasksNodeIdentity(node, nodeId);
  const contract = boardContractOf(node);
  const next = flowDestinations(doc, nodeId).map((destination) => {
    const destinationNode = doc.nodes.find(
      (candidate) => candidate.id === destination,
    );
    const incoming = boardContractOf(destinationNode)?.incoming;
    return {
      board: destination,
      name: tasksNodeName(destinationNode, destination),
      ...(incoming?.description !== undefined
        ? { description: incoming.description }
        : {}),
      admission: resolveTaskAdmission(boardContractOf(destinationNode)),
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

const rulingsForRegionStack = (doc: CanvasDoc, nodeId: string) =>
  regionStack(doc, nodeId).flatMap((group) => {
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
  effect: Effect.Effect<A, E, WorkService | CanvasesService | PausePlane>,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  callerId: string,
  targetId: string,
  op: WorkOp,
): WorkErrorBody | { readonly node: ReturnType<typeof findNode> } => {
  // Target-scoped ops: factory physics admit (edge + role law + port facet).
  const admitted = admitWorkTarget(doc, callerId, targetId, op);
  if (Result.isFailure(admitted)) return admitted.failure;
  return { node: admitted.success.node };
};

/** Work-control caller resolved through the sole process-bind admission path. */
type WorkCaller = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly workHome: string;
  /** Occupant label for proof stamps / logs. */
  readonly occupant: string;
  /** Main-derived process incarnation; no client-supplied generation claims. */
  readonly generation: string;
};

const mailSenderStamp = (
  board: CanvasDoc,
  caller: WorkCaller,
  actor: ActorRef,
): MailSenderStamp => {
  const node = findNode(board, caller.nodeId);
  const terminal = node?.ether?.terminal;
  const epoch = terminal?.bindingId === undefined
    ? undefined
    : seatStateRuntime.machine.getSlot(terminal.bindingId)?.epoch;
  return {
    fromSeat: actor.seatId,
    senderGeneration: epoch ?? caller.generation,
    senderHarness: terminal?.harness ?? "unknown",
    senderNodeId: caller.nodeId,
    senderName: node === undefined ? caller.nodeId : nodeTitle(node),
  };
};

/**
 * Resolve one process-bound actor node through the compiled execution
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

/** Bind board display metadata to the authored title, not the opaque node id. */
const boardAuthorForActor = (doc: CanvasDoc, actor: ActorRef): BoardAuthor => {
  const node = findNode(doc, actor.nodeId);
  return {
    kind: "actor",
    seatId: actor.seatId,
    nodeId: actor.nodeId,
    label: node ? nodeTitle(node) : actor.nodeId,
  };
};

const dispatchOp = (
  op: WorkOp,
  args: unknown,
  caller: WorkCaller,
  version: string,
): Effect.Effect<
  unknown,
  WorkErrorBody,
  WorkService | CanvasesService | PausePlane
> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const work = yield* WorkService;
    const pausePlane = yield* PausePlane;

    if (["msg.prompt", "msg.sent", "seat.wait", "seat.read", "tasks.wait", "verdict.post"].includes(op)) {
      yield* work.crewAdmission.pipe(Effect.mapError((error) =>
        mapWorkCode(error.code, error.message, error.details),
      ));
    }

    if (op === "ping") {
      return {
        pong: true,
        protocol_version: WORK_PROTOCOL_VERSION,
        version,
      };
    }

    if (op === "doctor") {
      const commands = yield* work.commandStatus.pipe(
        Effect.mapError(
          (error): WorkErrorBody => ({
            type: "InternalError",
            message: error.message,
            details: { retryable: true },
          }),
        ),
      );
      return {
        ok: true,
        protocol_version: WORK_PROTOCOL_VERSION,
        version,
        socket: "up",
        commands,
        harnesses: probeManagedHarnessInstalls(),
      };
    }

    const read = yield* canvases.read(caller.canvasName, "work.control").pipe(
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
    const board = read.doc;
    const callerErr = ensureCaller(board, caller.nodeId);
    if (callerErr) return yield* Effect.fail(callerErr);

    // The pause plane is the factory's safety switch: a paused seat (its
    // node, a containing region, or the whole canvas — canvases are born
    // paused) may read but never act. Reads stay open so a paused agent can
    // still see the board.
    const pauseState = pausePlane.stateFor(caller.canvasName);
    const paused = seatPaused(pauseState, board, caller.nodeId);
    if (MUTATING_OPS.has(op)) {
      if (paused) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "Paused",
          message: `agent "${caller.nodeId}" is paused and cannot act`,
          details: {
            caller: caller.nodeId,
            retryable: true,
            next_step: "wait for the operator to resume this agent, its region, or the canvas",
          },
        });
      }
    }

    if (op === "capabilities") {
      const self = findNode(board, caller.nodeId)!;
      const connected = connectedCapabilities(board, caller.nodeId);
      const overseer = isManagedAgentNode(self) && self.ether.overseer === true;
      return {
        node: summarizeNode(self),
        harnesses: probeManagedHarnessInstalls(),
        // Additive: derived factory role of the process-bound seat.
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
          ? { next_step: "wait for the operator to resume this agent, its region, or the canvas" }
          : {}),
      };
    }

    if (op === "onboard") {
      const self = findNode(board, caller.nodeId)!;
      const region = containingRegion(board, caller.nodeId);
      const connected = connectedCapabilities(board, caller.nodeId);
      const overseer = isManagedAgentNode(self) && self.ether.overseer === true;
      const tools = overseer
        ? [PREAMBLE_TOOL, ...SIGNAL_TOOLS, OVERSEER_TOOL]
        : [PREAMBLE_TOOL, ...SIGNAL_TOOLS];
      return {
        nodeRef: formatNodeRef({
          canvasName: caller.canvasName,
          nodeId: caller.nodeId,
        }),
        node: summarizeNode(self),
        // Additive: derived factory role of the process-bound seat.
        role: factoryRoleOfNode(self),
        tools,
        overseer: { enabled: overseer, affectedByPause: false },
        region: region ?? null,
        connected: connected.map((c) => ({
          id: c.id,
          kind: c.kind,
          title: c.title,
          summary: c.summary,
          role: c.role,
          grants: c.grants,
          ...(boardBriefing(board, c.id) ?? {}),
        })),
        // Operator-pinned precedent from the seat's own region stack. Region
        // rulings ride the Tasks gate: a tasks-off build names none.
        ...(TASKS_ENABLED
          ? { rulings: rulingsForRegionStack(board, caller.nodeId) }
          : {}),
        co_members: regionVisibility(board, caller.nodeId),
        // Pause surface: a paused seat must distinguish pause from a broken
        // grant. Reads stay open; mutating ops still refuse with Paused.
        paused,
        ...(paused
          ? { next_step: "wait for the operator to resume this agent, its region, or the canvas" }
          : {}),
        capabilities: {
          protocol_version: WORK_PROTOCOL_VERSION,
          connected,
          tools,
        },
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
      return { ...event, disposition: "applied" as const };
    }

    if (op === "tasks.list") {
      const decoded = decodeArgs(TasksListArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const items = gate.node?.ether?.tasks?.items ?? [];
      // Onion visibility holds by construction: rows at this board carry only
      // the current visit's thread; prior interiors live on prior boards'
      // rows. Ambient guidance (board purpose + region stack briefings) is
      // additive so seats can compose against the standing contract.
      const contract = gate.node?.ether?.tasks?.contract;
      const ambient = regionStackFor(board, decoded.success.target);
      return {
        target: decoded.success.target,
        items,
        ...(contract !== undefined
          ? {
              contract: {
                ...boardGuidance(board, decoded.success.target),
                rules: contract.rules ?? [],
                admission: resolveTaskAdmission(contract),
              },
            }
          : {}),
        ...(ambient.length > 0 ? { ambient } : {}),
      };
    }

    if (
      op === "content.path" ||
      op === "content.stat" ||
      op === "content.materialize"
    ) {
      const decoded =
        op === "content.path"
          ? decodeArgs(ContentPathArgs, args)
          : op === "content.stat"
            ? decodeArgs(ContentStatArgs, args)
            : decodeArgs(ContentMaterializeArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const target = decoded.success.target;
      const taskId = decoded.success.task;
      const gate = requireTarget(board, caller.nodeId, target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const task = taskItemsForNode(gate.node!).find(
        (candidate) => candidate.id === taskId,
      );
      if (task === undefined) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "UnknownTarget",
          message: `task "${taskId}" not found on target "${target}"`,
          details: { target: taskId, retryable: false },
        });
      }
      const authorizedRef = taskContentRef(task, decoded.success.ref);
      if (authorizedRef === undefined) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ScopeError",
          message: `content ref is not attached to task "${taskId}"`,
          details: {
            target,
            caller: caller.nodeId,
            hint: "use a ContentRef carried by the authorized task",
            retryable: false,
          },
        });
      }

      const contentOption = yield* Effect.serviceOption(ContentService);
      if (Option.isNone(contentOption)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InternalError",
          message: "content service is unavailable on this Station",
          details: { retryable: true },
        });
      }
      const content = contentOption.value;
      const availability = yield* content.availability(authorizedRef).pipe(
        Effect.mapError((error): WorkErrorBody => ({
          type: "InternalError",
          message: error.message,
          details: { retryable: true },
        })),
      );
      const base = {
        target,
        task: taskId,
        ref: authorizedRef,
        availability,
        state: availability.state,
      } as const;
      if (availability.state !== "verified") {
        return base;
      }

      const canonicalPath = contentObjectPath(content.root, authorizedRef.sha256);
      if (op !== "content.materialize") {
        return { ...base, path: canonicalPath };
      }

      const name =
        op === "content.materialize"
          ? (decoded.success as ContentMaterializeArgs).name
          : undefined;
      const materialized = yield* Effect.tryPromise({
        try: () =>
          materializeContentObject({
            contentRoot: content.root,
            workHome: caller.workHome,
            canvasName: caller.canvasName,
            targetNodeId: target,
            taskId,
            ref: authorizedRef,
            name,
          }),
        catch: (error): WorkErrorBody => {
          const invalidInput =
            error instanceof ContentStoreError && error.code === "invalid";
          return {
            type: invalidInput ? "InputError" : "InternalError",
            message: error instanceof Error ? error.message : String(error),
            details: { retryable: !invalidInput },
          };
        },
      });
      return {
        ...base,
        path: materialized.path,
        canonicalPath,
        materialized: materialized.created,
      };
    }

    if (op === "tasks.create") {
      const decoded = decodeArgs(TasksCreateArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      const result = yield* work.workTaskCreate(
        caller.canvasName,
        decoded.success.target,
        decoded.success.brief,
        decoded.success.metadata,
        decoded.success.reason,
        decoded.success.media,
        decoded.success.dependsOn,
        decoded.success.finishCriteria,
        decoded.success.rules,
        {
          admission: decoded.success.admission,
          admissionOmitted: "approval",
          ...(decoded.success.waitFor !== undefined
            ? { waitForMs: decoded.success.waitFor }
            : {}),
          raisedBy: actor.success,
        },
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      const path = boardRulesMap(board, decoded.success.target);
      return {
        ...exposeWorkMutation(mapped.success),
        ...(path.length > 0 ? { path } : {}),
      };
    }

    if (op === "tasks.claim") {
      const decoded = decodeArgs(TasksClaimArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      const result = yield* work.workTaskClaim(
        caller.canvasName,
        decoded.success.target,
        decoded.success.task,
        actor.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "tasks.update") {
      const decoded = decodeArgs(TasksUpdateArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      const task = gate.node?.ether?.tasks?.items.find(
        (candidate) => candidate.id === decoded.success.task,
      );
      // Unadmitted submitted rows refuse every seat mutation first — a
      // submitted task waiting on approval, wait, or a Me board is not the
      // caller's to complete, send on, or release.
      const unadmitted = refuseUnadmittedSubmitted(task, gate.node);
      if (unadmitted !== undefined) {
        return yield* Effect.fail(unadmitted);
      }
      // Seat/agent wire ownership (tasks-consolidation plan B2): completing
      // or sending work on (including defect send-back) requires the calling
      // seat to be the claimant; failing, canceling, and input requests may
      // come from any connected agent; returning to Queue and archiving are
      // operator-only and refused on the seat wire.
      const sendOn =
        decoded.success.state === "completed" ||
        (decoded.success.state === "rejected" &&
          decoded.success.defect !== undefined);
      if (sendOn) {
        if (
          task?.claimedBy === undefined ||
          task.claimedBy !== actor.success.seatId
        ) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "ClaimConflict",
            message:
              `task "${decoded.success.task}" must be claimed by you before completing or sending it on`,
            details: {
              ...(task?.claimedBy === undefined
                ? {}
                : { holder: task.claimedBy }),
              caller: actor.success.seatId,
              retryable: false,
              next_step:
                "claim the task first; only the claiming seat completes or sends on work",
            },
          });
        }
      } else if (
        decoded.success.state === "submitted" ||
        decoded.success.state === "archived"
      ) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ScopeError",
          message:
            decoded.success.state === "submitted"
              ? "only the operator may return a task to Queue"
              : "only the operator may archive a task",
          details: {
            caller: actor.success.seatId,
            retryable: false,
            next_step:
              "ask the operator to perform this action from the Command Center",
          },
        });
      }
      const result = yield* work.workTaskTransition(
        caller.canvasName,
        decoded.success.target,
        decoded.success.task,
        decoded.success.state,
        decoded.success.note,
        decoded.success.completionEvidence,
        {
          ...(decoded.success.next !== undefined
            ? { next: decoded.success.next }
            : {}),
          ...(decoded.success.defect !== undefined
            ? { defect: decoded.success.defect }
            : {}),
          ...(decoded.success.waitFor !== undefined
            ? { waitForMs: decoded.success.waitFor }
            : {}),
          ...(decoded.success.handoffNote !== undefined
            ? { handoffNote: decoded.success.handoffNote }
            : {}),
        },
        mailSenderStamp(board, caller, actor.success),
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
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

    if (op === "tasks.show") {
      const decoded = decodeArgs(TasksShowArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      // Seats always read the onion view; operator surfaces go through IPC.
      return yield* work
        .workTaskShow(
          caller.canvasName,
          decoded.success.target,
          decoded.success.task,
          "seat",
        )
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              mapWorkCode(error.code, error.message, error.details),
            ),
          ),
        );
    }

    if (op === "tasks.rules") {
      const decoded = decodeArgs(TasksRulesArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      return yield* work
        .workTaskRules(
          caller.canvasName,
          decoded.success.target,
          decoded.success.task,
        )
        .pipe(
          Effect.catch((error) =>
            Effect.fail(
              mapWorkCode(error.code, error.message, error.details),
            ),
          ),
        );
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
      // under, so no edge is involved. A named target is edge-gated as usual.
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

    if (op === "tasks.check") {
      const decoded = decodeArgs(TasksCheckArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(actor)) return yield* Effect.fail(actor.failure);
      const task = gate.node?.ether?.tasks?.items.find(
        (candidate) => candidate.id === decoded.success.task,
      );
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
      const unadmitted = refuseUnadmittedSubmitted(task, gate.node);
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
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const targetId = resolveMailboxTarget(decoded.success.target, caller);
      const own = isOwnMailboxTarget(targetId, caller.nodeId);

      if (decoded.success.taskId) {
        const gate = requireTarget(board, caller.nodeId, targetId, op);
        if ("type" in gate) return yield* Effect.fail(gate);
        const node = gate.node!;
        const kind = nodeKind(node);
        const list =
          kind === "task"
            ? node.ether?.tasks?.items ?? []
            : node.ether?.requests?.items ?? [];
        const task = list.find((t) => t.id === decoded.success.taskId);
        if (!task) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `task "${decoded.success.taskId}" not found`,
            details: { target: decoded.success.taskId, retryable: false },
          });
        }
        return { target: targetId, taskId: task.id, items: task.history };
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
        const items = ownNode.ether?.messages?.items ?? [];
        const overlaid: Message[] = [];
        for (const item of items) {
          if (item.role !== "user") {
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
        const sent: Array<Message & { readonly toNodeId: string }> = [];
        for (const node of board.nodes) {
          if (node.id === caller.nodeId) continue;
          for (const message of node.ether?.messages?.items ?? []) {
            if (message.metadata?.fromSeat !== reader.success.seatId &&
                message.metadata?.fromSeat !== caller.nodeId) continue;
            sent.push({ ...message, toNodeId: node.id });
          }
        }
        sent.sort((a, b) => b.messageId.localeCompare(a.messageId));
        return {
          target: caller.nodeId,
          items: sortMessagesNewestFirst(overlaid),
          sent,
        };
      }

      const gate = requireTarget(board, caller.nodeId, targetId, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      return {
        target: targetId,
        items: sortMessagesNewestFirst(gate.node?.ether?.messages?.items ?? []),
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
      return yield* seat.readSeat(decoded.success, caller);
    }
    if (op === "tasks.wait") {
      const decoded = decodeArgs(TaskWaitArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const seat = yield* liveSeatObservation();
      return yield* seat.waitTask(decoded.success, caller);
    }

    if (op === "msg.prompt") {
      const decoded = decodeArgs(MsgPromptArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const input = decoded.success;
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
      return { ...exposeWorkMutation(appended.success), messageId, delivery };
    }

    if (op === "msg.sent") {
      const decoded = decodeArgs(MsgSentArgs, args ?? {});
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const sender = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sender)) return yield* Effect.fail(sender.failure);
      const items: Array<Message & { readonly toNodeId: string }> = [];
      for (const node of board.nodes) {
        if (decoded.success.target !== undefined && node.id !== decoded.success.target) continue;
        for (const message of node.ether?.messages?.items ?? []) {
          if (message.metadata?.fromSeat !== sender.success.seatId &&
              message.metadata?.fromSeat !== caller.nodeId) continue;
          items.push({ ...message, toNodeId: node.id });
        }
      }
      items.sort((a, b) => b.messageId.localeCompare(a.messageId));
      return { target: caller.nodeId, items };
    }

    if (op === "msg.send") {
      const decoded = decodeArgs(MsgSendArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const text = decoded.success.text.trim();
      if (!text) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const sentBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
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
      // Task-scoped messages are the task's comment channel, not mail.
      if (decoded.success.taskId !== undefined) {
        return { ...exposeWorkMutation(mapped.success), messageId };
      }
      const delivery = yield* Effect.promise(() =>
        messageDelivery.deliver(caller.canvasName, decoded.success.target, messageId),
      );
      return { ...exposeWorkMutation(mapped.success), messageId, delivery };
    }

    if (op === "msg.read") {
      const decoded = decodeArgs(MsgReadArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const targetId = resolveMailboxTarget(decoded.success.target, caller);
      // Own mailbox only — process-bind is the authority (not edge OptIn ports).
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
      const message = own.ether?.messages?.items.find(
        (item) => item.messageId === decoded.success.messageId.trim(),
      );
      const result = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        decoded.success.messageId.trim(),
        reader.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return { ...exposeWorkMutation(mapped.success), message };
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
      const decoded = decodeArgs(MsgReplyArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const text = decoded.success.text.trim();
      if (!text) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const inReplyTo = decoded.success.inReplyTo.trim();
      if (!inReplyTo) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "inReplyTo must be non-empty",
          details: { path: "inReplyTo", retryable: false },
        });
      }
      const sentBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
      // Mark the parent mail read on own inbox first (idempotent).
      const marked = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        inReplyTo,
        sentBy.success,
      );
      const markedMapped = fromWorkResult(marked);
      if (Result.isFailure(markedMapped)) return yield* Effect.fail(markedMapped.failure);
      const message: Message = makeUserMessage({
        messageId: ulid(),
        text,
        contextId: caller.canvasName,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({
            ...mailSenderStamp(board, caller, sentBy.success),
            mailKind: "notice",
            ...(decoded.success.refs === undefined ? {} : { refs: decoded.success.refs }),
          }),
          inReplyTo,
        },
      });
      const result = yield* work.workMessageAppend(
        caller.canvasName,
        decoded.success.target,
        null,
        message,
        sentBy.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return {
        ...exposeWorkMutation(mapped.success),
        inReplyTo,
        read: exposeWorkMutation(markedMapped.success),
      };
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
        const listed = yield* signals.listSeat(seat).pipe(Effect.mapError(signalError));
        return {
          signals: listed,
          open: listed.filter((signal) => signal.state === "open").length,
        };
      }

      if (op === "signal.clear") {
        const decoded = decodeArgs(SignalClearArgs, args ?? {});
        if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
        const withdrawn = yield* signals
          .withdraw(seat, decoded.success.signalId)
          .pipe(Effect.mapError(signalError));
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
      const signal = yield* signals
        .raise({ ...seat, kind: decoded.success.kind, text, ...(detail ? { detail } : {}) })
        .pipe(Effect.mapError(signalError));
      return {
        signal,
        disposition: "applied" as const,
        next_step: SIGNAL_NEXT_STEP[signal.kind],
      };
    }

    if (op === "artifact.publish") {
      const decoded = decodeArgs(ArtifactPublishArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const parts = decoded.success.parts as Part[];
      const artifact: Artifact = {
        artifactId: decoded.success.artifactId?.trim() || ulid(),
        parts,
        ...(decoded.success.name !== undefined ? { name: decoded.success.name } : {}),
        ...(decoded.success.task !== undefined
          ? {
              task: {
                kind: "task",
                itemId: decoded.success.task.id,
                sink: {
                  canvasName: caller.canvasName,
                  nodeId: decoded.success.task.target,
                },
              },
            }
          : {}),
        ...(decoded.success.metadata !== undefined
          ? { metadata: decoded.success.metadata }
          : {}),
      };
      const publishedBy = resolveProcessBoundActorRef(
        read.actorRefs,
        caller,
      );
      if (Result.isFailure(publishedBy)) {
        return yield* Effect.fail(publishedBy.failure);
      }
      const result = yield* work.workArtifactPublish(
        caller.canvasName,
        decoded.success.target,
        artifact,
        publishedBy.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      // Work control admits process-bound callers only. Renderer IPC publish
      // does not write stamps, so it cannot become a trust-plane side door.
      const authority = artifactPublishAuthority({
        canvasName: caller.canvasName,
        seat: caller.nodeId,
        occupant: caller.occupant,
        sinkNodeId: decoded.success.target,
      });
      const stamp = extractProofStamp(authority, mapped.success.value);
      if (stamp) {
        globalStampRuntime.recordStamp(authority, stamp);
      }
      return exposeWorkMutation(mapped.success);
    }

    if (op === "board.list") {
      const decoded = decodeArgs(BoardListArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const result = yield* work.workBoardList(
        caller.canvasName,
        decoded.success.target,
        decoded.success.topicId,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      const { resolveBoardConnectedActors } = yield* Effect.promise(
        () => import("@shared/board-actors"),
      );
      const actors = resolveBoardConnectedActors(
        board,
        decoded.success.target,
      );
      return {
        topics: mapped.success.value.topics,
        /** Connected actor roster for collaboration (node ids + labels). */
        actors,
      };
    }

    if (op === "board.tags") {
      const decoded = decodeArgs(BoardTagsListArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const result = yield* work.workBoardList(
        caller.canvasName,
        decoded.success.target,
        decoded.success.topicId,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      const me = caller.nodeId;
      const posts = mapped.success.value.topics.flatMap((topic) =>
        (topic.posts ?? [])
          .filter(
            (post) =>
              Array.isArray(post.tags) && post.tags.includes(me),
          )
          .map((post) => ({
            topicId: topic.topicId,
            topicTitle: topic.title,
            post,
          })),
      );
      return {
        actorNodeId: me,
        posts,
      };
    }

    if (op === "board.create_topic") {
      const decoded = decodeArgs(BoardCreateTopicArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(bound)) return yield* Effect.fail(bound.failure);
      const author = boardAuthorForActor(board, bound.success);
      // Agents never wake the floor — notify flag ignored.
      const result = yield* work.workBoardCreateTopic(
        caller.canvasName,
        decoded.success.target,
        decoded.success.title,
        decoded.success.body,
        author,
        false,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "board.post") {
      const decoded = decodeArgs(BoardPostArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(bound)) return yield* Effect.fail(bound.failure);
      const author = boardAuthorForActor(board, bound.success);
      const {
        resolveBoardConnectedActors,
        normalizeBoardTags,
        filterTagsToConnected,
        tagNotifyNodeIds,
      } = yield* Effect.promise(() => import("@shared/board-actors"));
      const { resolveBoardWakeSet } = yield* Effect.promise(
        () => import("@shared/board-wake"),
      );
      const actors = resolveBoardConnectedActors(
        board,
        decoded.success.target,
      );
      const tags = filterTagsToConnected(
        normalizeBoardTags(decoded.success.tags),
        actors,
      );
      const result = yield* work.workBoardPost(
        caller.canvasName,
        decoded.success.target,
        decoded.success.topicId,
        decoded.success.text,
        author,
        tags,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);

      // Soft tag notify: only tagged seats with edge wake; async no-reply inject.
      if (tags.length > 0) {
        const notifyIds = new Set(
          tagNotifyNodeIds(tags, actors, bound.success.nodeId),
        );
        if (notifyIds.size > 0) {
          const seats = resolveBoardWakeSet(board, decoded.success.target).filter(
            (s) => notifyIds.has(s.nodeId),
          );
          if (seats.length > 0) {
            const excerpt = decoded.success.text.trim();
            void import("./board-delivery")
              .then(({ softBoardTagNotify }) =>
                softBoardTagNotify({
                  canvas: caller.canvasName,
                  boardNodeId: decoded.success.target,
                  seats,
                  topicId: decoded.success.topicId,
                  postId: mapped.success.value.post.postId,
                  excerpt,
                  authorLabel: author.label ?? bound.success.nodeId,
                }),
              )
              .catch(() => undefined);
          }
        }
      }

      return exposeWorkMutation(mapped.success);
    }

    if (op === "board.mark_read") {
      const decoded = decodeArgs(BoardMarkReadArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(bound)) return yield* Effect.fail(bound.failure);
      const principalKey = `seat:${bound.success.seatId}`;
      const result = yield* work.workBoardMarkRead(
        caller.canvasName,
        decoded.success.target,
        decoded.success.topicId,
        principalKey,
        decoded.success.upToPosition,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "pad.read") {
      const decoded = decodeArgs(PadReadArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const result = yield* work.workPadRead(
        caller.canvasName,
        decoded.success.target,
        decoded.success.pinId,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return mapped.success.value;
    }

    if (op === "pad.patch") {
      const decoded = decodeArgs(PadPatchArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Result.isFailure(bound)) return yield* Effect.fail(bound.failure);
      const author: BoardAuthor = {
        kind: "actor",
        seatId: bound.success.seatId,
        nodeId: bound.success.nodeId,
      };
      const result = yield* work.workPadPatch(
        caller.canvasName,
        decoded.success.target,
        decoded.success.patches,
        author,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }

    if (op === "sheet.read") {
      const decoded = decodeArgs(SheetReadArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      // The sheet is authored on the canvas, so the document IS the read — no
      // work row to project, and nothing here can write back.
      const sheet = gate.node?.ether?.sheet;
      const grid = sheet ?? { columns: [], rows: [] };
      return {
        target: decoded.success.target,
        title: gate.node ? nodeTitle(gate.node) : decoded.success.target,
        columns: grid.columns,
        rows: grid.rows,
        markdown: sheetToMarkdown(grid),
      };
    }

    if (op === "relay.trigger") {
      if (!RELAY_ENABLED) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "relay.trigger is disabled in this Junto build",
          details: { retryable: false, missing: "relay feature" },
        });
      }
      const decoded = decodeArgs(RelayTriggerArgs, args);
      if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const kind = nodeKind(gate.node);
      if (
        kind !== "relay" &&
        kind !== "cron" &&
        kind !== "timer" &&
        kind !== "watcher"
      ) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: `relay.trigger requires a scheduler target; got ${kind ?? "none"}`,
          details: {
            target: decoded.success.target,
            caller: caller.nodeId,
            retryable: false,
            missing: "scheduler target",
          },
        });
      }
      const fired = yield* Effect.tryPromise({
        try: () =>
          manualSchedulerFire({
            canvasName: caller.canvasName,
            sourceNodeId: decoded.success.target,
            kind:
              kind === "cron" || kind === "timer"
                ? "cron"
                : kind === "watcher"
                  ? "gauge"
                  : "relay",
          }),
        catch: (error) => ({
          type: "InternalError" as const,
          message: error instanceof Error ? error.message : String(error),
          details: { retryable: true },
        }),
      });
      if (!fired.ok) {
        return yield* Effect.fail({
          type: "RuntimeDown" as const,
          message: fired.message,
          details: { target: decoded.success.target, retryable: true },
        });
      }
      return {
        target: decoded.success.target,
        fired: true as const,
        applied: fired.applied,
        message: fired.message,
        disposition: "applied" as const,
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
  readonly tokenPath: string;
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
  /** Test / alternate identity map (defaults to the shared main-process map). */
  readonly processMap?: ProcessIdentityMap;
  /** Test seam for peer PID (defaults to Unix LOCAL_PEERPID / SO_PEERCRED). */
  readonly readPeerPid?: PeerPidReader;
  /** Test seam; production uses the process-global main authoring authority. */
  readonly authoringGate?: MainAuthoringGate;
  /** Main-process delivery for the seat-local, ephemeral preamble surface. */
  readonly onPreamble?: (event: PreambleEvent) => void;
  /** Main-process delivery of a seat's raised or withdrawn agent signal. */
  readonly onAgentSignal?: (signal: AgentSignal) => void;
  /** Called only after live process-bind and seat delegation admission. */
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
  /** Tests may lower, never raise, the accepted peer ceiling. */
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
const WORK_CONTROL_MAX_CLIENTS = 32;

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
 * re-resolves the kernel peer on every lifecycle notification: the retired PID
 * may have a second, identical main-minted ancestor, while the notification's
 * principal alone cannot prove whether this peer lost authority.
 */
const watchProcessIdentityRevocation = (
  processMap: ProcessIdentityMap,
  peerPid: number,
  principal: ProcessPrincipal,
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
        // Revocation is fail-closed; a test/alternate map cannot keep a
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
        current = processMap.resolveInTree(peerPid);
      } catch {
        finishRevoked();
        return;
      }
      if (!samePrincipalAnchors(current, principal)) finishRevoked();
    };

    try {
      const stop = processMap.subscribe(() => verifyCurrentIdentity());
      if (active) {
        unsubscribe = stop;
      } else {
        // A custom map may synchronously notify during subscribe.
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
    // notifies us or is visible in this resolve.
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

  const tokenPath = workControlTokenPath(workHome);
  const socketPath = workControlSocketPath(workHome);
  let token = "";
  const processMap = options.processMap ?? getProcessIdentityMap();
  const readPeerPid = options.readPeerPid ?? readUnixPeerPid;
  const authoringGate = options.authoringGate ?? mainAuthoringGate;

  const shutdownGraceMs = boundedRuntimeValue(
    runtime.shutdownGraceMs,
    WORK_CONTROL_SHUTDOWN_GRACE_MS,
  );
  const shutdownDeadlineMs = boundedRuntimeValue(
    runtime.shutdownDeadlineMs,
    WORK_CONTROL_SHUTDOWN_DEADLINE_MS,
  );
  const maxActiveClients = boundedRuntimeValue(runtime.maxActiveClients, WORK_CONTROL_MAX_CLIENTS);
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
    if (shuttingDown || admittedClients.size >= maxActiveClients) {
      socket.end();
      return;
    }
    admittedClients.add(socket);
    let buffer = Buffer.alloc(0);
    let closed = false;
    // Peer PID is stable for the life of the connection — read once.
    let cachedPeerPid: number | undefined | null = null;
    const readPeerOnce = (): number | undefined => {
      if (cachedPeerPid === null) {
        cachedPeerPid = readPeerPid(socket);
      }
      return cachedPeerPid === null ? undefined : cachedPeerPid;
    };

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

      // The work-file token proves owner-local reach; process-bind is the sole
      // caller identity.
      const admission = admitWorkIdentity({
        localToken: token,
        presentedToken: req.token,
        processIdentity: () =>
          admitProcessIdentity(socket, processMap, readPeerOnce),
      });
      if (!admission.ok) {
        if (admission.reason === "auth") {
          respond(
            socket,
            workErr(
              "AuthError",
              admission.message,
              {
                retryable: true,
                next_step: "your token is invalid or stale; run `junto doctor`, and if Junto is not running ask the operator to start it",
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
            "AuthError",
            admission.message,
            {
              retryable: admission.reason === "peer_pid_unavailable",
              next_step:
                admission.reason === "process_unbound"
                  ? "this process was not launched by Junto; only agents started from the canvas can call work ops — ask the operator to start you from an agent node"
                  : "run the CLI from inside your Junto terminal session, then retry",
              missing: "process identity",
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
        const liveAuthorityAndDispatch: Effect.Effect<
          WorkDispatchResult,
          never,
          WorkService | CanvasesService | PausePlane
        > = Effect.gen(function* () {
          const liveDocsResult = yield* Effect.flatMap(
            CanvasesService,
            (canvases) => canvases.liveDocuments(),
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
            liveDocsResult.success,
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

          // Bootstrap proof: any work-plane call from the seat's own process is
          // definitive evidence the agent knows the factory CLI. Managed seats
          // bind their process by agent key, not binding id, so the proof key
          // comes from the resolved caller node's terminal binding.
          const callerNode = callerResolved.caller.node;
          const proofBindingId =
            admission.principal.bindingId ??
            (isManagedAgentNode(callerNode)
              ? callerNode.ether.terminal.bindingId
              : undefined);
          yield* Effect.sync(() =>
            injectionSupervisor.noteWorkPlaneCall(proofBindingId),
          );
          const occupant = occupantKeyForPrincipal(
            admission.principal,
            `pid:${admission.peerPid}`,
          );
          const caller: WorkCaller = {
            canvasName: callerResolved.caller.canvasName,
            nodeId: callerResolved.caller.nodeId,
            workHome,
            occupant,
            generation: createHash("sha256").update(JSON.stringify(
              processMap.snapshot()
                .filter((entry) => samePrincipalAnchors(entry.principal, admission.principal))
                .map((entry) => [entry.pid, entry.startKey])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            )).digest("hex"),
          };
          admittedSeat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
          const nativeController = isManagedAgentNode(callerResolved.caller.node) &&
            callerResolved.caller.node.ether.terminal.harness === "junto-overseer";
          if (!LIVE_OVERSEER_ENABLED && (nativeController || req.op === "overseer.live")) {
            return Result.fail<WorkErrorBody>({
              type: "ScopeError", message: "Live conversation is disabled in this Junto build",
            });
          }
          const controllerIdentity = (): OverseerHostIdentity | undefined => {
            const node = callerResolved.caller.node;
            if (!nativeController || !isManagedAgentNode(node)) return undefined;
            // This protocol belongs to the actual managed host, not arbitrary
            // descendants which happen to inherit its ordinary Work identity.
            const binding = processMap.snapshot().find((entry) =>
              entry.pid === admission.peerPid && samePrincipalAnchors(entry.principal, admission.principal));
            if (binding === undefined) return undefined;
            return {
              canvasName: caller.canvasName, nodeId: caller.nodeId,
              bindingId: node.ether.terminal.bindingId, peerPid: admission.peerPid,
              processGeneration: `${binding.pid}:${binding.startKey}`,
            };
          };
          if (req.op === "overseer.live") {
            const identity = controllerIdentity();
            if (identity === undefined) return Result.fail<WorkErrorBody>({
              type: "AuthError", message: "the Live controller protocol requires the current native Overseer process",
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
            if (!isManagedAgentNode(node) || node.ether.overseer !== true) {
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
          if (nativeController && !["ping", "doctor", "capabilities", "onboard"].includes(req.op)) {
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

        const revocationWatcher = watchProcessIdentityRevocation(
          processMap,
          admission.peerPid,
          admission.principal,
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
        const outcome = authoringLabel === undefined
          ? await run()
          : await authoringGate.run(authoringLabel, run);

        if (Result.isFailure(outcome)) {
          const body = outcome.failure;
          respond(
            socket,
            workErr(body.type, body.message, body.details, req.op, req.id),
          );
          return;
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
        respond(socket, workOk(req.op, outcome.success, req.id));
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
    token = rotateWorkToken(tokenPath);
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
    tokenPath,
    workHome,
    beginShutdown,
    drainOnQuit,
    close: drainOnQuit,
  };
};
