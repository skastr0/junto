/**
 * Transport layer for the herdr state mirror (phase B latency work).
 *
 * herdr's socket API is NDJSON over a unix socket (stock, documented surface —
 * protocol 16, herdr 0.7.2+). Regular methods are one-connection-one-request:
 * connect, write one `{id, method, params}` line, read the one response line
 * whose id matches, done. `events.subscribe` keeps its connection open: the
 * first line is the ack, every subsequent line is a pushed event.
 *
 * Local hosts talk to ~/.config/herdr/herdr.sock directly. Remote hosts ride a
 * an Effect-owned OpenSSH stream-local forward. The transport receives only
 * an owned local socket lease; SSH policy and generation cleanup stay below
 * the product boundary.
 */
import { existsSync } from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface MirrorTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** Opens the persistent events connection. Resolves with a close function
   * once the subscribe ack arrives. Deliberate close (the returned fn) does
   * NOT fire onClose; an unexpected drop does. Callbacks never throw out. */
  openEvents(
    subscriptions: ReadonlyArray<Record<string, unknown>>,
    onEvent: (evt: Record<string, unknown>) => void,
    onClose: (reason: string) => void,
  ): Promise<() => void>;
  dispose(): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const ACK_TIMEOUT_MS = 15_000;

let idSeq = 0;
const nextId = (): string => `vellum:mirror:${Date.now()}:${++idSeq}`;

export const defaultHerdrSocketPath = (): string =>
  join(homedir(), ".config", "herdr", "herdr.sock");

/** Incremental NDJSON line splitter. */
const makeLineFeed = (onLine: (line: string) => void) => {
  // StringDecoder holds partial multi-byte UTF-8 sequences across chunk
  // boundaries — a plain per-chunk toString() would mangle a code point
  // split by TCP segmentation (real over the ssh-forwarded socket).
  const decoder = new StringDecoder("utf8");
  let buf = "";
  return (chunk: Buffer | string): void => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
      idx = buf.indexOf("\n");
    }
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export class LocalMirrorTransport implements MirrorTransport {
  constructor(private readonly socketPath: string = defaultHerdrSocketPath()) {}

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      let settled = false;
      const sock = net.connect(this.socketPath);
      const timer = setTimeout(() => fail(new Error(`herdr socket timeout on ${method}`)), timeoutMs);
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      };
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.end();
        fn();
      };
      sock.on("connect", () => {
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      sock.on(
        "data",
        makeLineFeed((line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return; // keep scanning
          }
          const obj = asRecord(parsed);
          if (!obj || obj.id !== id) return;
          const error = asRecord(obj.error);
          if (error) {
            done(() =>
              reject(
                new Error(
                  typeof error.message === "string" ? error.message : `herdr error on ${method}`,
                ),
              ),
            );
            return;
          }
          done(() => resolve(obj.result));
        }),
      );
      sock.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
      sock.on("close", () => fail(new Error(`herdr socket closed before ${method} response`)));
    });
  }

  openEvents(
    subscriptions: ReadonlyArray<Record<string, unknown>>,
    onEvent: (evt: Record<string, unknown>) => void,
    onClose: (reason: string) => void,
  ): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      let acked = false;
      let closedNotified = false;
      const sock = net.connect(this.socketPath);
      const ackTimer = setTimeout(() => {
        if (!acked) {
          sock.destroy();
          reject(new Error("herdr events.subscribe ack timeout"));
        }
      }, ACK_TIMEOUT_MS);
      const notifyClose = (reason: string): void => {
        if (!acked || closedNotified) return;
        closedNotified = true;
        try {
          onClose(reason);
        } catch {
          // callbacks never throw out of the transport
        }
      };
      sock.on("connect", () => {
        sock.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
      });
      sock.on(
        "data",
        makeLineFeed((line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }
          const obj = asRecord(parsed);
          if (!obj) return;
          if (!acked) {
            if (obj.id !== id) return;
            clearTimeout(ackTimer);
            const error = asRecord(obj.error);
            if (error) {
              sock.destroy();
              reject(
                new Error(
                  typeof error.message === "string" ? error.message : "events.subscribe rejected",
                ),
              );
              return;
            }
            acked = true;
            resolve(() => {
              closedNotified = true; // deliberate close — no onClose
              sock.destroy();
            });
            return;
          }
          try {
            onEvent(obj);
          } catch {
            // callbacks never throw out of the transport
          }
        }),
      );
      sock.on("error", (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!acked) {
          clearTimeout(ackTimer);
          reject(e);
          return;
        }
        notifyClose(e.message);
      });
      sock.on("close", () => {
        if (!acked) {
          clearTimeout(ackTimer);
          reject(new Error("herdr events connection closed before ack"));
          return;
        }
        notifyClose("events connection closed");
      });
    });
  }

  dispose(): void {
    // request/openEvents own their sockets; nothing persistent to tear down.
  }
}

