/**
 * NDJSON client for a term control socket (local path or SSH-forwarded path).
 */

import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import {
  decodeTermMaintenanceAcquirePayload,
  decodeTermMaintenanceFencePayload,
  decodeTermMaintenanceReleasePayload,
  type TermMaintenanceDenialReason,
  type TermMaintenanceEvidence,
  type TermMaintenanceFencePayload,
  type TermMaintenanceQuiescenceEvidence,
  type TermMaintenanceReleasePayload,
  type TermControlRequest,
  type TermControlResponse,
} from "@shared/term-control";
import { isAgentSeatState } from "@shared/agent-seat-state";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import { Schema } from "effect";
import { HostDirectorySnapshot } from "@shared/host-directory";
import { formatTransportFrame, seatTapeFromSummary } from "@shared/transport-trace";
import type { ControlLease, JournalEntry, LocalHostEvent } from "./local-host";
import {
  appendTransportTrace,
  recordTransportError,
} from "../observability/transport-journal";

type Pending = {
  resolve: (v: TermControlResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface TermControlClientShutdownReceipt {
  readonly clean: boolean;
  /** A `close` event is the only terminal witness for an opened socket. */
  readonly closeObserved: boolean;
  readonly pendingRequests: number;
  /** Transport errors are diagnostics, never aliases for the close witness. */
  readonly diagnostics: ReadonlyArray<string>;
}

export interface TermControlMaintenanceLease {
  readonly evidence: TermMaintenanceQuiescenceEvidence;
  /** Observe the exact root-owned fence while this socket still holds the cut. */
  readonly acknowledgeFence: () => Promise<TermMaintenanceFencePayload>;
  /** Idempotent and bounded; transport ambiguity rejects and closes the socket. */
  readonly release: () => Promise<TermMaintenanceReleasePayload>;
}

export type TermControlMaintenanceAcquireResult =
  | {
      readonly acquired: true;
      readonly evidence: TermMaintenanceQuiescenceEvidence;
      readonly lease: TermControlMaintenanceLease;
    }
  | {
      readonly acquired: false;
      readonly evidence: TermMaintenanceEvidence;
      readonly reason: TermMaintenanceDenialReason;
    };

/** Narrow package-internal port consumed by deployment coordination. */
export interface TermMaintenanceControlPort {
  acquireMaintenance(): Promise<TermControlMaintenanceAcquireResult>;
}

const SEAT_WIRE_OPS = new Set(["get", "create", "createAgentSeat"]);

const summaryFromTermResponse = (
  response?: TermControlResponse,
): { readonly epoch?: string; readonly status?: string } | null => {
  if (response === undefined || !response.ok || response.data == null) {
    return null;
  }
  if (typeof response.data !== "object") return null;
  return response.data as { readonly epoch?: string; readonly status?: string };
};

const CLIENT_SHUTDOWN_GRACE_MS = 100;
const CLIENT_SHUTDOWN_DEADLINE_MS = 2_000;
const MAINTENANCE_REQUEST_TIMEOUT_MS = 5_000;

const settlesWithin = async (
  promise: Promise<unknown>,
  durationMs: number,
): Promise<boolean> => {
  if (durationMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), durationMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const reviveSeq = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
};

const reviveJournal = (raw: unknown): JournalEntry[] => {
  if (!Array.isArray(raw)) return [];
  const out: JournalEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const seq = reviveSeq(rec.seq);
    if (seq === undefined) continue;
    if (rec.type === "output" && typeof rec.data === "string") {
      out.push({ seq, type: "output", data: rec.data });
    } else if (
      rec.type === "resize" &&
      typeof rec.cols === "number" &&
      typeof rec.rows === "number"
    ) {
      out.push({ seq, type: "resize", cols: rec.cols, rows: rec.rows });
    } else if (rec.type === "exit") {
      out.push({
        seq,
        type: "exit",
        code: typeof rec.code === "number" ? rec.code : undefined,
        signal: typeof rec.signal === "number" ? rec.signal : undefined,
      });
    }
  }
  return out;
};

const reviveHostEvent = (raw: unknown): LocalHostEvent | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const bindingId = typeof rec.bindingId === "string" ? rec.bindingId : "";
  const epoch = typeof rec.epoch === "string" ? rec.epoch : "";
  if (!bindingId || !epoch) return undefined;
  if (rec.type === "output" && typeof rec.data === "string") {
    return {
      type: "output",
      bindingId,
      epoch,
      seq: reviveSeq(rec.seq) ?? 0n,
      data: rec.data,
    };
  }
  if (rec.type === "resize" && typeof rec.cols === "number" && typeof rec.rows === "number") {
    return {
      type: "resize",
      bindingId,
      epoch,
      seq: reviveSeq(rec.seq) ?? 0n,
      cols: rec.cols,
      rows: rec.rows,
    };
  }
  if (rec.type === "exit") {
    return {
      type: "exit",
      bindingId,
      epoch,
      seq: reviveSeq(rec.seq) ?? 0n,
      code: typeof rec.code === "number" ? rec.code : undefined,
      signal: typeof rec.signal === "number" ? rec.signal : undefined,
    };
  }
  if (rec.type === "session" && typeof rec.status === "string") {
    return {
      type: "session",
      bindingId,
      epoch,
      status: rec.status as "starting" | "running" | "exited",
      pid: typeof rec.pid === "number" ? rec.pid : undefined,
    };
  }
  if (rec.type === "seat-state" && rec.event && typeof rec.event === "object") {
    const ev = rec.event as Record<string, unknown>;
    if (
      typeof ev.bindingId === "string" &&
      typeof ev.epoch === "string" &&
      isAgentSeatState(ev.state) &&
      typeof ev.reason === "string" &&
      (ev.confidence === "high" || ev.confidence === "low") &&
      typeof ev.at === "number"
    ) {
      return {
        type: "seat-state",
        bindingId,
        epoch,
        event: {
          bindingId: ev.bindingId,
          epoch: ev.epoch,
          state: ev.state,
          reason: ev.reason,
          confidence: ev.confidence,
          at: ev.at,
          ...(typeof ev.harness === "string" ? { harness: ev.harness } : {}),
        },
      };
    }
  }
  return undefined;
};

