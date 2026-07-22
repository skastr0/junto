/**
 * Host-aware terminal authority router.
 * - local → LocalSessionHost (this process)
 * - remote hostId → TermControlClient via SSH unix-forward of ~/.vellum/term/control.sock
 *
 * Remote sessions are owned by the remote Vellum station; CC quit does not kill them.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Effect, ExecutionStrategy, Exit, Scope } from "effect";
import { findHostById, hostsWithCapability } from "../hosts/snapshot";
import { isLocalHost, TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import {
  makeRemoteCommand,
  parseRemoteUnixSocketPath,
  parseSshEndpoint,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, unixForward } from "../ssh/program";
import type { SshForwardLease } from "../ssh/service";
import { SshTransport } from "../ssh/service";
import { AppRuntime } from "../../runtime";
import type {
  ControlLease,
  JournalEntry,
  LocalHostCreateInput,
  LocalHostEvent,
  LocalSessionHost,
} from "./local-host";
import { TermControlClient } from "./control-client";

type RemoteEntry = {
  client: TermControlClient;
  forward: SshForwardLease;
  /** Forked Effect scope that owns the SSH forward finalizers. */
  scope: Scope.CloseableScope;
  leaseMap: Map<string, string>;
  reverseLease: Map<string, string>;
};

export type AttachResult =
  | {
      readonly ok: true;
      readonly lease: ControlLease;
      readonly cols: number;
      readonly rows: number;
      readonly journal: readonly JournalEntry[];
      readonly status: string;
      readonly pid?: number;
    }
  | { readonly ok: false; readonly message: string };

export class TerminalRouter extends EventEmitter {
  private readonly remotes = new Map<string, RemoteEntry>();
  private readonly connecting = new Map<string, Promise<RemoteEntry>>();

  constructor(private readonly local: LocalSessionHost) {
    super();
    local.on("event", (ev: LocalHostEvent) => this.emit("event", ev));
  }

  isLocalHostId(hostId: string | undefined | null): boolean {
    const id = (hostId ?? "local").trim() || "local";
    if (id === "local") return true;
    const host = findHostById(id);
    if (!host) return true;
    return isLocalHost(host);
  }

  async create(
    input: LocalHostCreateInput & { hostId?: string },
  ): Promise<TerminalSessionSummary> {
    const hostId = input.hostId?.trim() || "local";
    if (this.isLocalHostId(hostId)) {
      return this.local.create({ ...input, hostId: "local" });
    }
    const client = await this.ensureRemoteClient(hostId);
    const summary = await client.create({
      bindingId: input.bindingId,
      launch: input.launch as TerminalLaunch | undefined,
      cols: input.cols,
      rows: input.rows,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      label: input.label,
    });
    // Remote station stamps its own hostId as "local"; rewrite for CC consumers.
    return { ...summary, hostId };
  }

  async list(hostId?: string): Promise<readonly TerminalSessionSummary[]> {
    if (!hostId || this.isLocalHostId(hostId)) return this.local.list();
    try {
      const c = await this.ensureRemoteClient(hostId);
      return (await c.list()).map((s) => ({ ...s, hostId }));
    } catch {
      return [];
    }
  }

  async listAll(): Promise<readonly TerminalSessionSummary[]> {
    const out: TerminalSessionSummary[] = [...this.local.list()];
    const seen = new Set<string>(["local"]);
    const candidates = [
      ...hostsWithCapability(TERMINAL_HOST_CAPABILITY),
      ...hostsWithCapability("herdr"),
    ];
    for (const host of candidates) {
      if (isLocalHost(host) || seen.has(host.id)) continue;
      seen.add(host.id);
      try {
        out.push(...(await this.list(host.id)));
      } catch {
        // offline
      }
    }
    return out;
  }

  async get(
    bindingId: string,
    hostId?: string,
  ): Promise<TerminalSessionSummary | undefined> {
    if (!hostId || this.isLocalHostId(hostId)) return this.local.get(bindingId);
    try {
      const c = await this.ensureRemoteClient(hostId);
      const s = await c.get(bindingId);
      return s ? { ...s, hostId } : undefined;
    } catch {
      return undefined;
    }
  }

  async kill(bindingId: string, hostId?: string): Promise<boolean> {
    if (!hostId || this.isLocalHostId(hostId)) return this.local.kill(bindingId);
    try {
      const c = await this.ensureRemoteClient(hostId);
      return await c.kill(bindingId);
    } catch {
      return false;
    }
  }

  async bindCanvas(
    bindingId: string,
    ref: { canvasName?: string; nodeId?: string } | null,
    hostId?: string,
  ): Promise<void> {
    if (!hostId || this.isLocalHostId(hostId)) {
      this.local.bindCanvas(bindingId, ref);
      return;
    }
    const c = await this.ensureRemoteClient(hostId);
    await c.bindCanvas(bindingId, ref);
  }

