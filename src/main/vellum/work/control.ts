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
import { resolveVellumHome } from "@shared/vellum-home";
import { join } from "node:path";
import { Effect, Either, Option, Schema } from "effect";
import { ulid } from "ulid";
import type { Artifact, CanvasDoc, Message, Part } from "@shared/canvas";
import {
  normalizePreambleText,
  PREAMBLE_MAX_TEXT_LENGTH,
  PREAMBLE_TTL_MS,
  type PreambleEvent,
} from "@shared/preamble";
import type { ActorRef } from "@shared/work-protocol";
import {
  makeAgentMessage,
  makeUserMessage,
} from "@shared/task";
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
  WORK_MAX_FRAME_BYTES,
  WORK_PROTOCOL_VERSION,
  WorkOpName,
  decodeWorkRequest,
  encodeWorkFrame,
  makeStopDirective,
  workErr,
  workOk,
  workControlDir,
  workControlSocketPath,
  workControlTokenPath,
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
import {
  liveSeatBlock,
  markSeatBlocked,
  stopDirectiveFromBlock,
} from "./blocked-seat";
import { PausePlane } from "../pause-plane";
import { seatPaused } from "@shared/pause";

/** Ops that act on the factory — refused for paused seats. Reads stay open. */
const MUTATING_OPS: ReadonlySet<string> = new Set([
  "tasks.claim",
  "tasks.create",
  "tasks.update",
  "content.materialize",
  "preamble",
  "msg.send",
  "msg.read",
  "msg.reply",
  "request.escalate",
  "artifact.publish",
  "board.create_topic",
  "board.post",
  "board.mark_read",
]);

/**
 * Ops refused while the seat is escalate-blocked. Meta discovery
 * (ping/doctor/capabilities/onboard) stays open so agents can re-orient.
 * Board list/mark_read stay open so agents can clear attention while blocked.
 */
const BLOCKED_ENFORCED_OPS: ReadonlySet<string> = new Set([
  "tasks.list",
  "tasks.claim",
  "tasks.create",
  "tasks.update",
  "content.path",
  "content.stat",
  "content.materialize",
  "preamble",
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "request.escalate",
  "artifact.publish",
  "board.create_topic",
  "board.post",
]);
import {
  admitWorkTarget,
  connectedCapabilities,
  containingRegion,
  factoryRoleOfNode,
  findNode,
  nodeKind,
  regionVisibility,
  summarizeNode,
} from "./authz";
import { resolveCallerAcrossCanvases } from "./caller-resolve";
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
// ~/.vellum/work/control.sock. Token + process-bind identity + edge authz;
// mutations route through WorkService. One admission path, no second identity.

// ---------------------------------------------------------------------------
// Token rotation (browser control pattern)

export const resolveWorkHome = (home?: string, workHome?: string): string => {
  if (workHome && workHome.trim().length > 0) return workHome.trim();
  const env = process.env.VELLUM_WORK_HOME?.trim();
  if (env) return env;
  return workControlDir(home ?? resolveVellumHome());
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
    path: join(runtimeDirectory, "vellum-remote", `ready-${generation}`),
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
 * second admission — a caller with no live Vellum Command process has no identity.
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

const mapWorkCode = (
  code: string,
  message: string,
): WorkErrorBody => {
  switch (code) {
    case "claim_contention": {
      const holder = message.match(/claimed by "([^"]+)"/)?.[1];
      return {
        type: "ClaimConflict",
        message,
        details: {
          holder,
          retryable: false,
          next_step: "wait for the holder to release, or pick another task",
        },
      };
    }
    case "illegal_transition": {
      const m = message.match(/from (\S+) to (\S+)/);
      const missing = message.match(/\[([^\]]+)\]/)?.[1];
      const nextStep = message.match(/\(next: ([^)]+)\)/)?.[1];
      return {
        type: "InvalidTransition",
        message,
        details: {
          from: m?.[1],
          to: m?.[2],
          ...(missing !== undefined ? { missing } : {}),
          ...(nextStep !== undefined ? { next_step: nextStep } : {}),
          retryable: false,
        },
      };
    }
    case "node_not_found":
    case "task_not_found":
      return {
        type: "UnknownTarget",
        message,
        details: { retryable: false },
      };
    case "canvas_not_found":
      return {
        type: "StaleNodeRef",
        message,
        details: {
          retryable: false,
          next_step: "ensure the process-bound agent card exists on a live canvas",
        },
      };
    case "illegal_kind":
      return {
        type: "ScopeError",
        message,
        details: {
          retryable: false,
          hint: "connect the nodes",
          next_step: "target a node of the required kind via an edge",
        },
      };
    default:
      return {
        type: "InputError",
        message,
        details: { retryable: false },
      };
  }
};

