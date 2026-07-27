import { chmodSync, existsSync, lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { Effect, Either, Schema } from "effect";
import {
  MainAuthoringRefused,
  mainAuthoringGate,
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
import { CanvasesService, type CanvasError } from "../canvases";
import {
  getProcessIdentityMap,
  readParentPid as readSystemParentPid,
  readUnixPeerPid,
  type PeerPidReader,
  type ProcessIdentityMap,
} from "../process-identity";
import { SettingsService } from "../settings/service";
import { SnapshotsService } from "../snapshots";
import {
  CANVAS_CONTROL_MAX_REQUEST_BYTES,
  CANVAS_CONTROL_MAX_RESPONSE_BYTES,
  CANVAS_CONTROL_HOME_ENV,
  CanvasControlListArgs,
  CanvasControlReadArgs,
  CanvasControlRemoveArgs,
  canvasControlDir,
  canvasControlErr,
  canvasControlOk,
  canvasControlSocketPath,
  decodeCanvasControlRequest,
  encodeCanvasControlFrame,
  type CanvasControlErrorCode,
  type CanvasControlOp,
  type CanvasControlRequestEnvelope,
  type CanvasControlResponseEnvelope,
} from "./protocol";

type CanvasControlServices =
  | CanvasesService
  | SettingsService
  | SnapshotsService;

export type RunCanvasControlEffect = <A, E>(
  effect: Effect.Effect<A, E, CanvasControlServices>,
) => Promise<A>;

export interface CanvasControlServerOptions {
  readonly run: RunCanvasControlEffect;
  readonly home?: string;
  readonly controlHome?: string;
  /** Test seam; production shares the process-global main authoring gate. */
  readonly authoringGate?: MainAuthoringGate;
  /** Test seams; production uses the shared registry and sealed peer reader. */
  readonly processMap?: ProcessIdentityMap;
  readonly readPeerPid?: PeerPidReader;
  readonly readParentPid?: (pid: number) => number | undefined;
}

export interface CanvasControlServerRuntime {
  /** Tests may lower, never raise, the product frame bounds. */
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Tests may lower, never raise, the accepted peer ceiling. */
  readonly maxActiveClients?: number;
  /** Tests may lower, never raise, the idle request deadline. */
  readonly requestTimeoutMs?: number;
  /** Tests may lower, never raise, the bounded quit drain. */
  readonly shutdownDeadlineMs?: number;
}

export interface CanvasControlShutdownReceipt {
  readonly clean: boolean;
  readonly pendingFrames: number;
  readonly pendingDispatches: number;
  readonly openSockets: number;
  readonly listenerRetained: boolean;
  readonly socketPathRetained: boolean;
  readonly retainedLabels: ReadonlyArray<string>;
}

export interface CanvasControlServer {
  readonly controlHome: string;
  readonly socketPath: string;
  readonly ready: () => boolean;
  /** Synchronously closes admission before asynchronous listener teardown. */
  readonly beginShutdown: () => void;
  /** Bounded, retryable fixed-point drain for admitted work and owned resources. */
  readonly close: () => Promise<CanvasControlShutdownReceipt>;
}

const MAX_ACTIVE_CLIENTS = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_DEADLINE_MS = 5_000;
const AUTHORIAL_ANCESTRY_MAX_DEPTH = 64;

type CanvasControlFlightKind = "frame" | "dispatch" | "listener-close";

interface CanvasControlFlight {
  readonly kind: CanvasControlFlightKind;
  readonly label: string;
  readonly promise: Promise<unknown>;
}

interface CanvasControlPeer {
  phase: "receiving" | "admitted" | "responding";
  readonly closed: Promise<void>;
}

const boundedRuntimeValue = (
  value: number | undefined,
  ceiling: number,
  minimum = 1,
): number =>
  value === undefined || !Number.isFinite(value) || value < minimum
    ? ceiling
    : Math.min(Math.floor(value), ceiling);

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const decodeArgs = <A, I>(
  schema: Schema.Schema<A, I>,
  args: unknown,
):
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string } => {
  const decoded = Schema.decodeUnknownEither(schema, {
    onExcessProperty: "error",
  })(args ?? {});
  return Either.isRight(decoded)
    ? { ok: true, value: decoded.right }
    : { ok: false, message: decoded.left.message };
};

const canvasFailure = (
  error: unknown,
): {
  readonly code: CanvasControlErrorCode;
  readonly message: string;
  readonly retryable: boolean;
} => {
  if (error instanceof MainAuthoringRefused) {
    return {
      code: "AuthoringClosed",
      message: error.message,
      retryable: true,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "CanvasError"
  ) {
    return {
      code: "CanvasError",
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "canvas operation failed",
      retryable: false,
    };
  }
  return {
    code: "InternalError",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
};

const listEffect = Effect.gen(function* () {
  const canvases = yield* CanvasesService;
  const summaries = yield* canvases.list;
  return yield* Effect.forEach(
    summaries,
    (summary) =>
      canvases.read(summary.name).pipe(
        Effect.map((read) => ({
          name: read.name,
          modifiedAt: summary.modifiedAt,
          nodes: read.doc.nodes.length,
          edges: read.doc.edges.length,
        })),
      ),
    { concurrency: 5 },
  );
});

const readEffect = (name: string) =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const snapshots = yield* SnapshotsService;
    const result = yield* Effect.all({
      read: canvases.read(name),
      snapshots: snapshots.current,
    });
    return {
      name: result.read.name,
      revision: result.read.revision,
      doc: result.read.doc,
      snapshots: result.snapshots,
    };
  });

const removeEffect = (name: string) =>
  Effect.flatMap(CanvasesService, (canvases) => canvases.remove(name));

const commandCenterAuthorialAdmission = Effect.gen(function* () {
  const settings = yield* SettingsService;
  const current = yield* settings.get;
  if (current.station.role === "command-center") {
    return { allowed: true as const };
  }
  return {
    allowed: false as const,
    message:
      current.station.role === "remote"
        ? "Remote stations cannot remove authorial canvases"
        : "station role is unset or untrusted; canvas removal requires a Command Center",
  };
});

const admitUnboundOperatorProcess = (input: {
  readonly peerPid: number;
  readonly processMap: ProcessIdentityMap;
  readonly readParentPid: (pid: number) => number | undefined;
}):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly message: string } => {
  let current = input.peerPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < AUTHORIAL_ANCESTRY_MAX_DEPTH; depth += 1) {
    if (!Number.isSafeInteger(current) || current <= 0 || seen.has(current)) {
      return {
        allowed: false,
        message: "canvas removal could not prove a stable operator process ancestry",
      };
    }
    seen.add(current);
    if (input.processMap.resolve(current) !== undefined) {
      return {
        allowed: false,
        message: "attached agent processes cannot remove authorial canvases",
      };
    }
    if (current === 1) return { allowed: true };
    const parent = input.readParentPid(current);
    if (parent === undefined || parent >= current) {
      return {
        allowed: false,
        message: "canvas removal could not prove the local operator process ancestry",
      };
    }
    current = parent;
  }
  return {
    allowed: false,
    message: "canvas removal process ancestry exceeded the safety bound",
  };
};

