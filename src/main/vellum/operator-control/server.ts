import { chmodSync, existsSync, lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolveVellumHome } from "@shared/vellum-home";
import {
  OPERATOR_MAX_REQUEST_BYTES,
  OPERATOR_MAX_RESPONSE_BYTES,
  decodeOperatorJsonLine,
  decodeOperatorRequest,
  encodeOperatorFrame,
  operatorControlDir,
  operatorControlSocketPath,
  type OperatorErrorResponse,
  type OperatorErrorType,
  type OperatorOpName,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "@shared/operator-control";
import { Either } from "effect";
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
import {
  admitOperatorPeer,
  type OperatorPeerAdmissionOptions,
} from "./admission";

export interface OperatorControlServerOptions {
  readonly dispatch: (
    request: OperatorRequestEnvelope,
  ) => Promise<OperatorResponseEnvelope>;
  readonly home?: string;
}

export interface OperatorControlServerRuntime {
  /** Tests may lower, never raise, product limits. */
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxActiveClients?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownDeadlineMs?: number;
  readonly admission?: OperatorPeerAdmissionOptions;
}

export interface OperatorControlShutdownReceipt {
  readonly clean: boolean;
  readonly pendingDispatches: number;
  readonly openSockets: number;
  readonly listenerRetained: boolean;
  readonly socketPathRetained: boolean;
  readonly retainedLabels: ReadonlyArray<string>;
}

export interface OperatorControlServer {
  readonly socketPath: string;
  readonly ready: () => boolean;
  /** Synchronous, monotonic admission cut. */
  readonly beginShutdown: () => void;
  /** Bounded and retryable; admitted dispatches are never cancelled. */
  readonly close: () => Promise<OperatorControlShutdownReceipt>;
}

const MAX_ACTIVE_CLIENTS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_DEADLINE_MS = 5_000;

interface OperatorPeer {
  phase: "receiving" | "admitted" | "responding";
  readonly closed: Promise<void>;
  readonly scrub: () => void;
}

interface DispatchFlight {
  readonly label: string;
  readonly promise: Promise<unknown>;
}

const bounded = (
  value: number | undefined,
  ceiling: number,
  minimum = 1,
): number =>
  value === undefined || !Number.isFinite(value) || value < minimum
    ? ceiling
    : Math.min(Math.floor(value), ceiling);

/**
 * Copies sensitive request bytes into a single owned buffer, then clears both
 * source buffers before returning. The caller owns and must eventually clear
 * the returned buffer.
 */
export const appendAndWipeOperatorBytes = (
  current: Buffer,
  incoming: Buffer,
): Buffer => {
  const next = Buffer.allocUnsafe(current.byteLength + incoming.byteLength);
  current.copy(next, 0);
  incoming.copy(next, current.byteLength);
  current.fill(0);
  incoming.fill(0);
  return next;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const operatorError = (
  type: OperatorErrorType,
  message: string,
  request?: Pick<OperatorRequestEnvelope, "id" | "op">,
): OperatorErrorResponse => ({
  protocol: "vellum-operator/v1",
  ...(request === undefined ? {} : { id: request.id, op: request.op }),
  ok: false,
  error: { type, message },
});

const safeFrame = (
  response: OperatorResponseEnvelope,
  maxResponseBytes: number,
): string | undefined => {
  try {
    return encodeOperatorFrame(response, maxResponseBytes);
  } catch {
    try {
      return encodeOperatorFrame(
        operatorError(
          "internal_error",
          "operator response exceeded the transport limit",
        ),
        maxResponseBytes,
      );
    } catch {
      return undefined;
    }
  }
};

export const startOperatorControlServer = async (
  options: OperatorControlServerOptions,
  runtime: OperatorControlServerRuntime = {},
): Promise<OperatorControlServer> => {
  const home = options.home ?? resolveVellumHome();
  const controlDir = operatorControlDir(home);
  const socketPath = operatorControlSocketPath(home);
  prepareControlDirectory(controlDir);
  const listenerLease = await acquireControlListenerLease(socketPath);
  try {
    await removeObservedSocket(listenerLease);
  } catch (error) {
    await releaseControlListenerLease(listenerLease);
    throw error;
  }

  const maxRequestBytes = bounded(
    runtime.maxRequestBytes,
    OPERATOR_MAX_REQUEST_BYTES,
    256,
  );
  const maxResponseBytes = bounded(
    runtime.maxResponseBytes,
    OPERATOR_MAX_RESPONSE_BYTES,
    256,
  );
  const maxActiveClients = bounded(
    runtime.maxActiveClients,
    MAX_ACTIVE_CLIENTS,
  );
  const requestTimeoutMs = bounded(
    runtime.requestTimeoutMs,
    REQUEST_TIMEOUT_MS,
  );
  const shutdownDeadlineMs = bounded(
    runtime.shutdownDeadlineMs,
    SHUTDOWN_DEADLINE_MS,
    10,
  );

  const peers = new Map<Socket, OperatorPeer>();
  const dispatches = new Set<DispatchFlight>();
  const responses = new WeakMap<Socket, Promise<void>>();
  let shuttingDown = false;
  let socketIdentity: ControlSocketPathIdentity | undefined;
  let cleanupBlocked = false;
  let listenerCloseFlight: Promise<void> | undefined;
  let closeFlight: Promise<OperatorControlShutdownReceipt> | undefined;

  const retainDispatch = (
    request: OperatorRequestEnvelope,
  ): Promise<OperatorResponseEnvelope> => {
    let resolveWitness!: (value: OperatorResponseEnvelope) => void;
    let rejectWitness!: (error: unknown) => void;
    const witness = new Promise<OperatorResponseEnvelope>((resolve, reject) => {
      resolveWitness = resolve;
      rejectWitness = reject;
    });
    void witness.catch(() => undefined);
    const flight: DispatchFlight = {
      label: `dispatch:${request.op}`,
      promise: witness,
    };
    dispatches.add(flight);

    let operation: Promise<OperatorResponseEnvelope>;
    try {
      operation = Promise.resolve(options.dispatch(request));
    } catch (error) {
      operation = Promise.reject(error);
    }
    void operation.then(resolveWitness, rejectWitness);
    void witness.then(
      () => dispatches.delete(flight),
      () => dispatches.delete(flight),
    );
    return witness;
  };

  const send = (
    socket: Socket,
    response: OperatorResponseEnvelope,
  ): Promise<void> => {
    const existing = responses.get(socket);
    if (existing !== undefined) return existing;
    const peer = peers.get(socket);
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
    responses.set(socket, closed);
    if (socket.destroyed) return closed;
    const frame = safeFrame(response, maxResponseBytes);
    if (frame === undefined) {
      socket.destroy();
      return closed;
    }
    try {
      socket.end(frame, () => {
        // One request, one response. Retire the readable half after the frame
        // is flushed so allowHalfOpen cannot retain a peer indefinitely.
        if (!socket.destroyed) socket.destroy();
      });
    } catch {
      socket.destroy();
    }
    return closed;
  };

  // The CLI half-closes its write side after one frame. Keep the server's
  // response side open until the admitted async dispatch explicitly ends it.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    const scrubBuffer = (): void => {
      buffer.fill(0);
      buffer = Buffer.alloc(0);
    };
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const peer: OperatorPeer = {
      phase: "receiving",
      closed,
      scrub: scrubBuffer,
    };
    const atCapacity = peers.size >= maxActiveClients;
    peers.set(socket, peer);
    socket.once("close", () => {
      scrubBuffer();
      peers.delete(socket);
      resolveClosed();
    });
    socket.on("error", () => undefined);

    if (shuttingDown || atCapacity) {
      void send(
        socket,
        operatorError(
          "runtime_down",
          shuttingDown
            ? "operator control is shutting down"
            : "operator control peer limit reached",
        ),
      );
      return;
    }

    const admission = admitOperatorPeer(socket, runtime.admission);
    if (!admission.ok) {
      void send(
        socket,
        operatorError("forbidden", "operator control peer is not admitted"),
      );
      return;
    }

    let handled = false;
    socket.setTimeout(requestTimeoutMs);

    const fail = (
      type: OperatorErrorType,
      message: string,
      request?: Pick<OperatorRequestEnvelope, "id" | "op">,
    ): void => {
      scrubBuffer();
      if (handled) {
        socket.destroy();
        return;
      }
      handled = true;
      socket.setTimeout(0);
      void send(socket, operatorError(type, message, request));
    };

    const handleFrame = async (lineBytes: Buffer): Promise<void> => {
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true })
          .decode(lineBytes)
          .replace(/\r$/u, "");
      } catch {
        await send(
          socket,
          operatorError("protocol_error", "invalid operator request"),
        );
        return;
      } finally {
        lineBytes.fill(0);
      }
      const json = decodeOperatorJsonLine(line);
      if (Either.isLeft(json)) {
        await send(
          socket,
          operatorError("protocol_error", "invalid operator request"),
        );
        return;
      }
      const decoded = decodeOperatorRequest(json.right);
      if (Either.isLeft(decoded)) {
        // Effect ParseError may embed the submitted password. Never surface it.
        await send(
          socket,
          operatorError("protocol_error", "invalid operator request"),
        );
        return;
      }

      try {
        const response = await retainDispatch(decoded.right);
        await send(socket, response);
      } catch {
        await send(
          socket,
          operatorError(
            "internal_error",
            "operator request failed",
            decoded.right,
          ),
        );
      }
    };

    socket.on("timeout", () => {
      fail("protocol_error", "operator request timed out");
    });
    socket.on("data", (chunk: Buffer) => {
      if (shuttingDown) {
        chunk.fill(0);
        scrubBuffer();
        if (!handled) {
          fail("shutdown", "operator control is shutting down");
        }
        return;
      }
      if (handled) {
        chunk.fill(0);
        if (chunk.byteLength > 0) socket.destroy();
        return;
      }
      if (buffer.byteLength + chunk.byteLength > maxRequestBytes) {
        chunk.fill(0);
        fail("protocol_error", "operator request exceeded the transport limit");
        return;
      }
      buffer = appendAndWipeOperatorBytes(buffer, chunk);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (buffer.byteLength !== newline + 1) {
        fail(
          "protocol_error",
          "send exactly one NDJSON request per connection",
        );
        return;
      }
      if (shuttingDown) {
        fail("shutdown", "operator control is shutting down");
        return;
      }
      handled = true;
      peer.phase = "admitted";
      socket.setTimeout(0);
      const lineBytes = Buffer.allocUnsafe(newline);
      buffer.copy(lineBytes, 0, 0, newline);
      scrubBuffer();
      void handleFrame(lineBytes).catch(() => {
        void send(
          socket,
          operatorError("internal_error", "operator request failed"),
        );
      });
    });
    socket.on("end", () => {
      if (!handled && !shuttingDown) {
        fail(
          "protocol_error",
          "operator request ended before a complete frame",
        );
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
            const uid =
              typeof process.getuid === "function"
                ? BigInt(process.getuid())
                : hardened.uid;
            if (
              !hardened.isSocket() ||
              hardened.isSymbolicLink() ||
              hardened.uid !== uid ||
              (hardened.mode & 0o777n) !== 0o600n ||
              !controlSocketPathOwnedByLease(listenerLease, socketIdentity)
            ) {
              throw new Error(
                "operator control socket could not be hardened owner-only",
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
  server.on("error", () => {
    console.error("[operator-control] listener error");
  });

  const pathMatchesIdentity = (): boolean => {
    if (socketIdentity === undefined) return false;
    try {
      const current = lstatSync(socketPath, { bigint: true });
      return (
        current.isSocket() &&
        !current.isSymbolicLink() &&
        current.dev === socketIdentity.dev &&
        current.ino === socketIdentity.ino &&
        current.uid === socketIdentity.uid
      );
    } catch {
      return false;
    }
  };

  const closeOwnedListener = async (): Promise<void> => {
    if (existsSync(socketPath) && !pathMatchesIdentity()) {
      cleanupBlocked = true;
      server.unref();
      throw new Error(
        "refusing to close operator listener over a replacement path",
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
      cleanupBlocked = false;
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
    const flight = closeOwnedListener();
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
    for (const [socket, peer] of peers) {
      if (peer.phase === "receiving") {
        peer.scrub();
        void send(
          socket,
          operatorError("shutdown", "operator control is shutting down"),
        );
      }
    }
  };

  const receipt = (): OperatorControlShutdownReceipt => {
    const listenerRetained =
      server.listening ||
      listenerCloseFlight !== undefined ||
      controlListenerLeaseHeld(listenerLease);
    const socketPathRetained = pathMatchesIdentity() || cleanupBlocked;
    const labels = new Set([...dispatches].map((flight) => flight.label));
    if (peers.size > 0) labels.add("socket");
    if (listenerRetained) labels.add("listener");
    if (socketPathRetained) labels.add("socket-path");
    const clean =
      dispatches.size === 0 &&
      peers.size === 0 &&
      !listenerRetained &&
      !socketPathRetained;
    return Object.freeze({
      clean,
      pendingDispatches: dispatches.size,
      openSockets: peers.size,
      listenerRetained,
      socketPathRetained,
      retainedLabels: Object.freeze([...labels].sort()),
    });
  };

  const settleWithin = (
    promises: ReadonlyArray<Promise<unknown>>,
    timeoutMs: number,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          resolve(false);
        },
        Math.max(1, timeoutMs),
      );
      void Promise.allSettled(promises).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });

  const runDrain = async (): Promise<OperatorControlShutdownReceipt> => {
    const deadline = Date.now() + shutdownDeadlineMs;
    for (;;) {
      const current = receipt();
      if (current.clean) return current;
      const witnesses = [
        ...[...dispatches].map((flight) => flight.promise),
        ...[...peers.values()].map((peer) => peer.closed),
        ...(listenerCloseFlight === undefined ? [] : [listenerCloseFlight]),
      ];
      if (witnesses.length === 0) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (!(await settleWithin(witnesses, remaining))) break;
      await Promise.resolve();
    }

    for (const [socket, peer] of peers) {
      if (peer.phase === "receiving" && !socket.destroyed) socket.destroy();
    }
    await Promise.resolve();
    return receipt();
  };

  const close = (): Promise<OperatorControlShutdownReceipt> => {
    if (closeFlight !== undefined) return closeFlight;
    const published = (async () => {
      beginShutdown();
      ensureListenerClose();
      return runDrain();
    })();
    closeFlight = published;
    void published.finally(() => {
      if (closeFlight === published) closeFlight = undefined;
    });
    return published;
  };

  return {
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
