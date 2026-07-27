import {
  chmodSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { Either } from "effect";
import {
  decodeStationControlRequest,
  stationControlErr,
  type StationControlEnvelope,
} from "@shared/station-api-envelope";
import {
  STATION_CONTROL_MAX_CLIENTS,
  STATION_CONTROL_MAX_FRAME_BYTES,
  STATION_CONTROL_HOME_ENV,
  STATION_CONTROL_REQUEST_TIMEOUT_MS,
  encodeStationControlFrame,
  stationControlDir,
  stationControlSocketPath,
} from "@shared/station-ssh-control";
import type {
  StationApiRequest,
  StationReadiness,
} from "@shared/station-api";
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
// OpenSSH local-socket transport adapter for the Station API.
// Framing + peer authority live here; request execution goes through
// `dispatcher.ts` (sole path to StationApiService.handle).
import type {
  StationControlPeerAdmission,
  StationControlPeerAuthority,
} from "./peer-authority";
import {
  admitOpenSshPeer,
  dispatchStationApiRequest,
  stationControlErrorEnvelope,
  type RunStationApi,
} from "./dispatcher";

export type { RunStationApi };

export interface StationControlServerOptions {
  readonly run: RunStationApi;
  readonly readiness: () =>
    | StationReadiness
    | Promise<StationReadiness>;
  /**
   * Mandatory authority seam. Production supplies the fixed-client +
   * authenticated-sshd authority; tests may inject a closed fixture.
   */
  readonly peerAuthority: StationControlPeerAuthority;
  readonly home?: string;
  readonly stationHome?: string;
}

export interface StationControlShutdownReceipt {
  readonly clean: boolean;
  readonly pendingDispatches: number;
  readonly openSockets: number;
  readonly listenerRetained: boolean;
  readonly socketPathRetained: boolean;
}

export interface StationControlServer {
  readonly socketPath: string;
  readonly stationHome: string;
  readonly ready: () => boolean;
  beginShutdown(): void;
  close(): Promise<StationControlShutdownReceipt>;
}

const liveStationControlListeners = new Map<symbol, () => boolean>();

export const stationControlReadiness = Object.freeze({
  ready: (): boolean => {
    for (const observe of liveStationControlListeners.values()) {
      try {
        if (observe()) return true;
      } catch {
        // A raced teardown is not ready.
      }
    }
    return false;
  },
});

export const resolveStationControlHome = (
  home?: string,
  stationHome?: string,
): string => {
  if (stationHome !== undefined && stationHome.trim().length > 0) {
    return stationHome.trim();
  }
  const configured = process.env[STATION_CONTROL_HOME_ENV]?.trim();
  return configured && configured.length > 0
    ? configured
    : stationControlDir(home ?? homedir());
};

/** @deprecated Prefer importing from `./dispatcher` — re-exported for tests. */
export { stationControlErrorEnvelope };

const writeEnvelope = (
  socket: Socket,
  envelope: StationControlEnvelope,
): void => {
  if (socket.destroyed) return;
  try {
    socket.end(encodeStationControlFrame(envelope));
  } catch {
    socket.destroy();
  }
};

const closeNetServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const waitAtMost = async (
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const startStationControlServer = async (
  options: StationControlServerOptions,
): Promise<StationControlServer> => {
  const stationHome = resolveStationControlHome(
    options.home,
    options.stationHome,
  );
  prepareControlDirectory(stationHome);
  const socketPath = stationControlSocketPath(stationHome);
  const listenerLease = await acquireControlListenerLease(socketPath);
  try {
    await removeObservedSocket(listenerLease);
  } catch (error) {
    await releaseControlListenerLease(listenerLease);
    throw error;
  }

  const readinessAuthority = Symbol("station-control-listener");
  const sockets = new Set<Socket>();
  const dispatches = new Set<Promise<unknown>>();
  let shuttingDown = false;
  let socketIdentity: ControlSocketPathIdentity | undefined;
  let listenerClose: Promise<void> | undefined;
  let cleanupBlocked = false;
  let closeFlight: Promise<StationControlShutdownReceipt> | undefined;

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
      return controlSocketPathOwnedByLease(
        listenerLease,
        socketIdentity,
      );
    } catch {
      return false;
    }
  };

  const server = createServer((socket) => {
    if (
      shuttingDown ||
      sockets.size >= STATION_CONTROL_MAX_CLIENTS
    ) {
      socket.end();
      return;
    }

    let peerAdmission: StationControlPeerAdmission | undefined;
    try {
      peerAdmission = options.peerAuthority.capture(socket);
    } catch {
      peerAdmission = undefined;
    }
    if (peerAdmission === undefined) {
      writeEnvelope(
        socket,
        stationControlErr(
          "authorization_denied",
          "station control requires the packaged client under authenticated SSH",
          false,
        ),
      );
      return;
    }

    sockets.add(socket);
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let frameAdmitted = false;
    const inputTimer = setTimeout(() => {
      if (frameAdmitted || socket.destroyed) return;
      writeEnvelope(
        socket,
        stationControlErr(
          "protocol_error",
          "station request frame timed out",
          true,
        ),
      );
    }, STATION_CONTROL_REQUEST_TIMEOUT_MS);

    const transportAdmission = admitOpenSshPeer(peerAdmission);

    const dispatch = async (
      request: StationApiRequest,
    ): Promise<void> => {
      try {
        // Readiness is observational state for status only. A failed probe
        // must never block pair/configure/project/report mutations.
        let readiness: StationReadiness;
        if (request.op === "status") {
          try {
            readiness = await options.readiness();
          } catch {
            writeEnvelope(
              socket,
              stationControlErr(
                "unavailable",
                "station readiness could not be observed",
                true,
              ),
            );
            return;
          }
        } else {
          readiness = {
            database: true,
            workControl: false,
            simulation: false,
          };
        }
        const envelope = await dispatchStationApiRequest(
          transportAdmission,
          request,
          readiness,
          options.run,
        );
        writeEnvelope(socket, envelope);
      } catch (error) {
        writeEnvelope(socket, stationControlErrorEnvelope(error));
      }
    };

    const peerStillAuthorized = (
      admission: StationControlPeerAdmission,
    ): boolean => {
      try {
        return options.peerAuthority.revalidate(socket, admission);
      } catch {
        return false;
      }
    };

    const denyChangedPeer = (): void => {
      writeEnvelope(
        socket,
        stationControlErr(
          "authorization_denied",
          "station control peer authority changed",
          false,
        ),
      );
    };

    socket.on("data", (chunk: Buffer | string) => {
      if (frameAdmitted || shuttingDown) {
        writeEnvelope(
          socket,
          stationControlErr(
            "protocol_error",
            "station control accepts one request per connection",
            false,
          ),
        );
        return;
      }

      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = part.indexOf(0x0a);
      const framePart = newline < 0 ? part : part.subarray(0, newline);
      bufferedBytes += framePart.byteLength;
      if (bufferedBytes > STATION_CONTROL_MAX_FRAME_BYTES) {
        frameAdmitted = true;
        clearTimeout(inputTimer);
        writeEnvelope(
          socket,
          stationControlErr(
            "protocol_error",
            `station frame exceeds ${STATION_CONTROL_MAX_FRAME_BYTES} bytes`,
            false,
          ),
        );
        return;
      }

      chunks.push(framePart);
      if (newline < 0) return;
      frameAdmitted = true;
      clearTimeout(inputTimer);
      socket.pause();
      // Re-observe the kernel peer and every process epoch before parsing any
      // caller-controlled JSON. An authenticated session that changed while
      // streaming the frame has no residual authority.
      if (!peerStillAuthorized(peerAdmission)) {
        denyChangedPeer();
        return;
      }
      const trailing = part.subarray(newline + 1).toString("utf8").trim();
      if (trailing.length > 0) {
        writeEnvelope(
          socket,
          stationControlErr(
            "protocol_error",
            "station control accepts one request per connection",
            false,
          ),
        );
        return;
      }

      let raw: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bufferedBytes),
        );
        raw = JSON.parse(text) as unknown;
      } catch {
        writeEnvelope(
          socket,
          stationControlErr(
            "protocol_error",
            "station request is not valid UTF-8 JSON",
            false,
          ),
        );
        return;
      } finally {
        chunks.length = 0;
        bufferedBytes = 0;
      }

      const decoded = decodeStationControlRequest(raw);
      if (Either.isLeft(decoded)) {
        writeEnvelope(
          socket,
          stationControlErr(
            "protocol_error",
            "station request does not match the API contract",
            false,
          ),
        );
        return;
      }

      // Decoding a maximum projection can take material time. Bind dispatch
      // to a fresh identical process-chain observation so pair/configure/
      // project/report/status never run on a stale ancestry proof.
      if (!peerStillAuthorized(peerAdmission)) {
        denyChangedPeer();
        return;
      }
      const operation = dispatch(decoded.right);
      dispatches.add(operation);
      void operation.finally(() => dispatches.delete(operation));
    });

    socket.once("close", () => {
      clearTimeout(inputTimer);
      sockets.delete(socket);
    });
    socket.on("error", () => {
      clearTimeout(inputTimer);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(
        {
          path: socketPath,
          readableAll: false,
          writableAll: false,
        },
        () => {
          server.off("error", onError);
          try {
            socketIdentity =
              captureControlSocketPathIdentity(listenerLease);
            chmodSync(socketPath, 0o600);
            const hardened = lstatSync(socketPath, { bigint: true });
            const currentUid =
              typeof process.getuid === "function"
                ? BigInt(process.getuid())
                : undefined;
            if (
              !hardened.isSocket() ||
              hardened.isSymbolicLink() ||
              (hardened.mode & 0o777n) !== 0o600n ||
              (currentUid !== undefined &&
                hardened.uid !== currentUid) ||
              !ownsSocketPath()
            ) {
              throw new Error(
                "station control socket could not be made owner-only",
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
    await closeNetServer(server).catch(() => undefined);
    if (
      socketIdentity !== undefined &&
      controlListenerLeaseHeld(listenerLease)
    ) {
      try {
        removeOwnedControlSocketPath(listenerLease, socketIdentity);
      } catch {
        // Preserve any replacement path.
      }
    }
    await releaseControlListenerLease(listenerLease).catch(() => undefined);
    throw error;
  }

  server.on("error", (error) => {
    console.error("[station-control] server error:", error);
  });

  const ready = (): boolean =>
    !shuttingDown &&
    server.listening &&
    controlListenerLeaseHeld(listenerLease) &&
    ownsSocketPath();
  liveStationControlListeners.set(readinessAuthority, ready);
  server.once("close", () => {
    liveStationControlListeners.delete(readinessAuthority);
  });

  const beginShutdown = (): void => {
    liveStationControlListeners.delete(readinessAuthority);
    if (shuttingDown) return;
    shuttingDown = true;

    if (existsSync(socketPath) && !pathMatchesCapturedIdentity()) {
      // libuv may unlink a replacement pathname while closing a Unix server.
      // Do not close through a path we no longer own.
      cleanupBlocked = true;
      server.unref();
    } else {
      listenerClose = closeNetServer(server);
    }
    for (const socket of sockets) {
      if (!socket.destroyed) socket.end();
    }
  };

  const close = (): Promise<StationControlShutdownReceipt> => {
    if (closeFlight !== undefined) return closeFlight;
    beginShutdown();
    closeFlight = (async () => {
      const dispatchSnapshot = [...dispatches];
      await waitAtMost(
        Promise.allSettled(dispatchSnapshot).then(() => undefined),
        2_000,
      );
      for (const socket of sockets) {
        if (!socket.destroyed) socket.destroy();
      }
      if (listenerClose !== undefined) {
        await waitAtMost(listenerClose, 2_000);
      }

      if (
        socketIdentity !== undefined &&
        controlListenerLeaseHeld(listenerLease) &&
        ownsSocketPath()
      ) {
        removeOwnedControlSocketPath(listenerLease, socketIdentity);
      }
      if (controlListenerLeaseHeld(listenerLease)) {
        await releaseControlListenerLease(listenerLease);
      }

      const listenerRetained = server.listening;
      const socketPathRetained =
        pathMatchesCapturedIdentity() || cleanupBlocked;
      return Object.freeze({
        clean:
          dispatches.size === 0 &&
          sockets.size === 0 &&
          !listenerRetained &&
          !socketPathRetained,
        pendingDispatches: dispatches.size,
        openSockets: sockets.size,
        listenerRetained,
        socketPathRetained,
      });
    })();
    return closeFlight;
  };

  return Object.freeze({
    socketPath,
    stationHome,
    ready,
    beginShutdown,
    close,
  });
};
