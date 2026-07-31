import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolveVellumHome } from "@shared/vellum-home";
import { Either, Schema } from "effect";
import {
  ReportRequest as ReportRequestSchema,
  reportResponseSwapsDirection,
  type ReportRequest,
  type ReportResponse,
  type StationApiRequest,
  type StationReadiness,
} from "@shared/station-api";
import {
  stationControlErr,
  type StationControlEnvelope,
} from "@shared/station-api-envelope";
import {
  STATION_CONTROL_MAX_FRAME_BYTES,
  STATION_CONTROL_HOME_ENV,
  STATION_CONTROL_REQUEST_TIMEOUT_MS,
  encodeStationControlFrame,
  stationControlDir,
  stationControlSocketPath,
} from "@shared/station-ssh-control";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationProtocolAccept,
  StationProtocolOffer,
  StationProtocolReject,
  decodeStationProtocolPreface,
  negotiateStationProtocol,
  selectStationProtocolCodec,
  stationProtocolAccept,
  stationProtocolReject,
  type StationAppVersion,
  type StationProtocolVersion,
  type StationStateSchemaVersion,
} from "@shared/station-protocol";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  decideStationSessionCorrelation,
  decodeStationSessionFrame,
  stationSessionResponse,
  type StationSessionFrame,
  type StationSessionRequestFrame as StationSessionRequestFrameValue,
  type StationSessionResponseFrame,
} from "@shared/station-session";
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
import type {
  StationControlLocalHandoff,
  StationControlLocalHandoffAuthority,
} from "./peer-authority";
import {
  admitOwnerLocalStationHandoff,
  dispatchStationApiRequest,
  stationControlErrorEnvelope,
  type RunStationApi,
  type StationTransportAdmission,
} from "./dispatcher";

export type { RunStationApi };

export type StationControlRequestAdmission = (
  request: StationApiRequest,
) => boolean;

type StationControlReadinessObservation =
  & Omit<StationReadiness, "session">
  & { readonly session?: boolean };

export interface StationControlServerOptions {
  readonly run: RunStationApi;
  readonly readiness: () =>
    | StationControlReadinessObservation
    | Promise<StationControlReadinessObservation>;
  /**
   * Mandatory owner-local handoff seam. Production binds admissions to the
   * exact accepted Unix socket; tests may inject a closed fixture.
   */
  readonly localHandoffAuthority: StationControlLocalHandoffAuthority;
  readonly home?: string;
  readonly stationHome?: string;
  /** Tests may lower the product frame bound; callers cannot raise it. */
  readonly maxFrameBytes?: number;
  /** Tests may lower the product timeout; callers cannot raise it. */
  readonly requestTimeoutMs?: number;
  /** Diagnostics only; neither value participates in wire selection. */
  readonly appVersion?: StationAppVersion;
  readonly stateSchemaVersion?: StationStateSchemaVersion;
  /**
   * Optional operation admission for a deliberately reduced Station surface.
   * The request is already strict-decoded. Omission preserves the full
   * admitted transport contract; a false result or thrown error denies only
   * that request and never reaches readiness probes or the domain service.
   */
  readonly admitRequest?: StationControlRequestAdmission;
}

export interface StationControlShutdownReceipt {
  readonly clean: boolean;
  readonly pendingDispatches: number;
  readonly openSockets: number;
  readonly listenerRetained: boolean;
  readonly socketPathRetained: boolean;
}

export type StationControlReportFailure =
  | "session-unavailable"
  | "local-handoff-lost"
  | "capacity-exceeded"
  | "request-timeout"
  | "invalid-local-request"
  | "protocol-error"
  | "remote-rejected";

export class StationControlReportError extends Error {
  readonly name = "StationControlReportError";

  constructor(
    readonly failure: StationControlReportFailure,
    message: string,
    readonly envelope?: StationControlEnvelope,
  ) {
    super(message);
  }
}