type WorkMutationOutcome<T> = {
  readonly value: T;
  readonly disposition: "applied" | "queued";
};

const fromWorkResult = <T>(
  result: WorkOpResult<T>,
): Either.Either<WorkMutationOutcome<T>, WorkErrorBody> => {
  if (result.ok) {
    return Either.right({
      value: result.data,
      disposition: result.disposition,
    });
  }
  return Either.left(mapWorkCode(result.code, result.message));
};

const exposeWorkMutation = <T extends object>(
  outcome: WorkMutationOutcome<T>,
): T & { readonly disposition: "applied" | "queued" } => ({
  ...outcome.value,
  disposition: outcome.disposition,
});

const decodeArgs = <A, I>(
  schema: Schema.Schema<A, I>,
  args: unknown,
): Either.Either<A, WorkErrorBody> => {
  const decoded = Schema.decodeUnknownEither(schema, {
    onExcessProperty: "error",
  })(args ?? {});
  if (Either.isLeft(decoded)) {
    return Either.left({
      type: "InputError",
      message: decoded.left.message,
      details: {
        path: "args",
        hint: "pass a JSON object matching the command schema",
        retryable: false,
      },
    });
  }
  return Either.right(decoded.right);
};

// ---------------------------------------------------------------------------
// Dispatch

type RunEffect = <A, E>(
  effect: Effect.Effect<A, E, WorkService | CanvasesService | PausePlane>,
) => Promise<A>;

const PREAMBLE_TOOL = Object.freeze({
  id: "preamble",
  command: "vellum preamble",
  description: "Show a short-lived thought bubble above this agent node.",
  input: { text: "..." },
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
        next_step: "ensure the live process maps to one actor card on the canvas",
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
  if (Either.isLeft(admitted)) return admitted.left;
  return { node: admitted.right.node };
};

/** Work-control caller resolved through the sole process-bind admission path. */
type WorkCaller = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly workHome: string;
  /** Occupant label for proof stamps / logs. */
  readonly occupant: string;
};

/**
 * Resolve one process-bound actor node through the compiled execution
 * projection. Node IDs remain routing/display facts; only ActorRef carries
 * work authority.
 */
