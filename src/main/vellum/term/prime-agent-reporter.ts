/**
 * Owner-local receiver for Prime Agent's stock Herdr-compatible reporter.
 *
 * Prime Agent 0.7.1 opens one Unix connection per JSON request, writes one
 * newline-terminated frame, and waits for any response before disconnecting.
 * This plane deliberately implements only the two built-in lifecycle methods
 * Vellum Command needs. The random pane id is the generation capability: no
 * caller-supplied binding or epoch ever crosses the socket boundary.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { basename, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { termControlDir } from "@shared/term-control";
import {
  acquireControlListenerLease,
  captureControlSocketPathIdentity,
  controlListenerLeaseHeld,
  controlSocketPathOwnedByLease,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
  removeOwnedControlSocketPath,
  type ControlListenerLease,
  type ControlSocketPathIdentity,
} from "../control-filesystem";

export const PRIME_AGENT_REPORTER_SOCKET_LEAF =
  "pa.sock";
export const PRIME_AGENT_REPORTER_MAX_LINE_BYTES = 64 * 1024;
export const PRIME_AGENT_REPORTER_MAX_MESSAGE_BYTES = 8 * 1024;
export const PRIME_AGENT_REPORTER_MAX_SESSION_ID_BYTES = 256;
export const PRIME_AGENT_REPORTER_MAX_SESSION_PATH_BYTES = 4 * 1024;
export const PRIME_AGENT_REPORTER_MAX_CLIENTS = 16;

const PRIME_AGENT_SOURCE = "herdr:pi";
const PRIME_AGENT_LABEL = "prime-agent";
const DEFAULT_SHUTDOWN_GRACE_MS = 100;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 1_000;
const MAX_REQUEST_ID_BYTES = 512;
const MAX_INTERNAL_ID_BYTES = 2 * 1024;
const UUID_JSONL_BASENAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

export const primeAgentReporterSocketPath = (
  home?: string,
): string => join(termControlDir(home), PRIME_AGENT_REPORTER_SOCKET_LEAF);

export type PrimeAgentReporterState = "idle" | "working" | "attention";

export type PrimeAgentReporterReport = Readonly<{
  readonly bindingId: string;
  readonly epoch: string;
  readonly state: PrimeAgentReporterState;
  readonly reason: string;
  readonly message?: string;
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly released?: true;
}>;

export type PrimeAgentReporterRegisterInput = Readonly<{
  readonly bindingId: string;
  readonly epoch: string;
  readonly onReport: (report: PrimeAgentReporterReport) => void;
}>;

export type PrimeAgentReporterRegistration = Readonly<{
  readonly paneId: string;
  readonly socketPath: string;
  /** Drop only this exact registration generation. Idempotent. */
  readonly release: () => void;
}>;

export type PrimeAgentReporterShutdownReceipt = Readonly<{
  readonly clean: boolean;
  readonly retainedClients: number;
  readonly retainedListener: boolean;
  readonly retainedSocketPath: boolean;
  readonly retainedLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}>;

export type PrimeAgentReporterPlaneOptions = Readonly<{
  /** Tests may lower, never raise, the production peer ceiling. */
  readonly maxClients?: number;
  /** Tests may lower, never raise, the graceful peer-close window. */
  readonly shutdownGraceMs?: number;
  /** Tests may lower, never raise, the complete drain deadline. */
  readonly shutdownDeadlineMs?: number;
}>;

type ReporterRegistrationRecord = {
  readonly paneId: string;
  readonly bindingId: string;
  readonly epoch: string;
  readonly onReport: (report: PrimeAgentReporterReport) => void;
  lastSeq: number;
  lastState: PrimeAgentReporterState;
  lastSessionId?: string;
  lastSessionPath?: string;
  released: boolean;
};

type ReporterRequest = Readonly<{
  id: string;
  method: "pane.report_agent" | "pane.release_agent";
  paneId: string;
  seq: number;
  state?: "idle" | "working" | "blocked";
  message?: string;
  sessionId?: string;
  sessionPath?: string;
}>;