/** Test / decode helper — same shape the SSH hop delivers to the router. */
export const reviveTermHostEvent = reviveHostEvent;

/** Revive auth-ack `data.seatState` as hop-shaped LocalHostEvents. */
export const reviveTermAuthSeatState = (data: unknown): LocalHostEvent[] => {
  if (!data || typeof data !== "object") return [];
  const list = (data as { seatState?: unknown }).seatState;
  if (!Array.isArray(list)) return [];
  const out: LocalHostEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const ev = item as Record<string, unknown>;
    const bindingId = typeof ev.bindingId === "string" ? ev.bindingId : "";
    const epoch = typeof ev.epoch === "string" ? ev.epoch : "";
    if (!bindingId || !epoch) continue;
    const revived = reviveHostEvent({
      type: "seat-state",
      bindingId,
      epoch,
      event: ev,
    });
    if (revived) out.push(revived);
  }
  return out;
};

export class TermControlClient extends EventEmitter implements TermMaintenanceControlPort {
  private socket: Socket | undefined;
  private buf = "";
  private authed = false;
  private readonly pending = new Map<string, Pending>();
  private quiescing = false;
  private closeObserved = false;
  private readonly diagnostics: string[] = [];
  private resolveCloseObserved!: () => void;
  private readonly closeWitness = new Promise<void>((resolve) => {
    this.resolveCloseObserved = resolve;
  });
  private drainFlight: Promise<TermControlClientShutdownReceipt> | undefined;
  /** Held until the first `"event"` listener; connect() can beat that attach. */
  private queuedEvents: LocalHostEvent[] | undefined = [];
  private eventFlushScheduled = false;

  private constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {
    super();
    this.on("newListener", (name: string | symbol) => {
      if (name !== "event") return;
      this.scheduleEventFlush();
    });
  }

  private deliverHostEvent(event: LocalHostEvent): void {
    if (this.queuedEvents !== undefined) {
      this.queuedEvents.push(event);
      return;
    }
    this.emit("event", event);
  }

