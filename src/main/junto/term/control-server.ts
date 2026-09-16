/**
 * Local term control server — exposes LocalSessionHost over a Unix socket so
 * Command Center can reach the same API on a Remote station via SSH forward.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import {
  decodeTermControlActorSeatRequest,
  decodeTermMaintenanceRequest,
  TERM_CONTROL_PROTOCOL,
  TERM_MAX_FRAME_BYTES,
  termControlDir,
  termControlSocketPath,
  termControlTokenPath,
  type TermMaintenanceAcquirePayload,
  type TermMaintenanceFencePayload,
  type TermMaintenanceQuiescenceEvidence,
  type TermMaintenanceReleasePayload,
  type TermControlRequest,
  type TermControlResponse,
} from "@shared/term-control";
import {
  occupancyFromSummary,
  seatAdmission,
} from "@shared/terminal-seat-occupancy";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { sessionActorMatches } from "@shared/terminal";
import { seatTapeFromSummary } from "@shared/transport-trace";
import { appendTransportTrace } from "../observability/transport-journal";
import { seatStateRuntime } from "./agent-state";
import type {
  ControlLease,
  LocalHostEvent,
  LocalSessionHost,
  LocalTerminalMaintenanceLease,
} from "./local-host";
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
import {
  observeLinuxReleaseFence,
  type LinuxReleaseFenceObservation,
} from "./release-fence";
import { readHostDirectory } from "./host-directory";
import { launchForManagedSpawnIntent } from "./managed-spawn-plan";
import { managedTerminalDriveForOverseer } from "./managed-drive-holder";

const tokenHash = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

const safeEqualToken = (a: string, b: string): boolean => {
  try {
    const ba = tokenHash(a);
    const bb = tokenHash(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

/** JSON cannot encode bigint — wire seq as decimal string over NDJSON. */
const jsonLine = (value: unknown): string =>
  `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`;

export type TermControlServer = {
  readonly socketPath: string;
  readonly token: string;
  /** Synchronous UDS/frame admission cut. */
  readonly beginShutdown: () => void;
  /** Bounded, retryable fixed-point drain with exact close witnesses. */
  readonly drainOnQuit: () => Promise<TermControlServerShutdownReceipt>;
  /** Compatibility lifecycle entry point; rejects rather than hiding an unclean drain. */
  readonly close: () => Promise<void>;
};

export interface TermControlServerRetainedCounts {
  readonly requests: number;
  readonly listenerClosures: number;
  readonly sockets: number;
  readonly socketPaths: number;
}

export interface TermControlServerShutdownReceipt {
  readonly clean: boolean;
  readonly rounds: number;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly retainedCounts: TermControlServerRetainedCounts;
  readonly retainedLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

/** A post-bind startup failure retains the exact listener authority for its caller. */
export class TermControlStartupError extends Error {
  readonly name = "TermControlStartupError";

  constructor(
    readonly startupCause: unknown,
    readonly control: TermControlServer,
    readonly receipt: TermControlServerShutdownReceipt,
  ) {
    super(
      `terminal control startup failed: ${startupCause instanceof Error ? startupCause.message : String(startupCause)}`,
    );
  }
}

type TermControlFlight = {
  readonly id: number;
  readonly kind: "request" | "listener-close" | "socket-close";
  readonly label: string;
  readonly promise: Promise<unknown>;
  status: "pending" | "fulfilled" | "rejected";
};

type TermControlSocket = {
  readonly id: number;
  readonly socket: Socket;
  readonly closed: Promise<void>;
};

const TERM_CONTROL_SHUTDOWN_GRACE_MS = 100;
const TERM_CONTROL_SHUTDOWN_DEADLINE_MS = 2_000;
const TERM_CONTROL_MAX_CLIENTS = 32;

const boundedRuntimeValue = (value: number | undefined, ceiling: number): number =>
  value === undefined || !Number.isFinite(value) || value <= 0
    ? ceiling
    : Math.min(Math.floor(value), ceiling);

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, durationMs));