export const startCanvasControlServer = async (
  options: CanvasControlServerOptions,
  runtime: CanvasControlServerRuntime = {},
): Promise<CanvasControlServer> => {
  const controlHome =
    options.controlHome?.trim() ||
    process.env[CANVAS_CONTROL_HOME_ENV]?.trim() ||
    canvasControlDir(options.home ?? homedir());
  prepareControlDirectory(controlHome);
  const socketPath = canvasControlSocketPath(controlHome);
  const listenerLease = await acquireControlListenerLease(socketPath);
  try {
    await removeObservedSocket(listenerLease);
  } catch (error) {
    await releaseControlListenerLease(listenerLease);
    throw error;
  }

  const maxRequestBytes = boundedRuntimeValue(
    runtime.maxRequestBytes,
    CANVAS_CONTROL_MAX_REQUEST_BYTES,
    256,
  );
  const maxResponseBytes = boundedRuntimeValue(
    runtime.maxResponseBytes,
    CANVAS_CONTROL_MAX_RESPONSE_BYTES,
    256,
  );
  const maxActiveClients = boundedRuntimeValue(
    runtime.maxActiveClients,
    MAX_ACTIVE_CLIENTS,
  );
  const requestTimeoutMs = boundedRuntimeValue(
    runtime.requestTimeoutMs,
    REQUEST_TIMEOUT_MS,
  );
  const shutdownDeadlineMs = boundedRuntimeValue(
    runtime.shutdownDeadlineMs,
    SHUTDOWN_DEADLINE_MS,
    10,
  );
  const authoringGate = options.authoringGate ?? mainAuthoringGate;
  const processMap = options.processMap ?? getProcessIdentityMap();
  const readPeerPid = options.readPeerPid ?? readUnixPeerPid;
  const readParentPid = options.readParentPid ?? readSystemParentPid;
  const sockets = new Map<Socket, CanvasControlPeer>();
  const flights = new Set<CanvasControlFlight>();
  const responseFlights = new WeakMap<Socket, Promise<void>>();
  let shuttingDown = false;
  let socketIdentity: ControlSocketPathIdentity | undefined;
  let socketPathCleanupBlocked = false;
  let listenerCloseFlight: Promise<void> | undefined;
  let closeFlight: Promise<CanvasControlShutdownReceipt> | undefined;

  const retainOperation = <A>(
    kind: CanvasControlFlightKind,
    label: string,
    operation: () => Promise<A>,
  ): Promise<A> => {
    // Publish before invoking caller-controlled code. `options.run` may
    // synchronously re-enter shutdown before returning its promise.
    let resolveWitness!: (value: A) => void;
    let rejectWitness!: (error: unknown) => void;
    const witness = new Promise<A>((resolve, reject) => {
      resolveWitness = resolve;
      rejectWitness = reject;
    });
    void witness.catch(() => undefined);
    const flight: CanvasControlFlight = {
      kind,
      label,
      promise: witness,
    };
    flights.add(flight);

    let operationFlight: Promise<A>;
    try {
      operationFlight = Promise.resolve(operation());
    } catch (error) {
      operationFlight = Promise.reject(error);
    }
    void operationFlight.then(resolveWitness, rejectWitness);
    void witness.then(
      () => flights.delete(flight),
      () => flights.delete(flight),
    );
    return witness;
  };

  const send = (
    socket: Socket,
    envelope: CanvasControlResponseEnvelope,
  ): Promise<void> => {
    const existing = responseFlights.get(socket);
    if (existing !== undefined) return existing;
    const peer = sockets.get(socket);
    if (peer !== undefined) peer.phase = "responding";
    const closed =
      peer?.closed ??
      new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
      });
    responseFlights.set(socket, closed);
    if (socket.destroyed) return closed;
    let frame = encodeCanvasControlFrame(envelope);
    if (Buffer.byteLength(frame, "utf8") > maxResponseBytes) {
      frame = encodeCanvasControlFrame(
        canvasControlErr(
          "ResponseTooLarge",
          `canvas control response exceeds ${String(maxResponseBytes)} bytes`,
          false,
          envelope.op,
          envelope.id,
        ),
      );
    }
    if (Buffer.byteLength(frame, "utf8") > maxResponseBytes) {
      socket.destroy();
      return closed;
    }
    try {
      socket.end(frame);
    } catch {
      socket.destroy();
    }
    return closed;
  };

  const dispatch = async (
    request: CanvasControlRequestEnvelope,
    socket: Socket,
  ): Promise<CanvasControlResponseEnvelope> => {
    try {
      if (request.op === "list") {
        const args = decodeArgs(CanvasControlListArgs, request.args);
        if (!args.ok) {
          return canvasControlErr(
            "InputError",
            args.message,
            false,
            request.op,
            request.id,
          );
        }
        return canvasControlOk(
          request.op,
          await options.run(listEffect),
          request.id,
        );
      }
      if (request.op === "read") {
        const args = decodeArgs(CanvasControlReadArgs, request.args);
        if (!args.ok) {
          return canvasControlErr(
            "InputError",
            args.message,
            false,
            request.op,
            request.id,
          );
        }
        return canvasControlOk(
          request.op,
          await options.run(readEffect(args.value.name)),
          request.id,
        );
      }

      const args = decodeArgs(CanvasControlRemoveArgs, request.args);
      if (!args.ok) {
        return canvasControlErr(
          "InputError",
          args.message,
          false,
          request.op,
          request.id,
        );
      }
      if (args.value.authorialWrite !== true) {
        return canvasControlErr(
          "AuthorialWriteDenied",
          "canvas removal requires the explicit operator authorial-write witness",
          false,
          request.op,
          request.id,
        );
      }
      const peerPid = readPeerPid(socket);
      if (peerPid === undefined) {
        return canvasControlErr(
          "AuthorialWriteDenied",
          "canvas removal could not attribute the local operator process",
          false,
          request.op,
          request.id,
        );
      }
      const operator = admitUnboundOperatorProcess({
        peerPid,
        processMap,
        readParentPid,
      });
      if (!operator.allowed) {
        return canvasControlErr(
          "AuthorialWriteDenied",
          operator.message,
          false,
          request.op,
          request.id,
        );
      }
      const station = await options.run(commandCenterAuthorialAdmission);
      if (!station.allowed) {
        return canvasControlErr(
          "AuthorialWriteDenied",
          station.message,
          false,
          request.op,
          request.id,
        );
      }
      const removed = await authoringGate.run("control.canvas.remove", () =>
        options.run(removeEffect(args.value.name)),
      );
      return canvasControlOk(request.op, removed, request.id);
    } catch (error) {
      const failure = canvasFailure(error as CanvasError);
      return canvasControlErr(
        failure.code,
        failure.message,
        failure.retryable,
        request.op,
        request.id,
      );
    }
  };

  const server = createServer((socket) => {
    const atCapacity = sockets.size >= maxActiveClients;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const peer: CanvasControlPeer = {
      phase: "receiving",
      closed,
    };
    sockets.set(socket, peer);
    socket.once("close", () => {
      sockets.delete(socket);
      resolveClosed();
    });
    socket.on("error", () => undefined);

    if (shuttingDown || atCapacity) {
      void send(
        socket,
        canvasControlErr(
          "RuntimeDown",
          shuttingDown
            ? "canvas control is shutting down"
            : "canvas control peer limit reached",
          true,
        ),
      );
      return;
    }

    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(requestTimeoutMs);

    const protocolFailure = (message: string): void => {
      if (handled) {
        socket.destroy();
        return;
      }
      handled = true;
      socket.setTimeout(0);
      void send(socket, canvasControlErr("ProtocolError", message, false));
    };

    const handleFrame = async (lineBytes: Buffer): Promise<void> => {
      let raw: unknown;
      try {
        const line = new TextDecoder("utf-8", { fatal: true })
          .decode(lineBytes)
          .replace(/\r$/, "")
          .trim();
        raw = JSON.parse(line) as unknown;
      } catch {
        await send(
          socket,
          canvasControlErr("ProtocolError", "malformed JSON frame", false),
        );
        return;
      }
      const decoded = decodeCanvasControlRequest(raw);
      if (Either.isLeft(decoded)) {
        await send(
          socket,
          canvasControlErr("ProtocolError", decoded.left.message, false),
        );
        return;
      }
      try {
        const response = await retainOperation(
          "dispatch",
          `dispatch:${decoded.right.op}`,
          () => dispatch(decoded.right, socket),
        );
        await send(socket, response);
      } catch {
        await send(
          socket,
          canvasControlErr(
            "InternalError",
            "canvas control dispatch failed",
            false,
            decoded.right.op,
            decoded.right.id,
          ),
        );
      }
    };

    socket.on("timeout", () => {
      protocolFailure("canvas control request timed out");
    });
    socket.on("data", (chunk: Buffer) => {
      if (shuttingDown) {
        buffer = Buffer.alloc(0);
        if (!handled) {
          handled = true;
          socket.setTimeout(0);
          void send(
            socket,
            canvasControlErr(
              "RuntimeDown",
              "canvas control is shutting down",
              true,
            ),
          );
        }
        return;
      }
      if (handled) {
        if (chunk.toString("utf8").trim().length > 0) socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > maxRequestBytes) {
        protocolFailure(
          `canvas control request exceeds ${String(maxRequestBytes)} bytes`,
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const trailing = buffer.subarray(newline + 1).toString("utf8").trim();
      if (trailing.length > 0) {
        protocolFailure("send exactly one NDJSON request per connection");
        return;
      }
      // This is the admission cut: a complete frame is retained before any
      // parser, identity reader, service runner, or other caller seam runs.
      if (shuttingDown) {
        protocolFailure("canvas control is shutting down");
        return;
      }
      handled = true;
      peer.phase = "admitted";
      socket.setTimeout(0);
      const lineBytes = buffer.subarray(0, newline);
      buffer = Buffer.alloc(0);
      const frame = retainOperation("frame", "frame", () =>
        handleFrame(lineBytes),
      );
      void frame.catch(() => {
        void send(
          socket,
          canvasControlErr(
            "InternalError",
            "canvas control frame failed",
            false,
          ),
        );
      });
    });
    socket.on("end", () => {
      if (!handled && !shuttingDown) {
        protocolFailure("canvas control request ended before a complete frame");
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(
        { path: socketPath, readableAll: false, writableAll: false },
        () => {
          server.off("error", onError);
          try {
            socketIdentity = captureControlSocketPathIdentity(listenerLease);
            chmodSync(socketPath, 0o600);
            const hardened = lstatSync(socketPath, { bigint: true });
            const currentUid =
              typeof process.getuid === "function"
                ? BigInt(process.getuid())
                : hardened.uid;
            if (
              !hardened.isSocket() ||
              hardened.isSymbolicLink() ||
              hardened.uid !== currentUid ||
              (hardened.mode & 0o777n) !== 0o600n ||
              !controlSocketPathOwnedByLease(
                listenerLease,
                socketIdentity as ControlSocketPathIdentity,
              )
            ) {
              throw new Error(
                "canvas control socket could not be hardened owner-only",
              );
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      );
    });
  } catch (error) {
    await closeServer(server);
    await releaseControlListenerLease(listenerLease);
    throw error;
  }

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

  const closeListenerWithoutDeletingReplacement = async (): Promise<void> => {
    if (existsSync(socketPath) && !pathMatchesCapturedIdentity()) {
      // Node/libuv may unlink a replacement directory entry while closing the
      // originally-bound Unix listener. Preserve the foreign path and retry
      // only after a later explicit drain observes our inode again.
      socketPathCleanupBlocked = true;
      server.unref();
      throw new Error(
        "refusing to close canvas control listener over a replacement path",
      );
    }
    await closeServer(server);
    try {
      if (
        socketIdentity !== undefined &&
        controlListenerLeaseHeld(listenerLease) &&
        existsSync(socketPath)
      ) {
        removeOwnedControlSocketPath(listenerLease, socketIdentity);
      }
      socketPathCleanupBlocked = false;
    } finally {
      if (controlListenerLeaseHeld(listenerLease)) {
        await releaseControlListenerLease(listenerLease);
      }
    }
  };

  const ensureListenerClose = (): void => {
    if (
      listenerCloseFlight !== undefined ||
      (!server.listening && !controlListenerLeaseHeld(listenerLease))
    ) {
      return;
    }
    const flight = retainOperation(
      "listener-close",
      "listener",
      closeListenerWithoutDeletingReplacement,
    );
    listenerCloseFlight = flight;
    void flight.then(
      () => {
        if (listenerCloseFlight === flight) listenerCloseFlight = undefined;
      },
      () => {
        if (listenerCloseFlight === flight) listenerCloseFlight = undefined;
      },
    );
  };

  const beginShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ensureListenerClose();
    for (const [socket, peer] of sockets) {
      if (peer.phase === "receiving") {
        void send(
          socket,
          canvasControlErr(
            "RuntimeDown",
            "canvas control is shutting down",
            true,
          ),
        );
      }
    }
  };

  const retainedReceipt = (): CanvasControlShutdownReceipt => {
    const pendingFrames = [...flights].filter(
      (flight) => flight.kind === "frame",
    ).length;
    const pendingDispatches = [...flights].filter(
      (flight) => flight.kind === "dispatch",
    ).length;
    const listenerRetained =
      server.listening ||
      listenerCloseFlight !== undefined ||
      controlListenerLeaseHeld(listenerLease);
    const socketPathRetained =
      pathMatchesCapturedIdentity() || socketPathCleanupBlocked;
    const retainedLabels = new Set([...flights].map((flight) => flight.label));
    if (sockets.size > 0) retainedLabels.add("socket");
    if (listenerRetained) retainedLabels.add("listener");
    if (socketPathRetained) retainedLabels.add("socket-path");
    const clean =
      pendingFrames === 0 &&
      pendingDispatches === 0 &&
      sockets.size === 0 &&
      !listenerRetained &&
      !socketPathRetained;
    return Object.freeze({
      clean,
      pendingFrames,
      pendingDispatches,
      openSockets: sockets.size,
      listenerRetained,
      socketPathRetained,
      retainedLabels: Object.freeze([...retainedLabels].sort()),
    });
  };

  const settleWithin = (
    promises: ReadonlyArray<Promise<unknown>>,
    timeoutMs: number,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, Math.max(1, timeoutMs));
      void Promise.allSettled(promises).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });

  const runDrain = async (): Promise<CanvasControlShutdownReceipt> => {
    const deadline = Date.now() + shutdownDeadlineMs;
    for (;;) {
      const receipt = retainedReceipt();
      if (receipt.clean) return receipt;
      const witnesses = [
        ...[...flights].map((flight) => flight.promise),
        ...[...sockets.values()].map((peer) => peer.closed),
      ];
      if (witnesses.length === 0) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const settled = await settleWithin(witnesses, remainingMs);
      if (!settled) break;
      // A settling frame can publish its nested dispatch in a continuation.
      // Give that continuation a native promise turn before testing the fixed
      // point rather than trusting one snapshot.
      await Promise.resolve();
    }

    for (const socket of sockets.keys()) {
      if (!socket.destroyed) socket.destroy();
    }
    await Promise.resolve();
    return retainedReceipt();
  };

  const close = (): Promise<CanvasControlShutdownReceipt> => {
    if (closeFlight !== undefined) return closeFlight;
    let resolveClose!: (receipt: CanvasControlShutdownReceipt) => void;
    let rejectClose!: (error: unknown) => void;
    const published = new Promise<CanvasControlShutdownReceipt>(
      (resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      },
    );
    closeFlight = published;
    void published.then(
      () => {
        if (closeFlight === published) closeFlight = undefined;
      },
      () => {
        if (closeFlight === published) closeFlight = undefined;
      },
    );

    try {
      beginShutdown();
      // A prior bounded attempt may have preserved a replacement path. Each
      // explicit close gets one fresh ownership check and cleanup attempt.
      ensureListenerClose();
      void runDrain().then(resolveClose, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return published;
  };

  return {
    controlHome,
    socketPath,
    ready: () =>
      !shuttingDown &&
      server.listening &&
      socketIdentity !== undefined &&
      controlListenerLeaseHeld(listenerLease) &&
      controlSocketPathOwnedByLease(listenerLease, socketIdentity),
    beginShutdown,
    close,
  };
};
