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
import {
  findHostById,
  hostsWithCapability,
  subscribeHostsSnapshot,
} from "../hosts/snapshot";
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
import type {
  ControlLease,
  JournalEntry,
  LocalHostCreateInput,
  LocalHostEvent,
  LocalSessionHost,
} from "./local-host";
import { TermControlClient } from "./control-client";

/**
 * Lazy AppRuntime accessor — avoids importing main/runtime (Electron) when
 * unit tests only exercise the local router path.
 */
const runAppPromise = async <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> => {
  const { AppRuntime } = await import("../../runtime");
  return AppRuntime.runPromise(effect as Effect.Effect<A, unknown, never>);
};

// Effects that need SshTransport / Scope from RootLayer.
const runLayered = async <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> => {
  const { AppRuntime } = await import("../../runtime");
  return AppRuntime.runPromise(effect as Effect.Effect<A, E, never>);
};

type RemoteEntry = {
  client: TermControlClient;
  forward: SshForwardLease;
  /** Registry endpoint used to establish this connection. */
  endpoint: string;
  /** Snapshot generation used to establish this connection. */
  generation: number;
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
  private readonly connecting = new Map<
    string,
    { readonly endpoint: string; readonly promise: Promise<RemoteEntry> }
  >();
  /** Every dial remains visible until its scope has settled, even if superseded. */
  private readonly inFlight = new Set<Promise<RemoteEntry>>();
  /** Once shutdown begins, this router cannot acquire another remote authority. */
  private quiescing = false;
  private generation = 0;
  private readonly unsubscribeHosts: () => void;

  constructor(private readonly local: LocalSessionHost) {
    super();
    local.on("event", (ev: LocalHostEvent) => this.emit("event", ev));
    this.unsubscribeHosts = subscribeHostsSnapshot(() => {
      this.generation += 1;
      // Host edits/removal revoke all current routes immediately. A later
      // request reconnects against the current snapshot instead of reusing a
      // forward authorized by an earlier registry generation.
      for (const [hostId, entry] of [...this.remotes]) {
        void this.closeRemoteEntry(hostId, entry);
      }
    });
  }

  isLocalHostId(hostId: string | undefined | null): boolean {
    if (hostId === undefined || hostId === null || hostId.trim() === "") return true;
    const host = findHostById(hostId.trim());
    return host !== undefined && isLocalHost(host);
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
    const entry = await this.currentRemoteEntry(hostId);
    const remoteId = entry?.leaseMap.get(lease.leaseId);
    if (!entry || !remoteId) return;
    entry.leaseMap.delete(lease.leaseId);
    entry.reverseLease.delete(remoteId);
    await entry.client.release(remoteId).catch(() => undefined);
  }

  async write(lease: ControlLease, data: string, hostId?: string): Promise<boolean> {
    if (!hostId || this.isLocalHostId(hostId)) return this.local.write(lease, data);
    const entry = await this.currentRemoteEntry(hostId);
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
    const entry = await this.currentRemoteEntry(hostId);
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
    this.quiescing = true;
    this.unsubscribeHosts();
    const inFlight = [...this.inFlight];
    this.connecting.clear();
    await Promise.allSettled(inFlight);
    for (const [id, entry] of [...this.remotes]) {
      await this.closeRemoteEntry(id, entry);
    }
  }

  private async ensureRemoteClient(hostId: string): Promise<TermControlClient> {
    return (await this.ensureRemoteEntry(hostId)).client;
  }

  private async ensureRemoteEntry(hostId: string): Promise<RemoteEntry> {
    if (this.quiescing) throw new Error("terminal router is stopping");
    const host = findHostById(hostId);
    if (!host || host.kind !== "remote" || !host.endpoint) {
      const stale = this.remotes.get(hostId);
      if (stale) await this.closeRemoteEntry(hostId, stale);
      throw new Error(`host ${hostId} is not a remote SSH endpoint`);
    }
    const endpoint = host.endpoint;
    const existing = this.remotes.get(hostId);
    if (existing) {
      if (existing.endpoint === endpoint && existing.generation === this.generation) {
        return existing;
      }
      await this.closeRemoteEntry(hostId, existing);
    }
    const inflight = this.connecting.get(hostId);
    if (inflight?.endpoint === endpoint) return inflight.promise;
    if (inflight) this.connecting.delete(hostId);

    let promise!: Promise<RemoteEntry>;
    const generation = this.generation;
    const dialing = this.connectRemote(hostId, endpoint, generation, () =>
      !this.quiescing &&
      this.connecting.get(hostId)?.promise === promise &&
      findHostById(hostId)?.kind === "remote" &&
      findHostById(hostId)?.endpoint === endpoint &&
      generation === this.generation,
    );
    promise = dialing.finally(() => this.inFlight.delete(promise));
    this.inFlight.add(promise);
    this.connecting.set(hostId, { endpoint, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(hostId)?.promise === promise) {
        this.connecting.delete(hostId);
      }
    }
  }

  private async connectRemote(
    hostId: string,
    endpoint: string,
    generation: number,
    admit: () => boolean,
  ): Promise<RemoteEntry> {

    // Own a forked scope so the SSH forward finalizers stay alive until we
    // explicitly closeRemotes() — same pattern as herdr mirror forwards.
    const rootScope = await runAppPromise(Scope.make());
    const scope = await runAppPromise(
      Scope.fork(rootScope, ExecutionStrategy.sequential),
    );

    try {
      const pair = await runLayered(
        Effect.gen(function* () {
          const ssh = yield* SshTransport;
          const sshEndpoint = yield* parseSshEndpoint(endpoint);
          const homeResult = yield* ssh.run(homeDirectoryLookup(sshEndpoint));
          const home = homeResult.stdout.trim() || ".";
          const remoteSock = yield* parseRemoteUnixSocketPath(
            join(home, TERM_REMOTE_SOCK_REL),
          );
          const forward = yield* ssh
            .forward(unixForward(sshEndpoint, remoteSock))
            .pipe(Scope.extend(scope));
          const tokenCmd = yield* makeRemoteCommand("/bin/cat", [
            join(home, ".vellum", "term", "token"),
          ]);
          const tokenRes = yield* ssh.run(
            oneShot(sshEndpoint, tokenCmd, { budget: "short" }),
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
        endpoint,
        generation,
        scope,
        leaseMap: new Map(),
        reverseLease: new Map(),
      };
      client.on("event", (payload: LocalHostEvent) => {
        this.emit("event", payload);
      });
      if (!admit()) {
        client.close();
        await runAppPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
        throw new Error("terminal router is stopping or host changed");
      }
      this.remotes.set(hostId, remoteEntry);
      return remoteEntry;
    } catch (err) {
      await runAppPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
      await runAppPromise(Scope.close(rootScope, Exit.void)).catch(() => undefined);
      throw err;
    }
  }

  private async currentRemoteEntry(hostId: string): Promise<RemoteEntry | undefined> {
    const entry = this.remotes.get(hostId);
    if (!entry) return undefined;
    const host = findHostById(hostId);
    if (
      host?.kind === "remote" &&
      host.endpoint === entry.endpoint &&
      entry.generation === this.generation &&
      !this.quiescing
    ) {
      return entry;
    }
    await this.closeRemoteEntry(hostId, entry);
    return undefined;
  }

  private async closeRemoteEntry(hostId: string, entry: RemoteEntry): Promise<void> {
    entry.client.close();
    try {
      await runAppPromise(Scope.close(entry.scope, Exit.void));
    } catch {
      // Closing a transport is best-effort; its authority has already been revoked.
    }
    if (this.remotes.get(hostId) === entry) this.remotes.delete(hostId);
  }
}