const allSettledBefore = async (
  promises: ReadonlyArray<Promise<unknown>>,
  deadline: number,
): Promise<
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly outcomes: ReadonlyArray<PromiseSettledResult<unknown>> }
> => {
  const remainingMs = Math.max(0, deadline - performance.now());
  if (remainingMs === 0) return { timedOut: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(promises).then((outcomes) => ({
        timedOut: false as const,
        outcomes,
      })),
      new Promise<{ readonly timedOut: true }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ timedOut: true }), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const probeExistingSocket = (
  socketPath: string,
): Promise<"active" | "stale" | "unknown"> =>
  new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let outcome: "active" | "stale" | "unknown" | undefined;
    let closeObserved = false;
    let resolved = false;
    const finishIfClosed = (): void => {
      if (resolved || outcome === undefined || !closeObserved) return;
      resolved = true;
      resolve(outcome);
    };
    const finish = (candidate: "active" | "stale" | "unknown"): void => {
      if (outcome !== undefined) return;
      outcome = candidate;
      clearTimeout(timer);
      socket.destroy();
      finishIfClosed();
    };
    const timer = setTimeout(() => finish("unknown"), 100);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? "stale"
          : "unknown",
      );
    });
    socket.once("close", () => {
      closeObserved = true;
      if (outcome === undefined) outcome = "unknown";
      finishIfClosed();
    });
  });

const publishTermToken = (tokenPath: string, token: string): void => {
  rotateControlFileToken(tokenPath, token);
};