export interface StationControlServer {
  readonly socketPath: string;
  readonly stationHome: string;
  readonly ready: () => boolean;
  readonly sessionReady: () => boolean;
  /**
   * Observe the Remote-side Command Center session lifecycle. The listener is
   * called immediately with the current state, then only when readiness
   * changes. It is a wake-up signal, never durable identity or authority.
   */
  readonly subscribeSession: (
    listener: (ready: boolean) => void,
  ) => () => void;
  readonly report: (request: ReportRequest) => Promise<ReportResponse>;
  beginShutdown(): void;
  close(): Promise<StationControlShutdownReceipt>;
}

interface PendingReport {
  readonly frame: StationSessionRequestFrameValue;
  readonly request: ReportRequest;
  readonly resolve: (response: ReportResponse) => void;
  readonly reject: (error: StationControlReportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ActiveStationControlSession {
  readonly socket: Socket;
  readonly localHandoff: StationControlLocalHandoff;
  readonly transportAdmission: StationTransportAdmission;
  readonly pendingReports: Map<string, PendingReport>;
  buffer: Buffer;
  partialFrameTimer: ReturnType<typeof setTimeout> | undefined;
  writeTail: Promise<void>;
  queuedWriteBytes: number;
  negotiatedProtocol: StationProtocolVersion | undefined;
  closed: boolean;
}

type StationControlOutboundFrame =
  | StationSessionFrame
  | StationProtocolAccept
  | StationProtocolReject;

const MAX_PENDING_REPORTS = 64;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const decodeReportRequest = Schema.decodeUnknownEither(
  ReportRequestSchema,
  { onExcessProperty: "error" },
);

const liveStationControlListeners = new Map<symbol, () => boolean>();
const liveStationControlSessions = new Map<symbol, () => boolean>();

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
  sessionReady: (): boolean => {
    for (const observe of liveStationControlSessions.values()) {
      try {
        if (observe()) return true;
      } catch {
        // A raced session teardown is not ready.
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
    : stationControlDir(home ?? resolveVellumHome());
};

/** @deprecated Prefer importing from `./dispatcher` — re-exported for tests. */
export { stationControlErrorEnvelope };

const boundedPositiveInteger = (
  requested: number | undefined,
  maximum: number,
): number =>
  requested !== undefined &&
    Number.isFinite(requested) &&
    requested > 0
    ? Math.min(Math.floor(requested), maximum)
    : maximum;

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
  const maxFrameBytes = boundedPositiveInteger(
    options.maxFrameBytes,
    STATION_CONTROL_MAX_FRAME_BYTES,
  );
  const requestTimeoutMs = boundedPositiveInteger(
    options.requestTimeoutMs,
    STATION_CONTROL_REQUEST_TIMEOUT_MS,
  );
  const protocolDiagnostics = Object.freeze({
    appVersion: options.appVersion ?? "unknown",
    stateSchemaVersion: options.stateSchemaVersion ?? 1,
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  });
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
  const sessionListeners = new Set<(ready: boolean) => void>();
  let activeSession: ActiveStationControlSession | undefined;
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
        (current.mode & 0o777n) === 0o600n &&
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

  const sessionReady = (): boolean =>
    !shuttingDown &&
    activeSession !== undefined &&
    !activeSession.closed &&
    !activeSession.socket.destroyed &&
    activeSession.negotiatedProtocol !== undefined;

  let observedSessionReady = false;
  const notifySessionReadiness = (): void => {
    const current = sessionReady();
    if (current === observedSessionReady) return;
    observedSessionReady = current;
    for (const listener of sessionListeners) {
      try {
        listener(current);
      } catch {
        // Observation cannot interfere with the admitted transport.
      }
    }
  };

  const localHandoffIsCurrent = (
    session: ActiveStationControlSession,
  ): boolean => {
    try {
      return options.localHandoffAuthority.isCurrent(
        session.socket,
        session.localHandoff,
      );
    } catch {
      return false;
    }
  };

  const rejectPendingReports = (
    session: ActiveStationControlSession,
    error: StationControlReportError,
  ): void => {
    for (const pending of session.pendingReports.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pendingReports.clear();
  };

  const terminateSession = (
    session: ActiveStationControlSession,
    error: StationControlReportError,
    graceful = false,
  ): void => {
    if (session.closed) return;
    session.closed = true;
    if (session.partialFrameTimer !== undefined) {
      clearTimeout(session.partialFrameTimer);
      session.partialFrameTimer = undefined;
    }
    if (activeSession === session) activeSession = undefined;
    notifySessionReadiness();
    rejectPendingReports(session, error);
    if (graceful && !session.socket.destroyed) {
      session.socket.end();
    } else {
      session.socket.destroy();
    }
  };

  const trackDispatch = <A>(operation: Promise<A>): Promise<A> => {
    dispatches.add(operation);
    void operation
      .finally(() => dispatches.delete(operation))
      .catch(() => undefined);
    return operation;
  };

  const enqueueFrame = (
    session: ActiveStationControlSession,
    frame: StationControlOutboundFrame,
  ): Promise<void> => {
    let payload: Buffer;
    try {
      payload = Buffer.from(encodeStationControlFrame(frame), "utf8");
    } catch {
      const error = new StationControlReportError(
        "protocol-error",
        "station session frame exceeded its product bound",
      );
      terminateSession(session, error);
      return Promise.reject(error);
    }
    if (
      payload.byteLength > maxFrameBytes ||
      session.queuedWriteBytes + payload.byteLength > maxFrameBytes
    ) {
      const error = new StationControlReportError(
        "capacity-exceeded",
        "station session write queue exceeded its bound",
      );
      terminateSession(session, error);
      return Promise.reject(error);
    }

    session.queuedWriteBytes += payload.byteLength;
    const write = session.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (session.closed || session.socket.destroyed) {
            reject(
              new StationControlReportError(
                "session-unavailable",
                "station session is not connected",
              ),
            );
            return;
          }
          session.socket.write(payload, (error?: Error | null) => {
            if (error !== undefined && error !== null) {
              reject(
                new StationControlReportError(
                  "session-unavailable",
                  "station session write failed",
                ),
              );
              return;
            }
            resolve();
          });
        }),
    );
    const settled = write
      .catch((error: unknown) => {
        const reportError =
          error instanceof StationControlReportError
            ? error
            : new StationControlReportError(
              "session-unavailable",
              "station session write failed",
            );
        terminateSession(session, reportError);
        throw reportError;
      })
      .finally(() => {
        session.queuedWriteBytes -= payload.byteLength;
      });
    session.writeTail = settled.catch(() => undefined);
    return settled;
  };

  const respondToRequest = async (
    session: ActiveStationControlSession,
    requestFrame: StationSessionRequestFrameValue,
    envelope: StationControlEnvelope,
  ): Promise<void> => {
    if (!localHandoffIsCurrent(session)) {
      terminateSession(
        session,
        new StationControlReportError(
          "local-handoff-lost",
          "station owner-local handoff is no longer current",
        ),
      );
      return;
    }
    let response: StationSessionResponseFrame;
    try {
      response = stationSessionResponse(requestFrame, envelope);
    } catch {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station dispatcher produced an uncorrelated response",
        ),
      );
      return;
    }
    await enqueueFrame(session, response);
  };

  const dispatchRequest = async (
    session: ActiveStationControlSession,
    requestFrame: StationSessionRequestFrameValue,
  ): Promise<void> => {
    let admitted = true;
    if (options.admitRequest !== undefined) {
      try {
        admitted = options.admitRequest(requestFrame.request) === true;
      } catch {
        admitted = false;
      }
    }
    if (!admitted) {
      await respondToRequest(
        session,
        requestFrame,
        stationControlErr(
          "authorization_denied",
          "station operation is not admitted",
          false,
        ),
      );
      return;
    }

    let readiness: StationReadiness;
    if (requestFrame.request.op === "status") {
      let observed: StationControlReadinessObservation;
      try {
        observed = await options.readiness();
      } catch {
        await respondToRequest(
          session,
          requestFrame,
          stationControlErr(
            "unavailable",
            "station readiness could not be observed",
            true,
          ),
        );
        return;
      }
      readiness = {
        database: observed.database,
        workControl: observed.workControl,
        simulation: observed.simulation,
        session: sessionReady(),
      };
    } else {
      // Mutating verbs do not depend on observational probes. The fallback is
      // nevertheless a complete StationReadiness value for the service.
      readiness = {
        database: true,
        workControl: false,
        simulation: false,
        session: sessionReady(),
      };
    }

    // Keep dispatch bound to the exact owner-local socket accepted for this
    // session. This is not a reconstruction of the original SSH peer.
    if (!localHandoffIsCurrent(session)) {
      terminateSession(
        session,
        new StationControlReportError(
          "local-handoff-lost",
          "station owner-local handoff is no longer current",
        ),
      );
      return;
    }

    let envelope: StationControlEnvelope;
    try {
      envelope = await dispatchStationApiRequest(
        session.transportAdmission,
        requestFrame.request,
        readiness,
        options.run,
      );
    } catch (error) {
      envelope = stationControlErrorEnvelope(error);
    }
    await respondToRequest(session, requestFrame, envelope);
  };

  const acceptResponse = (
    session: ActiveStationControlSession,
    response: StationSessionResponseFrame,
  ): void => {
    const pending = session.pendingReports.get(response.requestId);
    if (pending === undefined) {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station session returned an unexpected response",
        ),
      );
      return;
    }
    const correlation = decideStationSessionCorrelation(
      pending.frame,
      response,
    );
    if (correlation._tag !== "correlated") {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station session returned an uncorrelated response",
        ),
      );
      return;
    }

    if (!response.envelope.ok) {
      clearTimeout(pending.timer);
      session.pendingReports.delete(response.requestId);
      pending.reject(
        new StationControlReportError(
          "remote-rejected",
          response.envelope.error.message,
          response.envelope,
        ),
      );
      return;
    }
    const reportResponse = response.envelope.response;
    if (
      reportResponse.op !== "report" ||
      !reportResponseSwapsDirection(pending.request, reportResponse)
    ) {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station report response has an invalid direction",
        ),
      );
      return;
    }
    clearTimeout(pending.timer);
    session.pendingReports.delete(response.requestId);
    pending.resolve(reportResponse);
  };

  const bindProtocol = (
    session: ActiveStationControlSession,
    version: StationProtocolVersion,
  ): boolean => {
    if (session.negotiatedProtocol !== undefined) return false;
    if (
      version < CURRENT_STATION_PROTOCOL_SUPPORT.compatibleFrom ||
      version > CURRENT_STATION_PROTOCOL_SUPPORT.preferred
    ) {
      return false;
    }
    const codec = selectStationProtocolCodec(version);
    if (Either.isLeft(codec)) return false;
    session.negotiatedProtocol = codec.right;
    notifySessionReadiness();
    return true;
  };

  const processSessionFrame = async (
    session: ActiveStationControlSession,
    frame: StationSessionFrame,
  ): Promise<void> => {
    // Strict decode does not replace the exact-socket handoff check.
    if (!localHandoffIsCurrent(session)) {
      terminateSession(
        session,
        new StationControlReportError(
          "local-handoff-lost",
          "station owner-local handoff is no longer current",
        ),
      );
      return;
    }
    if (frame.frame === "request") {
      await dispatchRequest(session, frame);
      return;
    }
    acceptResponse(session, frame);
  };

  const acceptProtocolOffer = async (
    session: ActiveStationControlSession,
    offer: StationProtocolOffer,
  ): Promise<void> => {
    const negotiation = negotiateStationProtocol(
      CURRENT_STATION_PROTOCOL_SUPPORT,
      offer.support,
    );
    if (negotiation._tag === "no-common") {
      await enqueueFrame(
        session,
        stationProtocolReject(protocolDiagnostics),
      );
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station peers have no common protocol version",
        ),
        true,
      );
      return;
    }
    if (Either.isLeft(selectStationProtocolCodec(negotiation.selected))) {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "selected Station protocol has no installed codec",
        ),
      );
      return;
    }

    await enqueueFrame(
      session,
      stationProtocolAccept(offer, protocolDiagnostics),
    );
    if (
      session.closed ||
      !localHandoffIsCurrent(session) ||
      !bindProtocol(session, negotiation.selected)
    ) {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station protocol could not be bound to the admitted session",
        ),
      );
    }
  };

  const processFrame = async (
    session: ActiveStationControlSession,
    encoded: Buffer,
  ): Promise<void> => {
    if (!localHandoffIsCurrent(session)) {
      terminateSession(
        session,
        new StationControlReportError(
          "local-handoff-lost",
          "station owner-local handoff is no longer current",
        ),
      );
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(UTF8_DECODER.decode(encoded)) as unknown;
    } catch {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station session frame is not valid UTF-8 JSON",
        ),
      );
      return;
    }

    if (session.negotiatedProtocol === undefined) {
      const preface = decodeStationProtocolPreface(raw);
      if (Either.isRight(preface)) {
        if (preface.right.frame !== "offer") {
          terminateSession(
            session,
            new StationControlReportError(
              "protocol-error",
              "Remote accepts only a Station protocol offer before binding",
            ),
          );
          return;
        }
        await acceptProtocolOffer(session, preface.right);
        return;
      }

      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station first frame must be a compatible protocol offer",
        ),
      );
      return;
    }

    const decoded = decodeStationSessionFrame(raw);
    if (Either.isLeft(decoded)) {
      terminateSession(
        session,
        new StationControlReportError(
          "protocol-error",
          "station session frame does not match the selected strict codec",
        ),
      );
      return;
    }
    await processSessionFrame(session, decoded.right);
  };

  const armPartialFrameTimeout = (
    session: ActiveStationControlSession,
  ): void => {
    if (session.partialFrameTimer !== undefined) {
      clearTimeout(session.partialFrameTimer);
    }
    session.partialFrameTimer = setTimeout(() => {
      terminateSession(
        session,
        new StationControlReportError(
          "request-timeout",
          "station session partial frame timed out",
        ),
      );
    }, requestTimeoutMs);
    session.partialFrameTimer.unref();
  };

  const processChunk = async (
    session: ActiveStationControlSession,
    chunk: Buffer,
  ): Promise<void> => {
    if (session.closed || shuttingDown) return;
    session.buffer = Buffer.concat([session.buffer, chunk]);

    while (!session.closed) {
      const newline = session.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (session.buffer.byteLength >= maxFrameBytes) {
          terminateSession(
            session,
            new StationControlReportError(
              "protocol-error",
              "station session frame exceeded its bound",
            ),
          );
          return;
        }
        if (session.buffer.byteLength > 0) {
          armPartialFrameTimeout(session);
        }
        return;
      }
      if (newline + 1 > maxFrameBytes) {
        terminateSession(
          session,
          new StationControlReportError(
            "protocol-error",
            "station session frame exceeded its bound",
          ),
        );
        return;
      }

      const frame = session.buffer.subarray(0, newline);
      session.buffer = session.buffer.subarray(newline + 1);
      if (session.partialFrameTimer !== undefined) {
        clearTimeout(session.partialFrameTimer);
        session.partialFrameTimer = undefined;
      }
      if (frame.byteLength === 0) {
        terminateSession(
          session,
          new StationControlReportError(
            "protocol-error",
            "station session does not accept empty frames",
          ),
        );
        return;
      }
      await processFrame(session, frame);
    }
  };

  const server = createServer((socket) => {
    if (
      shuttingDown ||
      (
        activeSession !== undefined &&
        !activeSession.closed &&
        !activeSession.socket.destroyed
      ) ||
      !pathMatchesCapturedIdentity() ||
      !ownsSocketPath()
    ) {
      socket.destroy();
      return;
    }

    let localHandoff: StationControlLocalHandoff | undefined;
    try {
      localHandoff = options.localHandoffAuthority.capture(socket);
    } catch {
      localHandoff = undefined;
    }
    if (localHandoff === undefined) {
      socket.destroy();
      return;
    }

    const session: ActiveStationControlSession = {
      socket,
      localHandoff,
      transportAdmission: admitOwnerLocalStationHandoff(localHandoff),
      pendingReports: new Map(),
      buffer: Buffer.alloc(0),
      partialFrameTimer: undefined,
      writeTail: Promise.resolve(),
      queuedWriteBytes: 0,
      negotiatedProtocol: undefined,
      closed: false,
    };
    activeSession = session;
    notifySessionReadiness();
    sockets.add(socket);
    armPartialFrameTimeout(session);

    socket.on("data", (chunk: Buffer | string) => {
      if (session.closed || shuttingDown) return;
      socket.pause();
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const operation = trackDispatch(processChunk(session, part));
      void operation.then(
        () => {
          if (!session.closed && !shuttingDown && !socket.destroyed) {
            socket.resume();
          }
        },
        () => {
          terminateSession(
            session,
            new StationControlReportError(
              "protocol-error",
              "station session frame processing failed",
            ),
          );
        },
      );
    });
    socket.once("end", () => {
      terminateSession(
        session,
        new StationControlReportError(
          "session-unavailable",
          "station session peer closed",
        ),
        true,
      );
    });
    socket.once("error", () => {
      terminateSession(
        session,
        new StationControlReportError(
          "session-unavailable",
          "station session transport failed",
        ),
      );
    });
    socket.once("close", () => {
      if (!session.closed) {
        terminateSession(
          session,
          new StationControlReportError(
            "session-unavailable",
            "station session closed",
          ),
        );
      }
      sockets.delete(socket);
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
    pathMatchesCapturedIdentity() &&
    ownsSocketPath();
  liveStationControlListeners.set(readinessAuthority, ready);
  liveStationControlSessions.set(readinessAuthority, sessionReady);
  server.once("close", () => {
    liveStationControlListeners.delete(readinessAuthority);
    liveStationControlSessions.delete(readinessAuthority);
  });

  const report = (
    input: ReportRequest,
  ): Promise<ReportResponse> => {
    const decoded = decodeReportRequest(input);
    if (Either.isLeft(decoded)) {
      return Promise.reject(
        new StationControlReportError(
          "invalid-local-request",
          "only a strict report request may originate on a Remote session",
        ),
      );
    }
    const session = activeSession;
    if (
      shuttingDown ||
      session === undefined ||
      session.closed ||
      session.socket.destroyed ||
      session.negotiatedProtocol === undefined
    ) {
      return Promise.reject(
        new StationControlReportError(
          "session-unavailable",
          "Command Center has no active Station session",
        ),
      );
    }
    if (session.pendingReports.size >= MAX_PENDING_REPORTS) {
      return Promise.reject(
        new StationControlReportError(
          "capacity-exceeded",
          "station report correlation capacity is exhausted",
        ),
      );
    }
    if (!localHandoffIsCurrent(session)) {
      const error = new StationControlReportError(
        "local-handoff-lost",
        "station owner-local handoff is no longer current",
      );
      terminateSession(session, error);
      return Promise.reject(error);
    }

    const requestId = StationSessionRequestId.make(randomUUID());
    const frame = StationSessionRequestFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "request",
      requestId,
      request: decoded.right,
    });
    return new Promise<ReportResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pendingReports.get(requestId);
        if (pending === undefined) return;
        session.pendingReports.delete(requestId);
        const error = new StationControlReportError(
          "request-timeout",
          "station report response timed out",
        );
        pending.reject(error);
        terminateSession(session, error);
      }, requestTimeoutMs);
      timer.unref();
      session.pendingReports.set(requestId, {
        frame,
        request: decoded.right,
        resolve,
        reject,
        timer,
      });
      void enqueueFrame(session, frame).catch(() => undefined);
    });
  };

  const subscribeSession = (
    listener: (ready: boolean) => void,
  ): (() => void) => {
    sessionListeners.add(listener);
    try {
      listener(sessionReady());
    } catch {
      // Observation cannot interfere with the admitted transport.
    }
    return () => {
      sessionListeners.delete(listener);
    };
  };

  const beginShutdown = (): void => {
    liveStationControlListeners.delete(readinessAuthority);
    liveStationControlSessions.delete(readinessAuthority);
    if (shuttingDown) return;
    shuttingDown = true;
    notifySessionReadiness();

    if (existsSync(socketPath) && !pathMatchesCapturedIdentity()) {
      // libuv may unlink a replacement pathname while closing a Unix server.
      // Do not close through a path we no longer own.
      cleanupBlocked = true;
      server.unref();
    } else {
      listenerClose = closeNetServer(server);
    }
    if (activeSession !== undefined) {
      terminateSession(
        activeSession,
        new StationControlReportError(
          "session-unavailable",
          "station control is shutting down",
        ),
        true,
      );
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
    sessionReady,
    subscribeSession,
    report,
    beginShutdown,
    close,
  });
};
