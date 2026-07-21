import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { ulid } from "ulid";
import type { Artifact, Message, Part } from "@shared/canvas";
import {
  makeAgentMessage,
  makeUserMessage,
} from "@shared/a2a";
import { formatNodeRef } from "@shared/node-ref";
import {
  ArtifactPublishArgs,
  EmptyArgs,
  MsgListArgs,
  MsgSendArgs,
  RequestCreateArgs,
  TasksClaimArgs,
  TasksListArgs,
  TasksUpdateArgs,
  WORK_MAX_FRAME_BYTES,
  WORK_PROTOCOL_VERSION,
  WorkOpName,
  decodeWorkRequest,
  encodeWorkFrame,
  validateNodeRefString,
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
import { WorkService, type WorkOpResult } from "./service";
import {
  connectedCapabilities,
  containingRegion,
  findNode,
  kindAllowsOp,
  nodeKind,
  regionVisibility,
  requiresConnection,
  scopeError,
  summarizeNode,
  visibilityOf,
} from "./authz";

// Local work control plane for agents: NDJSON over a Unix domain socket at
// ~/.vellum/work/control.sock. Token + edge authorization; all mutations
// route through WorkService — this module is transport + authz only.

// ---------------------------------------------------------------------------
// Token rotation (browser control pattern)

export const resolveWorkHome = (home?: string, workHome?: string): string => {
  if (workHome && workHome.trim().length > 0) return workHome.trim();
  const env = process.env.VELLUM_WORK_HOME?.trim();
  if (env) return env;
  return workControlDir(home ?? homedir());
};

export const rotateWorkToken = (tokenPath: string): string => {
  const token = randomBytes(32).toString("hex");
  const temporaryPath = `${tokenPath}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, `${token}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, tokenPath);
    chmodSync(tokenPath, 0o600);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return token;
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
      return {
        type: "InvalidTransition",
        message,
        details: {
          from: m?.[1],
          to: m?.[2],
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
          next_step: "open the canvas in Vellum or fix the nodeRef canvas name",
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

const fromWorkResult = <T>(
  result: WorkOpResult<T>,
): Either.Either<T, WorkErrorBody> => {
  if (result.ok) return Either.right(result.data);
  return Either.left(mapWorkCode(result.code, result.message));
};

const decodeArgs = <A, I>(
  schema: Schema.Schema<A, I>,
  args: unknown,
): Either.Either<A, WorkErrorBody> => {
  const decoded = Schema.decodeUnknownEither(schema)(args ?? {});
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
  effect: Effect.Effect<A, E, WorkService | CanvasesService>,
) => Promise<A>;

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
        path: "nodeRef",
        received: nodeId,
        retryable: false,
        next_step: "refresh the board and use a live node id",
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
  const target = findNode(doc, targetId);
  if (!target) {
    // Invisible / unknown — do not leak existence for non-connected targets
    // when the id is simply missing; still UnknownTarget for honest misses
    // only if connected or region-visible would have shown it. Spec: ops on
    // non-connected fail ScopeError naming the missing edge.
    const vis = visibilityOf(doc, callerId, targetId);
    if (vis === "none") {
      return scopeError(callerId, targetId, "invisible");
    }
    return {
      type: "UnknownTarget",
      message: `target "${targetId}" not found`,
      details: { target: targetId, retryable: false },
    };
  }
  if (requiresConnection(op)) {
    const vis = visibilityOf(doc, callerId, targetId);
    if (vis !== "connected") {
      return scopeError(
        callerId,
        targetId,
        vis === "region" ? "not_connected" : "invisible",
      );
    }
  }
  const kind = nodeKind(target);
  if (!kindAllowsOp(kind, op)) {
    return scopeError(callerId, targetId, "wrong_kind", { kind, op });
  }
  return { node: target };
};

const dispatchOp = (
  op: WorkOp,
  args: unknown,
  caller: { readonly canvasName: string; readonly nodeId: string },
  version: string,
): Effect.Effect<unknown, WorkErrorBody, WorkService | CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const work = yield* WorkService;

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
      };
    }

    const read = yield* canvases.read(caller.canvasName).pipe(
      Effect.mapError(
        (e): WorkErrorBody => ({
          type: "StaleNodeRef",
          message: e.message,
          details: {
            retryable: false,
            next_step: "open the canvas in Vellum",
          },
        }),
      ),
    );
    const board = read.doc;
    const callerErr = ensureCaller(board, caller.nodeId);
    if (callerErr) return yield* Effect.fail(callerErr);

    if (op === "capabilities") {
      const self = findNode(board, caller.nodeId)!;
      return {
        node: summarizeNode(self),
        protocol_version: WORK_PROTOCOL_VERSION,
        connected: connectedCapabilities(board, caller.nodeId),
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
        region: region ?? null,
        connected: connected.map((c) => ({
          id: c.id,
          kind: c.kind,
          title: c.title,
          summary: c.summary,
        })),
        co_members: regionVisibility(board, caller.nodeId),
        capabilities: {
          protocol_version: WORK_PROTOCOL_VERSION,
          ops: connected.flatMap((c) => c.ops),
          connected,
        },
      };
    }

    if (op === "tasks.list") {
      const decoded = decodeArgs(TasksListArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const items = gate.node?.ether?.tasks?.items ?? [];
      return { target: decoded.right.target, items };
    }

    if (op === "tasks.claim") {
      const decoded = decodeArgs(TasksClaimArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const actor = (decoded.right.actor?.trim() || caller.nodeId).trim();
      const result = yield* work.workTaskClaim(
        caller.canvasName,
        decoded.right.target,
        decoded.right.task,
        actor,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return mapped.right;
    }

    if (op === "tasks.update") {
      const decoded = decodeArgs(TasksUpdateArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const result = yield* work.workTaskTransition(
        caller.canvasName,
        decoded.right.target,
        decoded.right.task,
        decoded.right.state,
        decoded.right.note,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return mapped.right;
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
      const role = decoded.right.role ?? "agent";
      const messageId = ulid();
      const contextId = caller.canvasName;
      const message: Message =
        role === "user"
          ? makeUserMessage({
              messageId,
              text,
              contextId,
              ...(decoded.right.taskId ? { taskId: decoded.right.taskId } : {}),
            })
          : makeAgentMessage({
              messageId,
              text,
              contextId,
              ...(decoded.right.taskId ? { taskId: decoded.right.taskId } : {}),
            });
      const result = yield* work.workMessageAppend(
        caller.canvasName,
        decoded.right.target,
        decoded.right.taskId ?? null,
        message,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return mapped.right;
    }

    if (op === "request.create") {
      const decoded = decodeArgs(RequestCreateArgs, args);
      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left);
      const gate = requireTarget(board, caller.nodeId, decoded.right.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const result = yield* work.workRequestCreate(
        caller.canvasName,
        decoded.right.target,
        decoded.right.brief,
        decoded.right.metadata,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return mapped.right;
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
        ...(decoded.right.taskId !== undefined ? { taskId: decoded.right.taskId } : {}),
        ...(decoded.right.metadata !== undefined
          ? { metadata: decoded.right.metadata }
          : {}),
      };
      const result = yield* work.workArtifactPublish(
        caller.canvasName,
        decoded.right.target,
        artifact,
      );
      const mapped = fromWorkResult(result);
      if (Either.isLeft(mapped)) return yield* Effect.fail(mapped.left);
      return mapped.right;
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
  close(): void;
}

export interface WorkControlServerOptions {
  readonly run: RunEffect;
  readonly version: string;
  readonly home?: string;
  readonly workHome?: string;
}

const unlinkSocket = (socketPath: string): void => {
  if (existsSync(socketPath)) unlinkSync(socketPath);
};

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
): Promise<WorkControlServer> => {
  const workHome = resolveWorkHome(options.home, options.workHome);
  mkdirSync(workHome, { recursive: true, mode: 0o700 });
  chmodSync(workHome, 0o700);

  const tokenPath = workControlTokenPath(workHome);
  const socketPath = workControlSocketPath(workHome);
  const token = rotateWorkToken(tokenPath);
  unlinkSocket(socketPath);

  const server: Server = createServer((socket) => {
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
      if (Either.isLeft(decoded)) {
        respond(
          socket,
          workErr("ProtocolError", decoded.left.message, {
            retryable: false,
            path: "request",
            hint: "request must be {token, nodeRef, op, args?}",
          }),
        );
        return;
      }

      const req = decoded.right;
      if (!workTokenMatches(req.token, token)) {
        respond(
          socket,
          workErr(
            "AuthError",
            "invalid or missing work control token",
            {
              retryable: true,
              next_step: "launch Vellum, then `vellum doctor`",
            },
            req.op,
            req.id,
          ),
        );
        return;
      }

      const nodeRef = validateNodeRefString(req.nodeRef);
      if (!nodeRef.ok) {
        respond(
          socket,
          workErr(
            nodeRef.error.type as WorkErrorType,
            nodeRef.error.message,
            nodeRef.error.details,
            req.op,
            req.id,
          ),
        );
        return;
      }

      try {
        const outcome = await options.run(
          dispatchOp(req.op, req.args, nodeRef.value, options.version).pipe(
            Effect.either,
          ),
        );

        if (Either.isLeft(outcome)) {
          const body = outcome.left;
          respond(
            socket,
            workErr(body.type, body.message, body.details, req.op, req.id),
          );
          return;
        }
        respond(socket, workOk(req.op, outcome.right, req.id));
      } catch (error) {
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
      if (closed) return;
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
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) break;
        const lineBuf = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        const line = lineBuf.toString("utf8").replace(/\r$/, "").trim();
        if (line.length === 0) continue;
        void handleLine(line);
      }
    });

    socket.on("error", () => {
      closed = true;
    });
    socket.on("close", () => {
      closed = true;
    });

    void WorkOpName;
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off("error", onError);
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // best-effort owner-only socket
      }
      resolveListen();
    });
  });

  return {
    socketPath,
    tokenPath,
    workHome,
    close: () => {
      try {
        server.close();
      } catch {
        // already closed
      }
      unlinkSocket(socketPath);
    },
  };
};