export const startTermControlServer = async (
  host: LocalSessionHost,
  options?: {
    readonly home?: string;
    /** Tests may lower, never raise, the graceful peer-close window. */
    readonly shutdownGraceMs?: number;
    /** Tests may lower, never raise, the complete drain deadline. */
    readonly shutdownDeadlineMs?: number;
    /** Test seam for path-replacement races; production uses chmodSync. */
    readonly chmodSocket?: (path: string, mode: number) => void;
    /** Tests may lower, never raise, the accepted peer ceiling. */
    readonly maxActiveClients?: number;
    /** Test seam for the fixed root-owned Linux release fence. */
    readonly observeReleaseFence?: () => LinuxReleaseFenceObservation;
  },
): Promise<TermControlServer> => {
  const home = options?.home;
  const dir = termControlDir(home);
  const socketPath = termControlSocketPath(home);
  const tokenPath = termControlTokenPath(home);
  const shutdownGraceMs = boundedRuntimeValue(
    options?.shutdownGraceMs,
    TERM_CONTROL_SHUTDOWN_GRACE_MS,
  );
  const shutdownDeadlineMs = boundedRuntimeValue(
    options?.shutdownDeadlineMs,
    TERM_CONTROL_SHUTDOWN_DEADLINE_MS,
  );
  const maxActiveClients = boundedRuntimeValue(options?.maxActiveClients, TERM_CONTROL_MAX_CLIENTS);
  const observeReleaseFence =
    options?.observeReleaseFence ?? observeLinuxReleaseFence;
  prepareControlDirectory(dir);

  const token = randomBytes(32).toString("hex");

  /** leaseId → sockets subscribed to that session's events */
  const leaseSockets = new Map<string, Set<Socket>>();
  const socketLeases = new Map<Socket, Set<string>>();
  const leaseById = new Map<string, ControlLease>();
  /** Opaque host capabilities never cross the authenticated socket boundary. */
  const maintenanceLeaseBySocket = new Map<
    Socket,
    {
      readonly lease: LocalTerminalMaintenanceLease;
      readonly evidence: TermMaintenanceQuiescenceEvidence;
    }
  >();
  /** Accepted clients and every admitted handler remain visible through shutdown. */
  const sockets = new Map<number, TermControlSocket>();
  const activeFlights = new Map<number, TermControlFlight>();
  const shutdownJournal = new Map<number, TermControlFlight>();
  const diagnostics: string[] = [];
  let nextSocketId = 0;
  let nextFlightId = 0;
  let closing = false;
  let listenerCloseFlight: Promise<void> | undefined;
  let drainFlight: Promise<TermControlServerShutdownReceipt> | undefined;
  const admittedClients = new Set<Socket>();
  /** Seat-state hops only — admittedClients is the connection ceiling. */
  const authedClients = new Set<Socket>();

  const recordDiagnostic = (label: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`${label}: ${message}`);
  };

  const retainFlight = <A>(
    kind: TermControlFlight["kind"],
    label: string,
    promise: Promise<A>,
  ): Promise<A> => {
    const flight: TermControlFlight = {
      id: ++nextFlightId,
      kind,
      label,
      promise,
      status: "pending",
    };
    activeFlights.set(flight.id, flight);
    if (closing) shutdownJournal.set(flight.id, flight);
    void promise.then(
      () => {
        flight.status = "fulfilled";
        activeFlights.delete(flight.id);
      },
      (error) => {
        flight.status = "rejected";
        activeFlights.delete(flight.id);
        // The bounded drain counts this rejection for the current receipt.
        // Do not make a retryable listener/path refusal permanently sticky.
        void error;
      },
    );
    return promise;
  };

  const trackLease = (socket: Socket, lease: ControlLease): void => {
    leaseById.set(lease.leaseId, lease);
    let set = leaseSockets.get(lease.leaseId);
    if (!set) {
      set = new Set();
      leaseSockets.set(lease.leaseId, set);
    }
    set.add(socket);
    let owned = socketLeases.get(socket);
    if (!owned) {
      owned = new Set();
      socketLeases.set(socket, owned);
    }
    owned.add(lease.leaseId);
  };

  const releaseMaintenanceForSocket = (socket: Socket): boolean => {
    const entry = maintenanceLeaseBySocket.get(socket);
    if (entry === undefined) return false;
    maintenanceLeaseBySocket.delete(socket);
    return host.releaseMaintenanceLease(entry.lease);
  };

  const dropSocket = (socket: Socket): void => {
    const owned = socketLeases.get(socket);
    socketLeases.delete(socket);
    if (!owned) return;
    for (const leaseId of owned) {
      const set = leaseSockets.get(leaseId);
      set?.delete(socket);
      if (set && set.size === 0) leaseSockets.delete(leaseId);
      const lease = leaseById.get(leaseId);
      if (lease) {
        host.release(lease);
        leaseById.delete(leaseId);
      }
    }
  };

  const writeEvent = (payload: LocalHostEvent, targets: Iterable<Socket>): void => {
    const line = jsonLine({ v: TERM_CONTROL_PROTOCOL, type: "event", payload });
    for (const sock of targets) {
      if (sock.destroyed) continue;
      try {
        sock.write(line);
      } catch {
        dropSocket(sock);
      }
    }
  };

  const onHostEvent = (payload: LocalHostEvent): void => {
    if (payload.type === "seat-state") {
      writeEvent(payload, authedClients);
      return;
    }
    const line = jsonLine({ v: TERM_CONTROL_PROTOCOL, type: "event", payload });
    for (const [leaseId, socks] of leaseSockets) {
      const lease = leaseById.get(leaseId);
      if (!lease || lease.bindingId !== payload.bindingId || lease.epoch !== payload.epoch) {
        continue;
      }
      for (const sock of [...socks]) {
        if (sock.destroyed) {
          dropSocket(sock);
          continue;
        }
        try {
          sock.write(line);
        } catch {
          dropSocket(sock);
        }
      }
    }
  };
  const handle = async (
    req: TermControlRequest,
    socket: Socket,
  ): Promise<TermControlResponse> => {
    const id = req.id;
    try {
      switch (req.op) {
        case "ping":
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: { pong: true } };
        case "create": {
          if (
            Object.prototype.hasOwnProperty.call(req, "harness") ||
            Object.prototype.hasOwnProperty.call(req, "agentKey") ||
            Object.prototype.hasOwnProperty.call(req, "spawnIntent") ||
            Object.prototype.hasOwnProperty.call(req, "firstTypedMessage")
          ) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "create does not accept harness or agentKey or actor spawn intent; use createAgentSeat",
            };
          }
          const summary = host.create({
            bindingId: req.bindingId,
            launch: req.launch,
            cols: req.cols,
            rows: req.rows,
            canvasName: req.canvasName,
            nodeId: req.nodeId,
            label: req.label,
          });
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: summary };
        }
        case "createAgentSeat": {
          const actorReq = decodeTermControlActorSeatRequest(req);
          if (!actorReq) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "invalid createAgentSeat admission request",
            };
          }
          const bindingId = actorReq.bindingId.trim();
          const harnessField = actorReq.harness.trim();
          const agentKeyField = actorReq.agentKey.trim();
          const canvasNameField = actorReq.canvasName;
          const nodeIdField = actorReq.nodeId;
          if (!bindingId) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "createAgentSeat requires bindingId",
            };
          }
          if (!isHarnessId(harnessField) || agentKeyField === "") {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: !isHarnessId(harnessField) && harnessField !== ""
                ? `unknown harness ${harnessField}`
                : "createAgentSeat requires harness and agentKey",
            };
          }
          if (!canvasNameField.trim() || !nodeIdField.trim()) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "createAgentSeat requires canvasName and nodeId",
            };
          }
          const actor = {
            harness: harnessField,
            agentKey: agentKeyField,
            canvasName: canvasNameField,
            nodeId: nodeIdField,
          };
          // This snapshot and the synchronous mutation below are one event-loop
          // turn: admission cannot race another control request on this host.
          const existing = host.get(bindingId);
          const occupancy = occupancyFromSummary(
            bindingId,
            existing,
            "local",
          );
          const hostAdmission = seatAdmission(occupancy);
          appendTransportTrace({
            plane: "term",
            op: "host.get",
            ok: true,
            bindingId,
            ...seatTapeFromSummary(bindingId, existing),
          });

          if (actorReq.admission === "activate") {
            if (hostAdmission._tag !== "ActivateOccupiedSeat" || !existing) {
              return {
                v: TERM_CONTROL_PROTOCOL,
                id,
                ok: false,
                error: `seat ${bindingId} is vacant; activate requires an occupant`,
              };
            }
            const expectedEpoch = actorReq.expectedEpoch.trim();
            if (existing.epoch !== expectedEpoch) {
              return {
                v: TERM_CONTROL_PROTOCOL,
                id,
                ok: false,
                error: `seat ${bindingId} changed generation from ${expectedEpoch} to ${existing.epoch}`,
              };
            }
            // Actor identity is immutable for a live generation. Activation is
            // validate-only: an exact identity match returns the existing
            // generation; anything else (geography occupants included) is a
            // conflict — the occupant is never adopted or repurposed.
            const alreadyBound =
              sessionActorMatches(existing, actor) &&
              existing.canvasName === actor.canvasName &&
              existing.nodeId === actor.nodeId;
            if (alreadyBound) {
              return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: existing };
            }
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: `seat ${bindingId} is occupied by a different actor identity`,
            };
          }

          if (hostAdmission._tag !== "OccupyVacantSeat") {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: `seat ${bindingId} is already occupied`,
            };
          }
          const finalized = launchForManagedSpawnIntent(
            actor,
            actorReq.spawnIntent,
          );
          if (!finalized.launch || !finalized.plan) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "createAgentSeat could not resolve managed launch",
            };
          }
          const summary = host.createAgentSeat({
            bindingId,
            harness: actor.harness,
            agentKey: actor.agentKey,
            launch: finalized.launch,
            resumeFallbackIntent: actorReq.spawnIntent,
            cols: actorReq.cols,
            rows: actorReq.rows,
            canvasName: actor.canvasName,
            nodeId: actor.nodeId,
            label: actorReq.label,
            ...(finalized.plan.firstTypedMessage
              ? { firstTypedMessage: finalized.plan.firstTypedMessage }
              : {}),
          });
          if (
            !sessionActorMatches(summary, actor) ||
            summary.canvasName !== actor.canvasName ||
            summary.nodeId !== actor.nodeId
          ) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "remote seat did not bind actor identity",
            };
          }
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: summary };
        }
        case "list":
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: { sessions: host.list() } };
        case "directory.read":
          return {
            v: TERM_CONTROL_PROTOCOL,
            id,
            ok: true,
            data: await readHostDirectory(req.path),
          };
        case "get": {
          const summary = host.get(req.bindingId) ?? null;
          appendTransportTrace({
            plane: "term",
            op: "host.get",
            ok: true,
            bindingId: req.bindingId,
            ...seatTapeFromSummary(req.bindingId, summary),
          });
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: summary };
        }
        case "kill":
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: host.kill(req.bindingId) };
        case "bindCanvas":
          host.bindCanvas(req.bindingId, req.ref);
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true };
        case "attach": {
          const result = await host.attach({
            bindingId: req.bindingId,
            mode: req.mode,
            takeover: req.takeover,
          });
          if (!result.ok) return { v: TERM_CONTROL_PROTOCOL, id, ok: false, error: result.message };
          trackLease(socket, result.lease);
          return {
            v: TERM_CONTROL_PROTOCOL,
            id,
            ok: true,
            data: {
              leaseId: result.lease.leaseId,
              bindingId: result.lease.bindingId,
              epoch: result.lease.epoch,
              mode: result.lease.mode,
              cols: result.cols,
              rows: result.rows,
              status: result.status,
              pid: result.pid,
              screen: result.screen,
              journal: result.journal,
            },
          };
        }
        case "release": {
          const lease = leaseById.get(req.leaseId);
          if (lease) {
            host.release(lease);
            leaseById.delete(req.leaseId);
            leaseSockets.get(req.leaseId)?.delete(socket);
            socketLeases.get(socket)?.delete(req.leaseId);
          }
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true };
        }
        case "write": {
          const lease = leaseById.get(req.leaseId);
          if (!lease) return { v: TERM_CONTROL_PROTOCOL, id, ok: false, error: "unknown lease" };
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: host.write(lease, req.data) };
        }
        case "managedPrompt": {
          // Lease-free product-automation delivery through the destination
          // drive. Never raw-writes: a missing holder refuses explicitly.
          // No cancellation identity — the drive owns bounded completion.
          const bindingId =
            typeof req.bindingId === "string" ? req.bindingId.trim() : "";
          const text = typeof req.text === "string" ? req.text : "";
          if (!bindingId || !text) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "managedPrompt requires bindingId and text",
            };
          }
          const drive = managedTerminalDriveForOverseer();
          if (drive === undefined) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "no destination managed drive; refusing raw write",
            };
          }
          const delivered = await drive.writePrompt(bindingId, text, {
            queueIfBusy: req.queueIfBusy === true,
          });
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data: delivered };
        }
        case "resize": {
          const lease = leaseById.get(req.leaseId);
          if (!lease) return { v: TERM_CONTROL_PROTOCOL, id, ok: false, error: "unknown lease" };
          return {
            v: TERM_CONTROL_PROTOCOL,
            id,
            ok: true,
            data: host.resize(lease, req.cols, req.rows),
          };
        }
        case "maintenance.acquire": {
          if (decodeTermMaintenanceRequest(req) === undefined) {
            return { v: TERM_CONTROL_PROTOCOL, id, ok: false, error: "invalid maintenance request" };
          }
          const result = host.acquireMaintenanceLease();
          if (!result.acquired) {
            const data = {
              acquired: false,
              evidence: result.evidence,
              reason: result.reason,
            } satisfies TermMaintenanceAcquirePayload;
            return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data };
          }
          maintenanceLeaseBySocket.set(socket, {
            lease: result.lease,
            evidence: result.evidence,
          });
          const data = {
            acquired: true,
            evidence: result.evidence,
          } satisfies TermMaintenanceAcquirePayload;
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data };
        }
        case "maintenance.fence": {
          if (decodeTermMaintenanceRequest(req) === undefined) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "invalid maintenance request",
            };
          }
          const entry = maintenanceLeaseBySocket.get(socket);
          if (entry === undefined) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "terminal maintenance lease required",
            };
          }
          if (host.runningCount() !== 0) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "terminal maintenance lost quiescence",
            };
          }
          const observation = observeReleaseFence();
          if (
            observation.state !== "active" ||
            observation.fence.targetUid !== process.getuid?.() ||
            observation.fence.targetGid !== process.getgid?.()
          ) {
            return {
              v: TERM_CONTROL_PROTOCOL,
              id,
              ok: false,
              error: "root release fence is not exact for this machine",
            };
          }
          const data = {
            acknowledged: true,
            evidence: entry.evidence,
            fence: observation.fence,
          } satisfies TermMaintenanceFencePayload;
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data };
        }
        case "maintenance.release": {
          if (decodeTermMaintenanceRequest(req) === undefined) {
            return { v: TERM_CONTROL_PROTOCOL, id, ok: false, error: "invalid maintenance request" };
          }
          const data = {
            released: releaseMaintenanceForSocket(socket),
          } satisfies TermMaintenanceReleasePayload;
          return { v: TERM_CONTROL_PROTOCOL, id, ok: true, data };
        }
        case "shutdown":
          // Remote operator must not mass-kill via socket; only local app quit.
          return {
            v: TERM_CONTROL_PROTOCOL,
            id,
            ok: false,
            error: "shutdown not allowed over control socket",
          };
        default:
          return { v: TERM_CONTROL_PROTOCOL, id, ok: false, error: "unknown op" };
      }
    } catch (err) {
      return {
        v: TERM_CONTROL_PROTOCOL,
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const server: Server = createServer((socket) => {
    if (closing || admittedClients.size >= maxActiveClients) {
      socket.end();
      return;
    }
    admittedClients.add(socket);
    const socketId = ++nextSocketId;
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });
    sockets.set(socketId, { id: socketId, socket, closed: socketClosed });
    void retainFlight("socket-close", "socket", socketClosed);
    let buf = "";
    let authed = false;
    let closed = false;

    const fail = (msg: string): void => {
      if (closed) return;
      try {
        socket.write(
          jsonLine({
            v: TERM_CONTROL_PROTOCOL,
            id: "0",
            ok: false,
            error: msg,
          } satisfies TermControlResponse),
        );
      } catch {
        // ignore
      }
      socket.destroy();
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (closed || closing) {
        socket.destroy();
        return;
      }
      buf += chunk;
      if (buf.length > TERM_MAX_FRAME_BYTES) {
        fail("frame too large");
        return;
      }
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          fail("invalid json");
          return;
        }
        if (!authed) {
          const auth = msg as { token?: string };
          if (typeof auth?.token !== "string" || !safeEqualToken(auth.token, token)) {
            fail("unauthorized");
            return;
          }
          authed = true;
          authedClients.add(socket);
          const snapshot = seatStateRuntime.currentEvents();
          try {
            socket.write(
              jsonLine({
                v: TERM_CONTROL_PROTOCOL,
                id: "auth",
                ok: true,
                data: { seatState: snapshot },
              }),
            );
          } catch {
            // ignore
          }
          // Snapshot rides the auth ack only. A second writeEvent dump
          // would double-deliver after the client flushes its queue.
          continue;
        }
        const wire = msg as {
          readonly v?: unknown;
          readonly id?: unknown;
          readonly op?: unknown;
        };
        if (
          wire &&
          typeof wire.v === "number" &&
          wire.v !== TERM_CONTROL_PROTOCOL &&
          typeof wire.id === "string" &&
          typeof wire.op === "string"
        ) {
          try {
            socket.write(
              jsonLine({
                v: TERM_CONTROL_PROTOCOL,
                id: wire.id,
                ok: false,
                error: `term control protocol ${wire.v} is unsupported; update required`,
              } satisfies TermControlResponse),
            );
          } catch {
            socket.destroy();
          }
          continue;
        }
        const req = msg as TermControlRequest;
        if (
          !req ||
          req.v !== TERM_CONTROL_PROTOCOL ||
          typeof req.id !== "string" ||
          typeof req.op !== "string"
        ) {
          fail("invalid request");
          return;
        }
        const operation = Promise.resolve()
          .then(() =>
            closed || closing || socket.destroyed
              ? undefined
              : handle(req, socket),
          )
          .then((res) => {
            if (res === undefined || socket.destroyed || closing) return;
            try {
              socket.write(jsonLine(res));
            } catch (error) {
              dropSocket(socket);
              socket.destroy();
              throw error;
            }
          });
        void retainFlight("request", `request:${req.op}`, operation).catch(() => undefined);
      }
    });
    socket.on("close", () => {
      admittedClients.delete(socket);
      authedClients.delete(socket);
      closed = true;
      sockets.delete(socketId);
      releaseMaintenanceForSocket(socket);
      dropSocket(socket);
      resolveSocketClosed();
    });
    socket.on("error", (error) => {
      closed = true;
      dropSocket(socket);
      // A peer transport error is not terminal proof, so retain this socket
      // until its `close` witness. Once that witness arrives, a reset peer has
      // no app-owned authority left to block shutdown.
      void error;
    });
    if (closing) socket.destroy();
  });

  const listenerLease = await acquireControlListenerLease(socketPath);
  try {
    await removeObservedSocket(listenerLease);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await releaseControlListenerLease(listenerLease);
    throw error;
  }

  let socketIdentity: ControlSocketPathIdentity | undefined;
  let socketPathCleanupBlocked = false;

  /**
   * Pathname still names the exact inode we bound. Independent of the kernel
   * listener lease: a lease can be gone by the time quit drain runs, and close
   * must still be able to retire *our* socket.
   */
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

  const unlinkOwnedSocket = (): void => {
    if (
      socketIdentity !== undefined &&
      controlListenerLeaseHeld(listenerLease)
    ) {
      removeOwnedControlSocketPath(listenerLease, socketIdentity);
      return;
    }
    // Lease may already be dead. Identity is still
    // enough to remove our residual pathname without touching a replacement.
    if (pathMatchesCapturedIdentity()) {
      unlinkSync(socketPath);
    }
  };

  const closeListenerWithoutDeletingReplacement = async (): Promise<void> => {
    if (existsSync(socketPath) && !pathMatchesCapturedIdentity()) {
      // libuv may unlink the originally-bound path as Server.close runs. Node
      // has no identity-checked close primitive, so retain the listener rather
      // than deleting a path another owner installed after our bind.
      socketPathCleanupBlocked = true;
      server.unref();
      throw new Error("refusing to close terminal listener over a replacement path");
    }
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
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
    void retainFlight("listener-close", "listener", close).catch(() => undefined);
    void close.then(
      () => {
        if (listenerCloseFlight === close) listenerCloseFlight = undefined;
      },
      () => {
        if (listenerCloseFlight === close) listenerCloseFlight = undefined;
      },
    );
  };

  server.on("error", (error) => recordDiagnostic("listener", error));

  let stopSeatState = (): void => {};
  const beginShutdown = (): void => {
    if (closing) return;
    // This assignment is the admission cut. Socket callbacks and each frame
    // boundary check it before minting a session/control lease.
    // Do not unlink the pathname here: early unlink opens a replacement race
    // that can permanently refuse listener close. Path cleanup runs only after
    // Server.close (or identity-checked residual unlink once not listening).
    closing = true;
    stopSeatState();
    host.off("event", onHostEvent);
    for (const flight of activeFlights.values()) shutdownJournal.set(flight.id, flight);
    ensureListenerClose();
    for (const { socket } of sockets.values()) {
      if (!socket.destroyed) socket.end();
    }
  };

  const retainedSnapshot = (): {
    readonly counts: TermControlServerRetainedCounts;
    readonly labels: ReadonlyArray<string>;
  } => {
    const pending = [...shutdownJournal.values()].filter(
      (flight) => flight.status === "pending",
    );
    const countKind = (kind: TermControlFlight["kind"]): number =>
      pending.filter((flight) => flight.kind === kind).length;
    const counts: TermControlServerRetainedCounts = {
      requests: countKind("request"),
      listenerClosures: Math.max(
        countKind("listener-close"),
        server.listening || controlListenerLeaseHeld(listenerLease) ? 1 : 0,
      ),
      sockets: sockets.size,
      socketPaths: pathMatchesCapturedIdentity() || socketPathCleanupBlocked ? 1 : 0,
    };
    const labels = new Set(
      pending
        .filter((flight) => flight.kind !== "socket-close")
        .map((flight) => flight.label),
    );
    if (sockets.size > 0) labels.add("socket");
    if (server.listening || controlListenerLeaseHeld(listenerLease)) labels.add("listener");
    if (counts.socketPaths > 0) labels.add("socket-path");
    return { counts, labels: [...labels].sort() };
  };

  const drainOnQuit = (): Promise<TermControlServerShutdownReceipt> => {
    beginShutdown();
    if (drainFlight !== undefined) return drainFlight;
    // Retry a previously refused listener close after path ownership changes.
    ensureListenerClose();
    const current = (async (): Promise<TermControlServerShutdownReceipt> => {
      const deadline = performance.now() + shutdownDeadlineMs;
      let rounds = 0;
      let settled = 0;
      let fulfilled = 0;
      let rejected = 0;

      const graceful = [...sockets.values()].map((entry) => entry.closed);
      if (graceful.length > 0) {
        await allSettledBefore(
          graceful,
          Math.min(deadline, performance.now() + shutdownGraceMs),
        );
      }
      for (const { socket } of sockets.values()) {
        if (!socket.destroyed) socket.destroy();
      }

      for (;;) {
        for (const { socket } of sockets.values()) {
          if (!socket.destroyed) socket.destroy();
        }
        // Residual path cleanup only after the listener is down — never while
        // Server.close may still need the owned pathname identity.
        if (!server.listening) {
          try {
            unlinkOwnedSocket();
          } catch (error) {
            recordDiagnostic("socket-path", error);
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
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
          continue;
        }

        const retained = retainedSnapshot();
        if (Object.values(retained.counts).every((count) => count === 0)) {
          const currentDiagnostics = Object.freeze([...diagnostics]);
          return Object.freeze({
            clean: rejected === 0 && currentDiagnostics.length === 0,
            rounds,
            settled,
            fulfilled,
            rejected,
            retainedCounts: Object.freeze(retained.counts),
            retainedLabels: Object.freeze(retained.labels),
            diagnostics: currentDiagnostics,
          });
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) break;
        await wait(Math.min(5, remainingMs));
      }

      const retained = retainedSnapshot();
      const currentDiagnostics = Object.freeze([...diagnostics]);
      return Object.freeze({
        clean: false,
        rounds,
        settled,
        fulfilled,
        rejected,
        retainedCounts: Object.freeze(retained.counts),
        retainedLabels: Object.freeze(retained.labels),
        diagnostics: currentDiagnostics,
      });
    })();
    drainFlight = current;
    void current.then(
      () => {
        if (drainFlight === current) drainFlight = undefined;
      },
      () => {
        if (drainFlight === current) drainFlight = undefined;
      },
    );
    return current;
  };

  const control: TermControlServer = {
    socketPath,
    token,
    beginShutdown,
    drainOnQuit,
    close: async () => {
      const receipt = await drainOnQuit();
      if (!receipt.clean) {
        throw new Error(
          `terminal control shutdown retained: ${receipt.retainedLabels.join(", ") || receipt.diagnostics.join(", ") || "unknown resource"}`,
        );
      }
    },
  };

  try {
    socketIdentity = captureControlSocketPathIdentity(listenerLease);
    (options?.chmodSocket ?? chmodSync)(socketPath, 0o600);
    const hardened = lstatSync(socketPath, { bigint: true });
    if (
      !hardened.isSocket() ||
      !controlSocketPathOwnedByLease(listenerLease, socketIdentity)
    ) {
      throw new Error("terminal control socket identity changed during permission hardening");
    }
    // Publish credentials only after the listener path is both owned and
    // permission-hardened. A failed bind must never rotate another live
    // station's token out from underneath it.
    publishTermToken(tokenPath, token);
  } catch (error) {
    // The listener already exists. Preserve its capability in the thrown
    // error when a foreign replacement makes immediate close unsafe; callers
    // can bind it into their aggregate shutdown receipt instead of orphaning
    // an unreturned Server.
    beginShutdown();
    const receipt = await drainOnQuit();
    throw new TermControlStartupError(error, control, receipt);
  }

  host.on("event", onHostEvent);
  stopSeatState = seatStateRuntime.subscribe((event) => {
    writeEvent(
      {
        type: "seat-state",
        bindingId: event.bindingId,
        epoch: event.epoch,
        event,
      },
      authedClients,
    );
  });
  return control;
};

/** Read token written by a live local server (same machine). */
export const readLocalTermToken = (home?: string): string | undefined => {
  try {
    const raw = readFileSync(termControlTokenPath(home), "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
};
