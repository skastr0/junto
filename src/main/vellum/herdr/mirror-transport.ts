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
 * long-lived stock `ssh -N -L` unix-socket forward (verified: forwarded
 * streamlocal channels count zero sessions against sshd MaxSessions), layered
 * on the phase-A ControlMaster socket. No herdr patches anywhere.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runCli, type CliResult } from "../adapters/exec";
import { controlArgs, herdrControlDir } from "./control-path";
import { sshTargetForHost } from "./hosts";
import { withHostSlot } from "./masters";

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

// Mirrors the base ssh flags hosts.ts / masters.ts use for remote spawns.
const BASE_SSH_ARGS = [
  "-o",
  "ConnectTimeout=6",
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
] as const;

const FORWARD_POLL_STEP_MS = 100;
const FORWARD_POLL_CAP_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type MirrorExec = (
  command: string,
  argv: ReadonlyArray<string>,
  timeoutMs?: number,
) => Promise<CliResult>;

export type MirrorSpawn = (
  command: string,
  argv: ReadonlyArray<string>,
) => ChildProcess;

const defaultSpawn: MirrorSpawn = (command, argv) =>
  spawn(command, argv as string[], { stdio: "ignore", env: process.env });

/**
 * Long-lived `ssh -N -L <localSock>:<remoteHome>/.config/herdr/herdr.sock`
 * forward. `-N` opens zero sshd sessions; the forward rides the phase-A
 * ControlMaster when warm. Lazy: nothing spawns until the first request.
 * Forward death clears the ready handle so the next use respawns — the
 * mirror's own reconnect/backoff drives the retry cadence (its events
 * connection dies with the forward, firing onClose).
 */
export class RemoteMirrorTransport implements MirrorTransport {
  private forward?: ChildProcess;
  private ready?: Promise<LocalMirrorTransport>;
  private remoteHome?: string;
  private disposed = false;
  private readonly localSock: string;
  private readonly exec: MirrorExec;
  private readonly spawnFn: MirrorSpawn;

  constructor(
    private readonly hostId: string,
    deps?: {
      readonly exec?: MirrorExec;
      readonly spawnFn?: MirrorSpawn;
      /** Test seam — production always derives from herdrControlDir(). */
      readonly localSockPath?: string;
    },
  ) {
    // Short path — unix socket paths cap at ~104 chars.
    this.localSock = deps?.localSockPath ?? `${herdrControlDir()}/f-${hostId}.sock`;
    this.exec = deps?.exec ?? runCli;
    this.spawnFn = deps?.spawnFn ?? defaultSpawn;
  }

  private ensureForward(): Promise<LocalMirrorTransport> {
    if (this.disposed) return Promise.reject(new Error("transport disposed"));
    if (!this.ready) {
      this.ready = this.startForward().catch((err) => {
        this.ready = undefined;
        throw err;
      });
    }
    return this.ready;
  }

  private async startForward(): Promise<LocalMirrorTransport> {
    const target = sshTargetForHost(this.hostId);
    if (!target) throw new Error(`no ssh target for herdr host ${this.hostId}`);

    if (!this.remoteHome) {
      // Resolve $HOME once per host (remote -L path must be absolute).
      const res = await withHostSlot(this.hostId, () =>
        this.exec("ssh", [...BASE_SSH_ARGS, ...controlArgs(), target, 'printf %s "$HOME"'], 10_000),
      );
      const home = res.ok ? res.stdout.trim() : "";
      if (!home.startsWith("/")) {
        throw new Error(`failed to resolve remote $HOME on ${this.hostId}: ${res.error ?? home}`);
      }
      this.remoteHome = home;
    }

    await mkdir(herdrControlDir(), { recursive: true, mode: 0o700 });
    // ssh -L refuses to bind if the local socket file already exists.
    try {
      unlinkSync(this.localSock);
    } catch {
      // absent — fine
    }

    const child = this.spawnFn("ssh", [
      ...BASE_SSH_ARGS,
      ...controlArgs(),
      "-N",
      "-L",
      `${this.localSock}:${this.remoteHome}/.config/herdr/herdr.sock`,
      target,
    ]);
    this.forward = child;
    const invalidate = (): void => {
      if (this.forward === child) {
        this.forward = undefined;
        this.ready = undefined;
      }
    };
    child.on("exit", invalidate);
    child.on("error", invalidate);

    const deadline = Date.now() + FORWARD_POLL_CAP_MS;
    while (!existsSync(this.localSock)) {
      if (this.disposed || child.exitCode !== null || Date.now() > deadline) {
        try {
          child.kill();
        } catch {
          // already gone
        }
        invalidate();
        throw new Error(`ssh forward to ${this.hostId} did not come up`);
      }
      await sleep(FORWARD_POLL_STEP_MS);
    }
    return new LocalMirrorTransport(this.localSock);
  }

  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const local = await this.ensureForward();
    return local.request(method, params, timeoutMs);
  }

  async openEvents(
    subscriptions: ReadonlyArray<Record<string, unknown>>,
    onEvent: (evt: Record<string, unknown>) => void,
    onClose: (reason: string) => void,
  ): Promise<() => void> {
    const local = await this.ensureForward();
    return local.openEvents(subscriptions, onEvent, onClose);
  }

  dispose(): void {
    this.disposed = true;
    const child = this.forward;
    this.forward = undefined;
    this.ready = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    try {
      unlinkSync(this.localSock);
    } catch {
      // absent — fine
    }
  }
}