export const resolveProcessBoundActorRef = (
  actorRefs: ReadonlyArray<ActorRef>,
  caller: Pick<WorkCaller, "canvasName" | "nodeId">,
): Either.Either<ActorRef, WorkErrorBody> => {
  const matches = actorRefs.filter(
    (actor) =>
      actor.canvasName === caller.canvasName &&
      actor.nodeId === caller.nodeId,
  );
  if (matches.length === 1) return Either.right(matches[0]!);
  return Either.left({
    type: "StaleNodeRef",
    message:
      matches.length === 0
        ? `caller node "${caller.nodeId}" has no compiled actor reference`
        : `caller node "${caller.nodeId}" has ambiguous compiled actor references`,
    details: {
      caller: caller.nodeId,
      retryable: false,
      next_step:
        "refresh the Command Center projection and ensure the live process maps to exactly one actor seat",
    },
  });
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
      };
    }

    const read = yield* canvases.read(caller.canvasName).pipe(
      Effect.mapError(
        (e): WorkErrorBody => ({
          type: "StaleNodeRef",
          message: e.message,
          details: {
            retryable: false,
            next_step: "open the canvas in Vellum Command",
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
    if (MUTATING_OPS.has(op)) {
      const pauseState = pausePlane.stateFor(caller.canvasName);
      if (seatPaused(pauseState, board, caller.nodeId)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "Paused",
          message: `seat "${caller.nodeId}" is paused — the factory is not accepting its actions`,
          details: {
            caller: caller.nodeId,
            retryable: true,
            next_step: "wait for the operator to press play on the seat, region, or canvas",
          },
        });
      }
    }

    // Escalate-blocked seat: refuse work ops with a stop directive so harnesses
    // without hooks (e.g. Codex) still stop thrashing. Auto-clears when the
    // open request leaves input-required / is removed.
    if (BLOCKED_ENFORCED_OPS.has(op)) {
      const block = liveSeatBlock(caller.canvasName, caller.nodeId, board);
      if (block) {
        const directive = stopDirectiveFromBlock(block);
        return yield* Effect.fail<WorkErrorBody>({
          type: "Blocked",
          message: directive.message,
          details: {
            caller: caller.nodeId,
            target: block.target,
            requestId: block.requestId,
            retryable: true,
            next_step: directive.next_step,
            hint: "stop — do not retry work ops until the operator answers",
            stop_directive: directive,
          },
        });
      }
    }

    if (op === "capabilities") {
      const self = findNode(board, caller.nodeId)!;
      const connected = connectedCapabilities(board, caller.nodeId);
      return {
        node: summarizeNode(self),
        // Additive: derived factory role of the process-bound seat.
        role: factoryRoleOfNode(self),
        tools: [PREAMBLE_TOOL],
        protocol_version: WORK_PROTOCOL_VERSION,
        connected,
        co_members: regionVisibility(board, caller.nodeId),
      };
    }

    if (op === "onboard") {
      const self = findNode(board, caller.nodeId)!;
      const region = containingRegion(board, caller.nodeId);
      const connected = connectedCapabilities(board, caller.nodeId);
      return {
        nodeRef: formatNodeRef({
          canvasName: caller.canvasName,
          nodeId: caller.nodeId,
        }),
        node: summarizeNode(self),
        // Additive: derived factory role of the process-bound seat.
        role: factoryRoleOfNode(self),
        tools: [PREAMBLE_TOOL],
        region: region ?? null,
        connected: connected.map((c) => ({
          id: c.id,
          kind: c.kind,
          title: c.title,
          summary: c.summary,
          role: c.role,
          grants: c.grants,
        })),
        co_members: regionVisibility(board, caller.nodeId),
        capabilities: {
          protocol_version: WORK_PROTOCOL_VERSION,
          connected,
          tools: [PREAMBLE_TOOL],
        },
      };
    }

    if (op === "preamble") {
      const decoded = decodeArgs(PreambleArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const text = normalizePreambleText(decoded.right.text);
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
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const items = gate.node?.ether?.tasks?.items ?? [];
      const proposals = gate.node?.ether?.tasks?.proposals ?? [];
      return { target: decoded.right.target, items, proposals };
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
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const target = decoded.right.target;
      const taskId = decoded.right.task;
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
      const authorizedRef = taskContentRef(task, decoded.right.ref);
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
          ? (decoded.right as ContentMaterializeArgs).name
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
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(actor)) return yield* Effect.fail(actor.left);
      const result = yield* work.workTaskPropose(
        caller.canvasName,
        decoded.right.target,
        decoded.right.brief,
        decoded.right.metadata,
        actor.right,
        decoded.right.reason,
        decoded.right.media,
        decoded.right.dependsOn,
        decoded.right.finishCriteria,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "tasks.claim") {
      const decoded = decodeArgs(TasksClaimArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(actor)) return yield* Effect.fail(actor.left);
      const result = yield* work.workTaskClaim(
        caller.canvasName,
        decoded.right.target,
        decoded.right.task,
        actor.right,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "tasks.update") {
      const decoded = decodeArgs(TasksUpdateArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(actor)) return yield* Effect.fail(actor.left);
      const task = gate.node?.ether?.tasks?.items.find(
        (candidate) => candidate.id === decoded.right.task,
      );
      if (
        task?.claimedBy !== undefined &&
        task.claimedBy !== actor.right.seatId
      ) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "ClaimConflict",
          message:
            `task "${decoded.right.task}" is claimed by another actor seat`,
          details: {
            holder: task.claimedBy,
            caller: actor.right.seatId,
            retryable: false,
            next_step: "only the claimed actor may update an active task",
          },
        });
      }
      const result = yield* work.workTaskTransition(
        caller.canvasName,
        decoded.right.target,
        decoded.right.task,
        decoded.right.state,
        decoded.right.note,
        decoded.right.completionEvidence,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "msg.list") {
      const decoded = decodeArgs(MsgListArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const node = gate.node!;
      const kind = nodeKind(node);
      if (decoded.right.taskId) {
        const list =
          kind === "task"
            ? node.ether?.tasks?.items ?? []
            : node.ether?.requests?.items ?? [];
        const task = list.find((t) => t.id === decoded.right.taskId);
        if (!task) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `task "${decoded.right.taskId}" not found`,
            details: { target: decoded.right.taskId, retryable: false },
          });
        }
        return { target: decoded.right.target, taskId: task.id, items: task.history };
      }
      return {
        target: decoded.right.target,
        items: node.ether?.messages?.items ?? [],
      };
    }

    if (op === "msg.send") {
      const decoded = decodeArgs(MsgSendArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const text = decoded.right.text.trim();
      if (!text) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      // Factory mail: deliver as *foreign* user text so the mailbox types it
      // into the recipient's managed terminal. Own-echo still uses agent role
      // for self-history; inter-seat mail must not use makeAgentMessage.
      const messageId = ulid();
      const contextId = caller.canvasName;
      const from = caller.nodeId.trim() || "seat";
      const body = `[factory mail from ${from}] ${text}`;
      const message: Message = makeUserMessage({
        messageId,
        text: body,
        contextId,
        ...(decoded.right.taskId ? { taskId: decoded.right.taskId } : {}),
        metadata: { factoryMail: true, fromSeat: from },
      });
      const sentBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(sentBy)) return yield* Effect.fail(sentBy.left);
      const result = yield* work.workMessageAppend(
        caller.canvasName,
        decoded.right.target,
        decoded.right.taskId ?? null,
        message,
        sentBy.right,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "msg.read") {
      const decoded = decodeArgs(MsgReadArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      // Own mailbox only — process-bind is the authority (not edge OptIn ports).
      // Actor↔actor is OptIn; a seat reading its own inbox must not require a
      // self-loop edge with msg.list.
      if (decoded.right.target !== caller.nodeId) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "msg.read only applies to this seat's own mailbox",
          details: {
            caller: caller.nodeId,
            target: decoded.right.target,
            next_step: `use target "${caller.nodeId}" (your seat) with the messageId`,
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
      if (Either.isLeft(reader)) return yield* Effect.fail(reader.left);
      const result = yield* work.workMessageMarkRead(
        caller.canvasName,
        decoded.right.target,
        decoded.right.messageId.trim(),
        reader.right,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "msg.reply") {
      const decoded = decodeArgs(MsgReplyArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const text = decoded.right.text.trim();
      if (!text) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const inReplyTo = decoded.right.inReplyTo.trim();
      if (!inReplyTo) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "inReplyTo must be non-empty",
          details: { path: "inReplyTo", retryable: false },
        });
      }
      const sentBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(sentBy)) return yield* Effect.fail(sentBy.left);
      // Mark the parent mail read on own inbox first (idempotent).
      const marked = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        inReplyTo,
        sentBy.right,
      );
      const markedMapped = fromWorkResult(marked);
      if (Either.isLeft(markedMapped)) return yield* Effect.fail(markedMapped.left);
      const from = caller.nodeId.trim() || "seat";
      const message: Message = makeUserMessage({
        messageId: ulid(),
        text: `[factory mail from ${from}] ${text}`,
        contextId: caller.canvasName,
        metadata: {
          factoryMail: true,
          fromSeat: from,
          inReplyTo,
        },
      });
      const result = yield* work.workMessageAppend(
        caller.canvasName,
        decoded.right.target,
        null,
        message,
        sentBy.right,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return {
        ...exposeWorkMutation(mapped.right),
        inReplyTo,
        read: exposeWorkMutation(markedMapped.right),
      };
    }

    if (op === "request.escalate") {
      const decoded = decodeArgs(RequestEscalateArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(
        board,
        caller.nodeId,
        decoded.right.target,
        op,
      );
      if ("type" in gate) return yield* Effect.fail(gate);
      const raisedBy = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(raisedBy)) return yield* Effect.fail(raisedBy.left);
      // File the durable request, then mark the calling seat blocked and
      // return a stop directive. Hold-until-answer is TODO.
      const result = yield* work.workRequestCreate(
        caller.canvasName,
        decoded.right.target,
        decoded.right.brief,
        decoded.right.metadata,
        raisedBy.right,
        decoded.right.reason,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      const task = mapped.right.value as {
        readonly id: string;
        readonly reason?: string;
      };
      const brief = decoded.right.brief.trim();
      const block = markSeatBlocked({
        canvasName: caller.canvasName,
        nodeId: caller.nodeId,
        requestId: task.id,
        target: decoded.right.target,
        brief,
      });
      const stop_directive = makeStopDirective({
        requestId: block.requestId,
        target: block.target,
        brief: block.brief,
      });
      return {
        request: mapped.right.value,
        disposition: mapped.right.disposition,
        blocked: true,
        stop_directive,
        // Hold-until-answer not implemented: agent must stop and resume later.
        hold: null,
        note: "seat blocked; stop work until the operator answers (hold-until-answer TODO)",
      };
    }

    if (op === "artifact.publish") {
      const decoded = decodeArgs(ArtifactPublishArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const parts = decoded.right.parts as Part[];
      const artifact: Artifact = {
        artifactId: decoded.right.artifactId?.trim() || ulid(),
        parts,
        ...(decoded.right.name !== undefined ? { name: decoded.right.name } : {}),
        ...(decoded.right.task !== undefined
          ? {
              task: {
                kind: "task",
                itemId: decoded.right.task.id,
                sink: {
                  canvasName: caller.canvasName,
                  nodeId: decoded.right.task.target,
                },
              },
            }
          : {}),
        ...(decoded.right.metadata !== undefined
          ? { metadata: decoded.right.metadata }
          : {}),
      };
      const publishedBy = resolveProcessBoundActorRef(
        read.actorRefs,
        caller,
      );
      if (Either.isLeft(publishedBy)) {
        return yield* Effect.fail(publishedBy.left);
      }
      const result = yield* work.workArtifactPublish(
        caller.canvasName,
        decoded.right.target,
        artifact,
        publishedBy.right,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      // Work control admits process-bound callers only. Renderer IPC publish
      // does not write stamps, so it cannot become a trust-plane side door.
      const authority = artifactPublishAuthority({
        canvasName: caller.canvasName,
        seat: caller.nodeId,
        occupant: caller.occupant,
        sinkNodeId: decoded.right.target,
      });
      const stamp = extractProofStamp(authority, mapped.right.value);
      if (stamp) {
        globalStampRuntime.recordStamp(authority, stamp);
      }
      return exposeWorkMutation(mapped.right);
    }

    if (op === "board.list") {
      const decoded = decodeArgs(BoardListArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const result = yield* work.workBoardList(
        caller.canvasName,
        decoded.right.target,
        decoded.right.topicId,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return {
        topics: mapped.right.value.topics,
      };
    }

    if (op === "board.create_topic") {
      const decoded = decodeArgs(BoardCreateTopicArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(bound)) return yield* Effect.fail(bound.left);
      const author = {
        kind: "actor" as const,
        seatId: bound.right.seatId,
        nodeId: bound.right.nodeId,
        label: caller.nodeId,
      };
      // Agents never wake the floor — notify flag ignored.
      const result = yield* work.workBoardCreateTopic(
        caller.canvasName,
        decoded.right.target,
        decoded.right.title,
        decoded.right.body,
        author,
        false,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "board.post") {
      const decoded = decodeArgs(BoardPostArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(bound)) return yield* Effect.fail(bound.left);
      const author = {
        kind: "actor" as const,
        seatId: bound.right.seatId,
        nodeId: bound.right.nodeId,
        label: caller.nodeId,
      };
      const result = yield* work.workBoardPost(
        caller.canvasName,
        decoded.right.target,
        decoded.right.topicId,
        decoded.right.text,
        author,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
    }

    if (op === "board.mark_read") {
      const decoded = decodeArgs(BoardMarkReadArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const bound = resolveProcessBoundActorRef(read.actorRefs, caller);
      if (Either.isLeft(bound)) return yield* Effect.fail(bound.left);
      const principalKey = `seat:${bound.right.seatId}`;
      const result = yield* work.workBoardMarkRead(
        caller.canvasName,
        decoded.right.target,
        decoded.right.topicId,
        principalKey,
        decoded.right.upToPosition,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return exposeWorkMutation(mapped.right);
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
      if (Either.isLeft(decoded)) {
        respond(
          socket,
          workErr("ProtocolError", decoded.left.message, {
            retryable: false,
            path: "request",
            hint: "request must be {token, op, args?}",
          }),
        );
        return;
      }

      const req = decoded.right;

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
                next_step: "launch Vellum Command, then `vellum doctor`",
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
                  ? "open the agent's terminal in Vellum Command so its process is registered"
                  : "ensure the CLI runs as a child of a live Vellum Command agent process",
              missing: "process-bind",
            },
            req.op,
            req.id,
          ),
        );
        return;
      }

      try {
        // Live authority resolve + dispatch are one retained operation so a hung
        // runtime (including liveDocuments) is visible to drainOnQuit as dispatch.
        const run = () =>
          retainOperation(
            "dispatch",
            `dispatch:${req.op}`,
            async (): Promise<Either.Either<WorkErrorBody, unknown>> => {
              let liveDocs: ReadonlyArray<{
                readonly canvasName: string;
                readonly doc: CanvasDoc;
              }>;
              try {
                liveDocs = await options.run(
                  Effect.flatMap(CanvasesService, (c) => c.liveDocuments()),
                );
              } catch {
                return Either.left({
                  type: "StaleNodeRef",
                  message: "live canvas authority is unavailable",
                  details: {
                    retryable: true,
                    next_step: "open Vellum Command and ensure canvases are loaded",
                  },
                });
              }
              const callerResolved = resolveCallerAcrossCanvases(
                liveDocs,
                admission.principal,
              );
              if (!callerResolved.ok) {
                return Either.left({
                  type:
                    callerResolved.code === "ambiguous"
                      ? "ScopeError"
                      : "StaleNodeRef",
                  message: callerResolved.message,
                  details: {
                    retryable: false,
                    next_step:
                      "ensure exactly one actor node matches the live process",
                  },
                });
              }
              const occupant =
                occupantKeyForPrincipal(
                  admission.principal,
                  `pid:${admission.peerPid}`,
                );
              const caller: WorkCaller = {
                canvasName: callerResolved.caller.canvasName,
                nodeId: callerResolved.caller.nodeId,
                workHome,
                occupant,
              };
              return options.run(
                dispatchOp(req.op, req.args, caller, options.version).pipe(
                  Effect.either,
                ),
              ) as Promise<Either.Either<WorkErrorBody, unknown>>;
            },
          );
        const authoringLabel = mainAuthoringLabelForWorkOperation(req.op);
        // Both read and authorial operations retain their actual runtime
        // promise even if this socket goes away before the response is written.
        // The main authoring gate remains the mutation authority; this
        // transport registry additionally supplies native-loop finality.
        const outcome = authoringLabel === undefined
          ? await run()
          : await authoringGate.run(authoringLabel, run);

        if (Either.isLeft(outcome)) {
          const body = outcome.left as WorkErrorBody;
          respond(
            socket,
            workErr(body.type, body.message, body.details, req.op, req.id),
          );
          return;
        }
        if (req.op === "preamble" && options.onPreamble) {
          const value = outcome.right as {
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
        respond(socket, workOk(req.op, outcome.right, req.id));
      } catch (error) {
        if (error instanceof MainAuthoringRefused) {
          respond(
            socket,
            workErr(
              "RuntimeDown",
              error.message,
              {
                retryable: false,
                next_step: "wait for Vellum Command shutdown to finish or restart Vellum Command",
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
      // Identity is lease-independent so Ctrl+C killing Darwin lockf still
      // allows close of the exact inode we bound.
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
  try {
    publishSystemdGenerationReadiness();
    liveWorkControlListeners.set(
      readinessAuthority,
      () =>
        !shuttingDown &&
        server.listening &&
        controlListenerLeaseHeld(listenerLease) &&
        ownsSocketPath(),
    );
  } catch (error) {
    withdrawReadiness();
    await closeListenerWithoutDeletingReplacement().catch(() => undefined);
    throw error;
  }

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