export interface MirrorForwardLease {
  readonly localSocket: string;
  readonly closed: Promise<void>;
  readonly close: () => void | Promise<void>;
}

export type OpenMirrorForward = () => Promise<MirrorForwardLease>;

interface ForwardGeneration {
  readonly lease: MirrorForwardLease;
  readonly local: LocalMirrorTransport;
}

/** Effect-owned SSH forwarding projected into the mirror's Promise domain. */
export class RemoteMirrorTransport implements MirrorTransport {
  private generation?: ForwardGeneration;
  private ready?: Promise<ForwardGeneration>;
  private disposed = false;

  constructor(
    private readonly hostId: string,
    private readonly openForward: OpenMirrorForward,
  ) {}

  private invalidateForward(expectedReady: Promise<ForwardGeneration>): void {
    if (this.ready !== expectedReady) return;
    const target = this.generation;
    this.generation = undefined;
    this.ready = undefined;
    if (!target) return;
    void Promise.resolve(target.lease.close()).catch(() => undefined);
  }

  private ensureForward(): Promise<ForwardGeneration> {
    if (this.disposed) return Promise.reject(new Error("transport disposed"));
    if (!this.ready) {
      const ready = this.startForward();
      this.ready = ready;
      void ready.catch(() => {
        if (this.ready === ready) this.ready = undefined;
      });
    }
    return this.ready;
  }

  /** A vanished socket invalidates only the observed forward generation. */
  private async ensureLiveForward(): Promise<{
    readonly local: LocalMirrorTransport;
    readonly ready: Promise<ForwardGeneration>;
  }> {
    const ready = this.ensureForward();
    const generation = await ready;
    if (this.disposed) throw new Error("transport disposed");
    if (existsSync(generation.lease.localSocket)) return { local: generation.local, ready };
    this.invalidateForward(ready);
    const replacement = this.ensureForward();
    return { local: (await replacement).local, ready: replacement };
  }

  private async startForward(): Promise<ForwardGeneration> {
    const lease = await this.openForward();
    if (this.disposed) {
      await lease.close();
      throw new Error("transport disposed");
    }
    const generation = {
      lease,
      local: new LocalMirrorTransport(lease.localSocket),
    } satisfies ForwardGeneration;
    this.generation = generation;
    const ready = this.ready;
    void lease.closed.then(
      () => {
        if (ready) this.invalidateForward(ready);
      },
      () => {
        if (ready) this.invalidateForward(ready);
      },
    );
    return generation;
  }

  /** True when the unix-socket path is gone (or never bound). */
  private isStaleSockError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; message?: string };
    return e.code === "ENOENT" || (typeof e.message === "string" && /\bENOENT\b/.test(e.message));
  }

  private async withForward<T>(op: (local: LocalMirrorTransport) => Promise<T>): Promise<T> {
    const current = await this.ensureLiveForward();
    try {
      return await op(current.local);
    } catch (err) {
      // Path vanished under a live forward — drop and retry once on a fresh bind.
      if (!this.disposed && this.isStaleSockError(err)) {
        this.invalidateForward(current.ready);
        const retry = await this.ensureLiveForward();
        return op(retry.local);
      }
      throw err;
    }
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return this.withForward((local) => local.request(method, params, timeoutMs));
  }

  openEvents(
    subscriptions: ReadonlyArray<Record<string, unknown>>,
    onEvent: (evt: Record<string, unknown>) => void,
    onClose: (reason: string) => void,
  ): Promise<() => void> {
    return this.withForward((local) => local.openEvents(subscriptions, onEvent, onClose));
  }

  dispose(): void {
    this.disposed = true;
    const generation = this.generation;
    this.generation = undefined;
    this.ready = undefined;
    if (generation) void Promise.resolve(generation.lease.close()).catch(() => undefined);
  }
}