type DecodeResult =
  | { readonly ok: true; readonly request: ReporterRequest }
  | {
      readonly ok: false;
      readonly id: string;
      readonly code: string;
      readonly message: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const byteLength = (value: string): number =>
  Buffer.byteLength(value, "utf8");

const boundedRuntimeValue = (
  value: number | undefined,
  ceiling: number,
): number =>
  value === undefined || !Number.isFinite(value) || value <= 0
    ? ceiling
    : Math.min(Math.floor(value), ceiling);

const boundedInternalId = (value: string): boolean =>
  value.length > 0 &&
  byteLength(value) <= MAX_INTERNAL_ID_BYTES &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const boundedRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  byteLength(value) <= MAX_REQUEST_ID_BYTES &&
  !/[\u0000\r\n]/u.test(value);

const boundedSessionId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  byteLength(value) <= PRIME_AGENT_REPORTER_MAX_SESSION_ID_BYTES &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);

const absoluteSessionPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  byteLength(value) <= PRIME_AGENT_REPORTER_MAX_SESSION_PATH_BYTES &&
  !/[\u0000\r\n]/u.test(value) &&
  isAbsolute(value);

const boundedMessage = (value: unknown): value is string =>
  typeof value === "string" &&
  byteLength(value) <= PRIME_AGENT_REPORTER_MAX_MESSAGE_BYTES &&
  !value.includes("\u0000");

const deriveSessionId = (sessionPath: string): string | undefined =>
  UUID_JSONL_BASENAME.exec(basename(sessionPath))?.[1];

const successLine = (id: string): string =>
  `${JSON.stringify({ id, result: { type: "ok" } })}\n`;

const errorLine = (
  id: string,
  code: string,
  message: string,
): string =>
  `${JSON.stringify({ id, error: { code, message } })}\n`;

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    try {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });

const settledBefore = async (
  promise: Promise<unknown>,
  deadline: number,
): Promise<boolean> => {
  const remaining = Math.max(0, deadline - performance.now());
  if (remaining === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitUntil = async (
  predicate: () => boolean,
  deadline: number,
): Promise<boolean> => {
  while (!predicate()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(5, remaining)),
    );
  }
  return true;
};

/**
 * App-owned Prime Agent structured reporter receiver.
 *
 * Lifecycle is monotonic for one app process: start once, register while live,
 * cut admission, then drain. A fresh test/app generation uses a fresh plane.
 */
export class PrimeAgentReporterPlane {
  private readonly maxClients: number;
  private readonly shutdownGraceMs: number;
  private readonly shutdownDeadlineMs: number;
  private readonly registrations = new Map<
    string,
    ReporterRegistrationRecord
  >();
  private readonly clients = new Set<Socket>();
  private readonly diagnostics: string[] = [];
  private server: Server | undefined;
  private listenerLease: ControlListenerLease | undefined;
  private socketIdentity: ControlSocketPathIdentity | undefined;
  private socketPathValue: string | undefined;
  private startFlight: Promise<void> | undefined;
  private shutdownFlight:
    | Promise<PrimeAgentReporterShutdownReceipt>
    | undefined;
  private listenerCloseFlight: Promise<void> | undefined;
  private started = false;
  private admissionOpen = false;
  private shuttingDown = false;
  private pathReplacementBlocked = false;