  private scheduleEventFlush(): void {
    if (this.queuedEvents === undefined || this.eventFlushScheduled) return;
    this.eventFlushScheduled = true;
    queueMicrotask(() => {
      const queued = this.queuedEvents;
      this.queuedEvents = undefined;
      this.eventFlushScheduled = false;
      if (!queued) return;
      for (const event of queued) this.emit("event", event);
    });
  }

  /** False after the SSH forward or remote socket has already gone away. */
  isLive(): boolean {
    return (
      this.authed &&
      !this.quiescing &&
      !this.closeObserved &&
      this.socket !== undefined &&
      !this.socket.destroyed
    );
  }

  static async connect(input: {
    readonly socketPath: string;
    readonly token: string;
    readonly timeoutMs?: number;
  }): Promise<TermControlClient> {
    const client = new TermControlClient(input.socketPath, input.token);
    try {
      await client.open(input.timeoutMs ?? 8_000);
      return client;
    } catch (error) {
      // A failed dial still owns a socket until its exact `close` witness. Do
      // not let the rejected connect promise hide that transport lifetime.
      if (client.socket === undefined) throw error;
      client.beginShutdown();
      try {
        client.socket?.destroy();
      } catch {
        // The exact close witness below retains this failed dial.
      }
      await client.whenClosed();
      throw error;
    }
  }

  private recordDiagnostic(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.diagnostics.push(message);
  }