  async attach(input: {
    bindingId: string;
    mode: "control" | "observe";
    takeover?: boolean;
    hostId?: string;
  }): Promise<AttachResult> {
    const hostId = input.hostId?.trim() || "local";
    if (this.isLocalHostId(hostId)) {
      return this.local.attach(input);
    }
    try {
      const entry = await this.ensureRemoteEntry(hostId);
      const result = await entry.client.attach({
        bindingId: input.bindingId,
        mode: input.mode,
        takeover: input.takeover,
      });
      if (!result.ok) return result;
      const localLeaseId = `rm_${randomBytes(8).toString("hex")}`;
      entry.leaseMap.set(localLeaseId, result.lease.leaseId);
      entry.reverseLease.set(result.lease.leaseId, localLeaseId);
      return {
        ok: true,
        lease: {
          leaseId: localLeaseId,
          bindingId: result.lease.bindingId,
          epoch: result.lease.epoch,
          mode: result.lease.mode,
        },
        cols: result.cols,
        rows: result.rows,
        journal: result.journal,
        status: result.status,
        pid: result.pid,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async release(lease: ControlLease, hostId?: string): Promise<void> {
    if (!hostId || this.isLocalHostId(hostId)) {
      this.local.release(lease);
      return;
    }
    const entry = this.remotes.get(hostId);
    const remoteId = entry?.leaseMap.get(lease.leaseId);
    if (!entry || !remoteId) return;
    entry.leaseMap.delete(lease.leaseId);
    entry.reverseLease.delete(remoteId);
    await entry.client.release(remoteId).catch(() => undefined);
  }

  async write(lease: ControlLease, data: string, hostId?: string): Promise<boolean> {
    if (!hostId || this.isLocalHostId(hostId)) return this.local.write(lease, data);
    const entry = this.remotes.get(hostId);
    const remoteId = entry?.leaseMap.get(lease.leaseId);
    if (!entry || !remoteId) return false;
    try {
      return await entry.client.write(remoteId, data);
    } catch {
      return false;
    }
  }

  async resize(
    lease: ControlLease,
    cols: number,
    rows: number,
    hostId?: string,
  ): Promise<boolean> {
    if (!hostId || this.isLocalHostId(hostId)) {
      return this.local.resize(lease, cols, rows);
    }
    const entry = this.remotes.get(hostId);
    const remoteId = entry?.leaseMap.get(lease.leaseId);
    if (!entry || !remoteId) return false;
    try {
      return await entry.client.resize(remoteId, cols, rows);
    } catch {
      return false;
    }
  }

  runningCount(): number {
    return this.local.runningCount();
  }

  async shutdownAllLocal(reason?: string): Promise<void> {
    await this.local.shutdownAll(reason);
  }

  /** Close SSH forwards + control clients only. Never kills remote sessions. */
  async closeRemotes(): Promise<void> {
    for (const [id, entry] of [...this.remotes]) {
      entry.client.close();
      try {
        await AppRuntime.runPromise(Scope.close(entry.scope, Exit.void));
      } catch {
        // ignore
      }
      this.remotes.delete(id);
    }
  }

  private async ensureRemoteClient(hostId: string): Promise<TermControlClient> {
    return (await this.ensureRemoteEntry(hostId)).client;
  }

  private async ensureRemoteEntry(hostId: string): Promise<RemoteEntry> {
    const existing = this.remotes.get(hostId);
    if (existing) return existing;
    const inflight = this.connecting.get(hostId);
    if (inflight) return inflight;

    const promise = this.connectRemote(hostId);
    this.connecting.set(hostId, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(hostId);
    }
  }

  private async connectRemote(hostId: string): Promise<RemoteEntry> {
    const host = findHostById(hostId);
    if (!host || host.kind !== "remote" || !host.endpoint) {
      throw new Error(`host ${hostId} is not a remote SSH endpoint`);
    }

    // Own a forked scope so the SSH forward finalizers stay alive until we
    // explicitly closeRemotes() — same pattern as herdr mirror forwards.
    // Scope.make() yields a CloseableScope Effect (call the factory).
    const rootScope = await AppRuntime.runPromise(Scope.make());
    const scope = await AppRuntime.runPromise(
      Scope.fork(rootScope, ExecutionStrategy.sequential),
    );

    try {
      const pair = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const ssh = yield* SshTransport;
          const endpoint = yield* parseSshEndpoint(host.endpoint!);
          const homeResult = yield* ssh.run(homeDirectoryLookup(endpoint));
          const home = homeResult.stdout.trim() || ".";
          const remoteSock = yield* parseRemoteUnixSocketPath(
            join(home, TERM_REMOTE_SOCK_REL),
          );
          const forward = yield* ssh
            .forward(unixForward(endpoint, remoteSock))
            .pipe(Scope.extend(scope));
          const tokenCmd = yield* makeRemoteCommand("/bin/cat", [
            join(home, ".vellum", "term", "token"),
          ]);
          const tokenRes = yield* ssh.run(
            oneShot(endpoint, tokenCmd, { budget: "short" }),
          );
          const token = tokenRes.stdout.trim();
          if (!token) {
            return yield* Effect.fail(
              new Error(
                `no term control token on ${hostId} — start Vellum on that host`,
              ),
            );
          }
          return {
            forward,
            token,
            localSocket: String(forward.localSocket),
          } as const;
        }),
      );

      const client = await TermControlClient.connect({
        socketPath: pair.localSocket,
        token: pair.token,
        timeoutMs: 12_000,
      });

      const remoteEntry: RemoteEntry = {
        client,
        forward: pair.forward,
        scope,
        leaseMap: new Map(),
        reverseLease: new Map(),
      };
      client.on("event", (payload: LocalHostEvent) => {
        this.emit("event", payload);
      });
      this.remotes.set(hostId, remoteEntry);
      return remoteEntry;
    } catch (err) {
      await AppRuntime.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
      await AppRuntime.runPromise(Scope.close(rootScope, Exit.void)).catch(() => undefined);
      throw err;
    }
  }
}