  constructor(options: PrimeAgentReporterPlaneOptions = {}) {
    this.maxClients = boundedRuntimeValue(
      options.maxClients,
      PRIME_AGENT_REPORTER_MAX_CLIENTS,
    );
    this.shutdownGraceMs = boundedRuntimeValue(
      options.shutdownGraceMs,
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
    this.shutdownDeadlineMs = boundedRuntimeValue(
      options.shutdownDeadlineMs,
      DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
  }

  /** Bind and harden the socket before registration can mint a pane id. */
  start = async (options: { readonly home?: string } = {}): Promise<void> => {
    const requestedPath = primeAgentReporterSocketPath(options.home);
    if (this.shuttingDown) {
      throw new Error("Prime Agent reporter plane is stopping");
    }
    if (this.started) {
      if (this.socketPathValue !== requestedPath) {
        throw new Error("Prime Agent reporter plane already uses another home");
      }
      return;
    }
    if (this.startFlight !== undefined) return this.startFlight;

    let current!: Promise<void>;
    current = (async () => {
      const directory = termControlDir(options.home);
      prepareControlDirectory(directory);
      const lease = await acquireControlListenerLease(requestedPath);
      let leaseInstalled = false;
      try {
        await removeObservedSocket(lease);
        const server = createServer((socket) => this.accept(socket));
        // This auxiliary receiver is never an app-exit authority. The terminal
        // generations remain the exact resources the quit gate may wait for.
        server.unref();
        server.on("error", (error) => {
          this.diagnostics.push(
            `listener: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error);
          server.once("error", onError);
          server.listen(
            {
              path: requestedPath,
              readableAll: false,
              writableAll: false,
            },
            () => {
              server.off("error", onError);
              resolve();
            },
          );
        });

        this.server = server;
        this.listenerLease = lease;
        leaseInstalled = true;
        this.socketPathValue = requestedPath;
        this.socketIdentity = captureControlSocketPathIdentity(lease);
        chmodSync(requestedPath, 0o600);
        if (
          !controlSocketPathOwnedByLease(lease, this.socketIdentity)
        ) {
          throw new Error(
            "Prime Agent reporter socket identity changed during permission hardening",
          );
        }
        const stat = lstatSync(requestedPath);
        if (
          !stat.isSocket() ||
          stat.isSymbolicLink() ||
          (stat.mode & 0o777) !== 0o600
        ) {
          throw new Error(
            "Prime Agent reporter socket permissions could not be hardened",
          );
        }

        this.started = true;
        this.admissionOpen = !this.shuttingDown;
        if (this.shuttingDown) {
          // beginShutdown may have won while lease acquisition/listen awaited.
          // Never reopen admission in the late startup continuation.
          this.ensureListenerClose();
        }
        console.info(`[term] Prime Agent reporter socket ${requestedPath}`);
      } catch (error) {
        if (!leaseInstalled) {
          await releaseControlListenerLease(lease).catch(() => undefined);
        } else {
          // Retain the exact listener authority on the plane. It is unref'd and
          // therefore cannot trap the operator; shutdown can safely retry.
          this.beginShutdown();
          void this.shutdown();
        }
        throw error;
      }
    })();
    this.startFlight = current;
    try {
      await current;
    } finally {
      if (this.startFlight === current) this.startFlight = undefined;
    }
  };

  /**
   * Synchronously mint a random generation pane. Registration before socket
   * readiness, after the admission cut, or with malformed internal ids fails.
   */
  register(
    input: PrimeAgentReporterRegisterInput,
  ): PrimeAgentReporterRegistration {
    if (!this.started || !this.admissionOpen || this.shuttingDown) {
      throw new Error("Prime Agent reporter plane is not accepting registrations");
    }
    if (
      !boundedInternalId(input.bindingId) ||
      !boundedInternalId(input.epoch) ||
      typeof input.onReport !== "function"
    ) {
      throw new Error("invalid Prime Agent reporter registration");
    }

    let paneId: string;
    do {
      paneId = `vcpa_${randomBytes(16).toString("hex")}`;
    } while (this.registrations.has(paneId));

    const record: ReporterRegistrationRecord = {
      paneId,
      bindingId: input.bindingId,
      epoch: input.epoch,
      onReport: input.onReport,
      lastSeq: -1,
      lastState: "idle",
      released: false,
    };
    this.registrations.set(paneId, record);
    const socketPath = this.socketPathValue!;
    return Object.freeze({
      paneId,
      socketPath,
      release: () => {
        this.releaseRegistration(record, true);
      },
    });
  }

  /** Synchronous admission cut; cleanup is completed by shutdown(). */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.admissionOpen = false;
    for (const registration of [...this.registrations.values()]) {
      this.releaseRegistration(registration, true);
    }
    this.server?.unref();
    this.ensureListenerClose();
    for (const client of this.clients) {
      if (!client.destroyed) client.end();
    }
  }

  /** Bounded, retryable drain. An unclean reporter never blocks app exit. */
  shutdown(): Promise<PrimeAgentReporterShutdownReceipt> {
    this.beginShutdown();
    if (this.shutdownFlight !== undefined) return this.shutdownFlight;
    const current = (async (): Promise<PrimeAgentReporterShutdownReceipt> => {
      const deadline = performance.now() + this.shutdownDeadlineMs;
      const startup = this.startFlight;
      if (startup !== undefined) {
        await settledBefore(startup, deadline);
      }
      let closeFlight = this.ensureListenerClose();

      await waitUntil(
        () => this.clients.size === 0,
        Math.min(deadline, performance.now() + this.shutdownGraceMs),
      );
      for (const client of this.clients) {
        if (!client.destroyed) client.destroy();
      }

      closeFlight = closeFlight ?? this.ensureListenerClose();
      if (closeFlight !== undefined) {
        await settledBefore(closeFlight, deadline);
      }
      await waitUntil(
        () => this.clients.size === 0,
        deadline,
      );

      // A listener close may have become eligible after a replacement was
      // removed between calls. Retry at the fixed point.
      closeFlight = this.ensureListenerClose();
      if (closeFlight !== undefined && performance.now() < deadline) {
        await settledBefore(closeFlight, deadline);
      }

      const retainedListener = this.server?.listening === true;
      const retainedSocketPath = this.ownedSocketPathStillPresent();
      const retainedLabels: string[] = [];
      if (this.clients.size > 0) retainedLabels.push("client");
      if (retainedListener) retainedLabels.push("listener");
      if (retainedSocketPath) retainedLabels.push("socket-path");
      if (
        this.listenerLease !== undefined &&
        controlListenerLeaseHeld(this.listenerLease)
      ) {
        retainedLabels.push("listener-lease");
      }
      if (this.pathReplacementBlocked) {
        retainedLabels.push("replacement-path");
      }
      const currentDiagnostics = [...this.diagnostics];
      if (this.pathReplacementBlocked) {
        currentDiagnostics.push(
          "listener: refusing to close Prime Agent reporter over a replacement path",
        );
      }
      const uniqueLabels = Object.freeze([...new Set(retainedLabels)].sort());
      const clean = uniqueLabels.length === 0;
      return Object.freeze({
        clean,
        retainedClients: this.clients.size,
        retainedListener,
        retainedSocketPath,
        retainedLabels: uniqueLabels,
        diagnostics: Object.freeze(currentDiagnostics),
      });
    })();
    this.shutdownFlight = current;
    void current.then(
      () => {
        if (this.shutdownFlight === current) this.shutdownFlight = undefined;
      },
      () => {
        if (this.shutdownFlight === current) this.shutdownFlight = undefined;
      },
    );
    return current;
  }

  private accept(socket: Socket): void {
    socket.unref();
    if (!this.admissionOpen || this.clients.size >= this.maxClients) {
      socket.end(
        errorLine("", "admission_closed", "reporter admission is closed"),
      );
      return;
    }
    this.clients.add(socket);
    let buffered = Buffer.alloc(0);
    let handled = false;

    const reject = (code: string, message: string, id = ""): void => {
      if (handled) return;
      handled = true;
      try {
        socket.end(errorLine(id, code, message));
      } catch {
        socket.destroy();
      }
    };

    socket.on("data", (chunk: Buffer | string) => {
      if (handled) return;
      if (!this.admissionOpen) {
        reject("admission_closed", "reporter admission is closed");
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, bytes]);
      const newline = buffered.indexOf(0x0a);
      const frameBytes = newline < 0 ? buffered.length : newline;
      if (frameBytes > PRIME_AGENT_REPORTER_MAX_LINE_BYTES) {
        reject("request_too_large", "reporter request line is too large");
        return;
      }
      if (newline < 0) return;
      handled = true;
      let frame = buffered.subarray(0, newline);
      if (frame.length > 0 && frame[frame.length - 1] === 0x0d) {
        frame = frame.subarray(0, frame.length - 1);
      }
      this.handleFrame(frame, socket);
      buffered = Buffer.alloc(0);
    });
    socket.once("close", () => {
      this.clients.delete(socket);
    });
    socket.once("error", () => {
      // `close` is the terminal witness. Peer errors never become lifecycle
      // diagnostics for the app-owned listener.
    });
  }

  private handleFrame(frame: Buffer, socket: Socket): void {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.toString("utf8"));
    } catch {
      socket.end(errorLine("", "invalid_request", "invalid JSON request"));
      return;
    }
    const decoded = this.decodeRequest(raw);
    if (!decoded.ok) {
      socket.end(
        errorLine(
          decoded.id,
          decoded.code,
          decoded.message,
        ),
      );
      return;
    }
    const request = decoded.request;
    const registration = this.registrations.get(request.paneId);
    if (registration === undefined || registration.released) {
      socket.end(
        errorLine(
          request.id,
          "unknown_pane",
          "reporter pane is not registered",
        ),
      );
      return;
    }
    if (request.seq <= registration.lastSeq) {
      socket.end(
        errorLine(
          request.id,
          "stale_sequence",
          "reporter sequence must increase monotonically",
        ),
      );
      return;
    }

    // All validation is complete before any registration or seat state moves.
    registration.lastSeq = request.seq;
    if (request.method === "pane.release_agent") {
      this.releaseRegistration(registration, true);
      socket.end(successLine(request.id));
      return;
    }

    const wireState = request.state!;
    const state: PrimeAgentReporterState =
      wireState === "blocked" ? "attention" : wireState;
    registration.lastState = state;
    if (request.sessionId !== undefined) {
      registration.lastSessionId = request.sessionId;
    }
    if (request.sessionPath !== undefined) {
      registration.lastSessionPath = request.sessionPath;
    }
    this.emitReport(registration, {
      bindingId: registration.bindingId,
      epoch: registration.epoch,
      state,
      reason: `prime_agent_reporter_${wireState}`,
      ...(request.message === undefined
        ? {}
        : { message: request.message }),
      ...(request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId }),
      ...(request.sessionPath === undefined
        ? {}
        : { sessionPath: request.sessionPath }),
    });
    socket.end(successLine(request.id));
  }

  private decodeRequest(raw: unknown): DecodeResult {
    if (!isRecord(raw)) {
      return {
        ok: false,
        id: "",
        code: "invalid_request",
        message: "request must be an object",
      };
    }
    const id = boundedRequestId(raw.id) ? raw.id : "";
    if (id.length === 0) {
      return {
        ok: false,
        id,
        code: "invalid_request",
        message: "request id is missing or invalid",
      };
    }
    if (
      raw.method !== "pane.report_agent" &&
      raw.method !== "pane.release_agent"
    ) {
      return {
        ok: false,
        id,
        code: "method_not_supported",
        message: "unsupported reporter method",
      };
    }
    if (!isRecord(raw.params)) {
      return {
        ok: false,
        id,
        code: "invalid_params",
        message: "request params must be an object",
      };
    }
    const params = raw.params;
    if (typeof params.pane_id !== "string" || params.pane_id.length === 0) {
      return {
        ok: false,
        id,
        code: "invalid_params",
        message: "pane_id is missing or invalid",
      };
    }
    if (params.source !== PRIME_AGENT_SOURCE) {
      return {
        ok: false,
        id,
        code: "invalid_source",
        message: "unexpected reporter source",
      };
    }
    if (params.agent !== PRIME_AGENT_LABEL) {
      return {
        ok: false,
        id,
        code: "invalid_agent",
        message: "unexpected reporter agent",
      };
    }
    if (
      typeof params.seq !== "number" ||
      !Number.isSafeInteger(params.seq) ||
      params.seq < 0
    ) {
      return {
        ok: false,
        id,
        code: "invalid_sequence",
        message: "reporter sequence must be a finite non-negative integer",
      };
    }

    if (raw.method === "pane.release_agent") {
      return {
        ok: true,
        request: {
          id,
          method: raw.method,
          paneId: params.pane_id,
          seq: params.seq,
        },
      };
    }

    if (
      params.state !== "idle" &&
      params.state !== "working" &&
      params.state !== "blocked"
    ) {
      return {
        ok: false,
        id,
        code: "invalid_state",
        message: "unsupported reporter state",
      };
    }
    if (
      params.message !== undefined &&
      !boundedMessage(params.message)
    ) {
      return {
        ok: false,
        id,
        code: "invalid_message",
        message: "reporter message is invalid or too large",
      };
    }
    if (
      params.agent_session_id !== undefined &&
      !boundedSessionId(params.agent_session_id)
    ) {
      return {
        ok: false,
        id,
        code: "invalid_session_id",
        message: "agent session id is invalid or too large",
      };
    }
    if (
      params.agent_session_path !== undefined &&
      !absoluteSessionPath(params.agent_session_path)
    ) {
      return {
        ok: false,
        id,
        code: "invalid_session_path",
        message: "agent session path must be absolute and bounded",
      };
    }

    const sessionPath = params.agent_session_path as string | undefined;
    const suppliedSessionId = params.agent_session_id as string | undefined;
    const sessionId =
      suppliedSessionId ??
      (sessionPath === undefined ? undefined : deriveSessionId(sessionPath));
    return {
      ok: true,
      request: {
        id,
        method: raw.method,
        paneId: params.pane_id,
        seq: params.seq,
        state: params.state,
        ...(params.message === undefined
          ? {}
          : { message: params.message as string }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(sessionPath === undefined ? {} : { sessionPath }),
      },
    };
  }

  private releaseRegistration(
    registration: ReporterRegistrationRecord,
    notify: boolean,
  ): boolean {
    if (
      registration.released ||
      this.registrations.get(registration.paneId) !== registration
    ) {
      return false;
    }
    registration.released = true;
    this.registrations.delete(registration.paneId);
    if (notify) {
      this.emitReport(registration, {
        bindingId: registration.bindingId,
        epoch: registration.epoch,
        state: "idle",
        reason: "prime_agent_reporter_released",
        ...(registration.lastSessionId === undefined
          ? {}
          : { sessionId: registration.lastSessionId }),
        ...(registration.lastSessionPath === undefined
          ? {}
          : { sessionPath: registration.lastSessionPath }),
        released: true,
      });
    }
    return true;
  }

  private emitReport(
    registration: ReporterRegistrationRecord,
    report: PrimeAgentReporterReport,
  ): void {
    try {
      registration.onReport(Object.freeze(report));
    } catch (error) {
      console.error(
        `[term] Prime Agent reporter callback failed for ${registration.bindingId}@${registration.epoch}:`,
        error,
      );
    }
  }

  private ensureListenerClose(): Promise<void> | undefined {
    if (this.listenerCloseFlight !== undefined) {
      return this.listenerCloseFlight;
    }
    const server = this.server;
    if (server === undefined) {
      return undefined;
    }
    if (server.listening && this.foreignPathOccupiesCanonical()) {
      this.pathReplacementBlocked = true;
      server.unref();
      return undefined;
    }
    this.pathReplacementBlocked = false;
    const close = closeServer(server)
      .then(() => this.cleanupListener(server))
      .catch((error) => {
        this.diagnostics.push(
          `listener-close: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      });
    this.listenerCloseFlight = close;
    void close.then(
      () => {
        if (this.listenerCloseFlight === close) {
          this.listenerCloseFlight = undefined;
        }
      },
      () => {
        if (this.listenerCloseFlight === close) {
          this.listenerCloseFlight = undefined;
        }
      },
    );
    return close;
  }

  private async cleanupListener(server: Server): Promise<void> {
    if (this.server !== server) return;
    const lease = this.listenerLease;
    const identity = this.socketIdentity;
    const path = this.socketPathValue;
    try {
      if (
        lease !== undefined &&
        identity !== undefined &&
        controlListenerLeaseHeld(lease)
      ) {
        removeOwnedControlSocketPath(lease, identity);
      } else if (
        identity !== undefined &&
        path !== undefined &&
        this.pathMatchesIdentity(path, identity)
      ) {
        unlinkSync(path);
      }
    } finally {
      if (lease !== undefined && controlListenerLeaseHeld(lease)) {
        await releaseControlListenerLease(lease);
      }
    }
    this.server = undefined;
    this.listenerLease = undefined;
    this.socketIdentity = undefined;
    this.started = false;
    this.pathReplacementBlocked = false;
  }

  private foreignPathOccupiesCanonical(): boolean {
    const path = this.socketPathValue;
    const identity = this.socketIdentity;
    if (path === undefined || identity === undefined) return false;
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
    return !this.pathMatchesIdentity(path, identity);
  }

  private ownedSocketPathStillPresent(): boolean {
    const path = this.socketPathValue;
    const identity = this.socketIdentity;
    return (
      path !== undefined &&
      identity !== undefined &&
      this.pathMatchesIdentity(path, identity)
    );
  }

  private pathMatchesIdentity(
    path: string,
    identity: ControlSocketPathIdentity,
  ): boolean {
    try {
      const current = lstatSync(path, { bigint: true });
      return (
        current.isSocket() &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.birthtimeNs === identity.birthtimeNs &&
        current.uid === identity.uid
      );
    } catch {
      return false;
    }
  }
}

/** Process singleton shared by the production daemon plane and terminal plane. */
export const primeAgentReporterPlane = new PrimeAgentReporterPlane();