  private journalConnect(ok: boolean, cause?: unknown): void {
    const event = {
      plane: "term" as const,
      op: "sock.connect",
      socket: this.socketPath,
    };
    if (ok) appendTransportTrace({ ...event, ok: true });
    else recordTransportError(event, cause);
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ path: this.socketPath });
      this.socket = sock;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settleOk = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.journalConnect(true);
        resolve();
      };
      const settleErr = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.journalConnect(false, cause);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      };
      timer = setTimeout(() => {
        sock.destroy();
        settleErr(new Error(`term control connect timeout: ${this.socketPath}`));
      }, timeoutMs);

      sock.setEncoding("utf8");
      sock.on("connect", () => {
        sock.write(`${JSON.stringify({ token: this.token })}\n`);
      });
      sock.on("data", (chunk: string) => {
        this.buf += chunk;
        for (;;) {
          const nl = this.buf.indexOf("\n");
          if (nl < 0) break;
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const rec = msg as Record<string, unknown>;
          if (!this.authed) {
            if (rec.ok === true && rec.id === "auth") {
              this.authed = true;
              for (const event of reviveTermAuthSeatState(rec.data)) {
                this.deliverHostEvent(event);
              }
              settleOk();
            } else if (rec.ok === false) {
              settleErr(new Error(String(rec.error ?? "auth failed")));
              sock.destroy();
            }
            continue;
          }
          if (rec.type === "event") {
            const event = reviveHostEvent(rec.payload);
            if (event) this.deliverHostEvent(event);
            continue;
          }
          const id = typeof rec.id === "string" ? rec.id : "";
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.resolve(rec as TermControlResponse);
          }
        }
      });
      sock.on("error", (err) => {
        this.recordDiagnostic(err);
        settleErr(err);
        this.failAll(err instanceof Error ? err : new Error(String(err)));
      });
      sock.on("close", () => {
        this.quiescing = true;
        this.closeObserved = true;
        this.resolveCloseObserved();
        this.failAll(new Error("term control socket closed"));
      });
    });
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private call(body: TermControlRequest, timeoutMs = 15_000): Promise<TermControlResponse> {
    if (this.quiescing || this.closeObserved || !this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("term control client closed"));
    }
    const started = Date.now();
    const bindingId =
      "bindingId" in body && typeof body.bindingId === "string"
        ? body.bindingId
        : undefined;
    return new Promise((resolve, reject) => {
      const finish = (
        error?: unknown,
        ok = true,
        response?: TermControlResponse,
      ): void => {
        const event = {
          plane: "term" as const,
          op: `sock.${body.op}`,
          ...(bindingId === undefined ? {} : { bindingId }),
          ms: Date.now() - started,
          ...(ok
            ? {}
            : {
                frame: formatTransportFrame({
                  request: body,
                  ...(response === undefined ? {} : { response }),
                }),
              }),
        };
        if (ok) {
          if (SEAT_WIRE_OPS.has(body.op)) {
            appendTransportTrace({
              ...event,
              ok: true,
              ...seatTapeFromSummary(
                bindingId ?? "",
                summaryFromTermResponse(response),
              ),
            });
          }
          return;
        }
        recordTransportError(
          event,
          error ??
            (response !== undefined && response.ok === false
              ? new Error(response.error)
              : new Error(`term control failed op=${body.op}`)),
        );
      };
      const timer = setTimeout(() => {
        this.pending.delete(body.id);
        const err = new Error(`term control timeout op=${body.op}`);
        finish(err, false);
        reject(err);
      }, timeoutMs);
      this.pending.set(body.id, {
        resolve: (value) => {
          finish(undefined, value.ok, value);
          resolve(value);
        },
        reject: (err) => {
          finish(err, false);
          reject(err);
        },
        timer,
      });
      try {
        this.socket!.write(`${JSON.stringify(body)}\n`);
      } catch (err) {
        this.pending.delete(body.id);
        clearTimeout(timer);
        const error = err instanceof Error ? err : new Error(String(err));
        finish(error, false);
        reject(error);
      }
    });
  }

  private nextId(): string {
    return randomBytes(8).toString("hex");
  }

  async create(input: {
    bindingId: string;
    launch?: TerminalLaunch;
    cols?: number;
    rows?: number;
    canvasName?: string;
    nodeId?: string;
    label?: string;
  }): Promise<TerminalSessionSummary> {
    const res = await this.call({
      v: 1,
      id: this.nextId(),
      op: "create",
      bindingId: input.bindingId,
      launch: input.launch,
      cols: input.cols,
      rows: input.rows,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      label: input.label,
    });
    if (!res.ok) throw new Error(res.error);
    return res.data as TerminalSessionSummary;
  }

  async createAgentSeat(input: {
    bindingId: string;
    harness: string;
    agentKey: string;
    launch?: TerminalLaunch;
    cols?: number;
    rows?: number;
    canvasName?: string;
    nodeId?: string;
    label?: string;
    firstTypedMessage?: string;
  }): Promise<TerminalSessionSummary> {
    const res = await this.call({
      v: 1,
      id: this.nextId(),
      op: "createAgentSeat",
      bindingId: input.bindingId,
      harness: input.harness,
      agentKey: input.agentKey,
      launch: input.launch,
      cols: input.cols,
      rows: input.rows,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      label: input.label,
      ...(input.firstTypedMessage ? { firstTypedMessage: input.firstTypedMessage } : {}),
    });
    if (!res.ok) throw new Error(res.error);
    return res.data as TerminalSessionSummary;
  }

  async list(): Promise<readonly TerminalSessionSummary[]> {
    const res = await this.call({ v: 1, id: this.nextId(), op: "list" });
    if (!res.ok) throw new Error(res.error);
    const data = res.data as { sessions?: TerminalSessionSummary[] };
    return data.sessions ?? [];
  }

  async readDirectory(path?: string): Promise<typeof HostDirectorySnapshot.Type> {
    const res = await this.call({
      v: 1,
      id: this.nextId(),
      op: "directory.read",
      ...(path?.trim() ? { path: path.trim() } : {}),
    });
    if (!res.ok) throw new Error(res.error);
    return Schema.decodeUnknownSync(HostDirectorySnapshot, {
      onExcessProperty: "error",
    })(res.data);
  }

  async get(bindingId: string): Promise<TerminalSessionSummary | undefined> {
    const res = await this.call({ v: 1, id: this.nextId(), op: "get", bindingId });
    if (!res.ok) throw new Error(res.error);
    return (res.data as TerminalSessionSummary | null) ?? undefined;
  }

  async kill(bindingId: string): Promise<boolean> {
    const res = await this.call({ v: 1, id: this.nextId(), op: "kill", bindingId });
    if (!res.ok) throw new Error(res.error);
    return Boolean(res.data);
  }

  async acquireMaintenance(): Promise<TermControlMaintenanceAcquireResult> {
    let response: TermControlResponse;
    try {
      response = await this.call(
        { v: 1, id: this.nextId(), op: "maintenance.acquire" },
        MAINTENANCE_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // The server may have acquired the cut even when its response was lost.
      // Closing this exact socket is the only safe recovery.
      this.close();
      throw error;
    }
    if (!response.ok) {
      this.close();
      throw new Error(response.error);
    }
    const payload = decodeTermMaintenanceAcquirePayload(response.data);
    if (payload === undefined) {
      this.close();
      throw new Error("invalid terminal maintenance acquisition response");
    }
    if (!payload.acquired) return payload;

    const evidence = Object.freeze(payload.evidence);
    const acknowledgeFence = async (): Promise<TermMaintenanceFencePayload> => {
      try {
        const fenceResponse = await this.call(
          { v: 1, id: this.nextId(), op: "maintenance.fence" },
          MAINTENANCE_REQUEST_TIMEOUT_MS,
        );
        if (!fenceResponse.ok) throw new Error(fenceResponse.error);
        const receipt = decodeTermMaintenanceFencePayload(fenceResponse.data);
        if (
          receipt === undefined ||
          receipt.evidence.observationId !== evidence.observationId
        ) {
          throw new Error("invalid terminal maintenance fence response");
        }
        return Object.freeze(receipt);
      } catch (error) {
        // A malformed or ambiguous acknowledgment cannot retain useful
        // maintenance authority on this client connection.
        this.close();
        throw error;
      }
    };
    let releaseFlight: Promise<TermMaintenanceReleasePayload> | undefined;
    const release = (): Promise<TermMaintenanceReleasePayload> => {
      if (releaseFlight !== undefined) return releaseFlight;
      releaseFlight = (async () => {
        try {
          const releaseResponse = await this.call(
            { v: 1, id: this.nextId(), op: "maintenance.release" },
            MAINTENANCE_REQUEST_TIMEOUT_MS,
          );
          if (!releaseResponse.ok) throw new Error(releaseResponse.error);
          const receipt = decodeTermMaintenanceReleasePayload(releaseResponse.data);
          if (receipt === undefined) {
            throw new Error("invalid terminal maintenance release response");
          }
          return Object.freeze(receipt);
        } catch (error) {
          // A bounded release timeout cannot be treated as release success.
          // Force connection loss so the server's socket-bound cleanup runs.
          this.close();
          throw error;
        }
      })();
      return releaseFlight;
    };
    const lease = Object.freeze({ evidence, acknowledgeFence, release });
    return { acquired: true, evidence, lease };
  }

  async bindCanvas(
    bindingId: string,
    ref: { canvasName?: string; nodeId?: string } | null,
  ): Promise<void> {
    const res = await this.call({
      v: 1,
      id: this.nextId(),
      op: "bindCanvas",
      bindingId,
      ref,
    });
    if (!res.ok) throw new Error(res.error);
  }

  async attach(input: {
    bindingId: string;
    mode: "control" | "observe";
    takeover?: boolean;
  }): Promise<
    | {
        ok: true;
        lease: ControlLease;
        cols: number;
        rows: number;
        screen?: {
          readonly bindingId: string;
          readonly epoch: string;
          readonly cols: number;
          readonly rows: number;
          readonly seq: bigint;
          readonly serialized: string;
        };
        journal: readonly JournalEntry[];
        status: string;
        pid?: number;
      }
    | { ok: false; message: string }
  > {
    const res = await this.call({
      v: 1,
      id: this.nextId(),
      op: "attach",
      bindingId: input.bindingId,
      mode: input.mode,
      takeover: input.takeover,
    });
    if (!res.ok) return { ok: false, message: res.error };
    const data = res.data as {
      leaseId: string;
      bindingId: string;
      epoch: string;
      mode: "control" | "observe";
      cols: number;
      rows: number;
      screen?: {
        bindingId?: unknown;
        epoch?: unknown;
        cols?: unknown;
        rows?: unknown;
        seq?: unknown;
        serialized?: unknown;
      };
      journal: unknown;
      status: string;
      pid?: number;
    };
    return {
      ok: true,
      lease: {
        leaseId: data.leaseId,
        bindingId: data.bindingId,
        epoch: data.epoch,
        mode: data.mode,
      },
      cols: data.cols,
      rows: data.rows,
      ...(data.screen &&
      typeof data.screen.bindingId === "string" &&
      typeof data.screen.epoch === "string" &&
      typeof data.screen.cols === "number" &&
      typeof data.screen.rows === "number" &&
      typeof data.screen.serialized === "string"
        ? {
            screen: {
              bindingId: data.screen.bindingId,
              epoch: data.screen.epoch,
              cols: data.screen.cols,
              rows: data.screen.rows,
              seq: reviveSeq(data.screen.seq) ?? 0n,
              serialized: data.screen.serialized,
            },
          }
        : {}),
      journal: reviveJournal(data.journal),
      status: data.status,
      pid: data.pid,
    };
  }

  async release(leaseId: string): Promise<void> {
    const res = await this.call({ v: 1, id: this.nextId(), op: "release", leaseId });
    if (!res.ok) throw new Error(res.error);
  }

  async write(leaseId: string, data: string): Promise<boolean> {
    const res = await this.call({ v: 1, id: this.nextId(), op: "write", leaseId, data });
    if (!res.ok) throw new Error(res.error);
    return Boolean(res.data);
  }

  async resize(leaseId: string, cols: number, rows: number): Promise<boolean> {
    const res = await this.call({
      v: 1,
      id: this.nextId(),
      op: "resize",
      leaseId,
      cols,
      rows,
    });
    if (!res.ok) throw new Error(res.error);
    return Boolean(res.data);
  }

  /** Synchronous admission cut; an exact socket-close witness remains required. */
  beginShutdown(): void {
    if (this.quiescing) return;
    this.quiescing = true;
    try {
      this.socket?.end();
    } catch (error) {
      this.recordDiagnostic(error);
    }
  }

  /** Exact transport finality; intentionally unbounded for lifetime owners. */
  whenClosed(): Promise<void> {
    return this.closeWitness;
  }

  /**
   * Bounded, retryable transport drain. A generic `error` is diagnostic only;
   * it cannot make the receipt clean until a later exact `close` proves that
   * the socket finally terminated.
   */
  drainOnQuit(): Promise<TermControlClientShutdownReceipt> {
    this.beginShutdown();
    if (this.drainFlight !== undefined) return this.drainFlight;
    const current = (async (): Promise<TermControlClientShutdownReceipt> => {
      const deadline = performance.now() + CLIENT_SHUTDOWN_DEADLINE_MS;
      if (!this.closeObserved) {
        await settlesWithin(this.closeWitness, CLIENT_SHUTDOWN_GRACE_MS);
      }
      if (!this.closeObserved) {
        try {
          this.socket?.destroy();
        } catch (error) {
          this.recordDiagnostic(error);
        }
      }
      if (!this.closeObserved) {
        const remainingMs = Math.max(0, deadline - performance.now());
        if (remainingMs > 0) {
          await settlesWithin(this.closeWitness, remainingMs);
        }
      }
      const diagnostics = Object.freeze([...this.diagnostics]);
      const pendingRequests = this.pending.size;
      return Object.freeze({
        clean:
          this.closeObserved &&
          pendingRequests === 0,
        closeObserved: this.closeObserved,
        pendingRequests,
        diagnostics,
      });
    })();
    this.drainFlight = current;
    void current.then(
      () => {
        if (this.drainFlight === current) this.drainFlight = undefined;
      },
      () => {
        if (this.drainFlight === current) this.drainFlight = undefined;
      },
    );
    return current;
  }

  /** Legacy eager close. Router shutdown uses drainOnQuit for the receipt. */
  close(): void {
    this.beginShutdown();
    try {
      this.socket?.destroy();
    } catch (error) {
      this.recordDiagnostic(error);
    }
  }
}
