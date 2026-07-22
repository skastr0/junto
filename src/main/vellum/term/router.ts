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
import { performance } from "node:perf_hooks";
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
  LocalHostShutdownResult,
  LocalSessionHost,
} from "./local-host";
import { TermControlClient } from "./control-client";
import type { TermControlClientShutdownReceipt } from "./control-client";

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
  /** Parent scope must be closed too; retaining only the child leaks authority. */
  rootScope: Scope.CloseableScope;
  leaseMap: Map<string, string>;
  reverseLease: Map<string, string>;
  closeFlight?: Promise<RemoteCloseReceipt>;
  closeReceipt?: RemoteCloseReceipt;
};

type RemoteCloseReceipt = {
  readonly clean: boolean;
  readonly client: TermControlClientShutdownReceipt;
  readonly scopeClosed: boolean;
  readonly diagnostics: ReadonlyArray<string>;
};

export interface TerminalRouterRetainedCounts {
  readonly dials: number;
  readonly remoteEntries: number;
  readonly remoteClosures: number;
}

export interface TerminalRouterShutdownReceipt {
  readonly clean: boolean;
  readonly rounds: number;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly retainedCounts: TerminalRouterRetainedCounts;
  readonly retainedLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface TerminalRouterRuntime {
  /** Tests may lower, never raise, the complete remote drain deadline. */
  readonly shutdownDeadlineMs?: number;
}

const ROUTER_SHUTDOWN_DEADLINE_MS = 3_000;

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
  private unsubscribed = false;
  private generation = 0;
  private readonly unsubscribeHosts: () => void;
  private readonly shutdownDeadlineMs: number;
  private drainFlight: Promise<TerminalRouterShutdownReceipt> | undefined;
  private readonly diagnostics: string[] = [];

  constructor(
    private readonly local: LocalSessionHost,
    runtime: TerminalRouterRuntime = {},
  ) {
    super();
    this.shutdownDeadlineMs = boundedRuntimeValue(
      runtime.shutdownDeadlineMs,
      ROUTER_SHUTDOWN_DEADLINE_MS,
    );
    local.on("event", (ev: LocalHostEvent) => this.emit("event", ev));
    this.unsubscribeHosts = subscribeHostsSnapshot(() => {
      this.generation += 1;
      // Host edits/removal revoke all current routes immediately. A later
      // request reconnects against the current snapshot instead of reusing a
      // forward authorized by an earlier registry generation.
      for (const [hostId, entry] of [...this.remotes]) {
        this.beginRemoteClose(hostId, entry);
      }
    });
  }

  private assertSessionAdmission(): void {
    if (this.quiescing) throw new Error("terminal router is stopping");
  }

  isLocalHostId(hostId: string | undefined | null): boolean {
    if (hostId === undefined || hostId === null || hostId.trim() === "") return true;
    const host = findHostById(hostId.trim());
    return host !== undefined && isLocalHost(host);
  }

  async create(
    input: LocalHostCreateInput & { hostId?: string },
  ): Promise<TerminalSessionSummary> {
    this.assertSessionAdmission();
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
    if (this.quiescing) return false;
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
    this.assertSessionAdmission();
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
    if (this.quiescing) {
      return { ok: false, message: "terminal router is stopping" };
    }
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
    if (this.quiescing) return false;
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
    if (this.quiescing) return false;
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

  async shutdownAllLocal(reason?: string): Promise<LocalHostShutdownResult> {
    return this.local.shutdownAll(reason);
  }

  /**
   * Synchronously revoke dial/control admission. Remote station sessions are
   * deliberately untouched; only local clients and SSH-forward scopes close.
   */
  beginShutdown(): void {
    if (this.quiescing) return;
    this.quiescing = true;
    if (!this.unsubscribed) {
      this.unsubscribed = true;
      this.unsubscribeHosts();
    }
    this.connecting.clear();
    for (const [id, entry] of [...this.remotes]) {
      try {
        entry.client.beginShutdown();
      } catch (error) {
        this.diagnostics.push(
          `remote:${id}:client-begin: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.beginRemoteClose(id, entry);
    }
  }

  /** Bounded, retryable fixed-point drain for dials, clients, and forwards. */
  drainOnQuit(): Promise<TerminalRouterShutdownReceipt> {
    this.beginShutdown();
    if (this.drainFlight !== undefined) return this.drainFlight;
    for (const [id, entry] of [...this.remotes]) {
      // An unclean client receipt is a bounded observation. A later socket
      // close may now be available, so each explicit drain gets one retry.
      if (
        entry.closeReceipt?.clean === false &&
        entry.closeReceipt.scopeClosed
      ) {
        entry.closeFlight = undefined;
        entry.closeReceipt = undefined;
      }
      this.beginRemoteClose(id, entry);
    }
    const current = (async (): Promise<TerminalRouterShutdownReceipt> => {
      const deadline = performance.now() + this.shutdownDeadlineMs;
      let rounds = 0;
      let settled = 0;
      let fulfilled = 0;
      let rejected = 0;
      const processed = new Set<Promise<unknown>>();

      for (;;) {
        for (const [id, entry] of [...this.remotes]) this.beginRemoteClose(id, entry);
        const round = [
          ...this.inFlight,
          ...[...this.remotes.values()]
            .map((entry) => entry.closeFlight)
            .filter((flight): flight is Promise<RemoteCloseReceipt> => flight !== undefined),
        ].filter((flight) => !processed.has(flight));
        if (round.length > 0) {
          const outcome = await allSettledBefore(round, deadline);
          if (outcome.timedOut) break;
          rounds += 1;
          settled += outcome.outcomes.length;
          fulfilled += outcome.outcomes.filter((entry) => entry.status === "fulfilled").length;
          rejected += outcome.outcomes.filter((entry) => entry.status === "rejected").length;
          for (const flight of round) processed.add(flight);
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
          continue;
        }
        if (this.inFlight.size === 0 && this.remotes.size === 0) {
          const diagnostics = Object.freeze([...this.diagnostics]);
          return Object.freeze({
            // Dial promises normally reject after the admission cut. Their
            // rejection is an operation outcome, not evidence of retained OS
            // authority; cleanup diagnostics remain fail-closed below.
            clean: diagnostics.length === 0,
            rounds,
            settled,
            fulfilled,
            rejected,
            retainedCounts: Object.freeze({
              dials: 0,
              remoteEntries: 0,
              remoteClosures: 0,
            }),
            retainedLabels: Object.freeze([]),
            diagnostics,
          });
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) break;
        await wait(Math.min(5, remainingMs));
      }

      const remoteClosures = [...this.remotes.values()].filter(
        (entry) => entry.closeFlight !== undefined,
      ).length;
      const labels = new Set<string>();
      if (this.inFlight.size > 0) labels.add("remote-dial");
      if (this.remotes.size > 0) labels.add("remote-entry");
      if (remoteClosures > 0) labels.add("remote-close");
      const diagnostics = [
        ...this.diagnostics,
        ...[...this.remotes.entries()].flatMap(([hostId, entry]) =>
          (entry.closeReceipt?.diagnostics ?? []).map(
            (item) => `remote:${hostId}:${item}`,
          )
        ),
      ];
      return Object.freeze({
        clean: false,
        rounds,
        settled,
        fulfilled,
        rejected,
        retainedCounts: Object.freeze({
          dials: this.inFlight.size,
          remoteEntries: this.remotes.size,
          remoteClosures,
        }),
        retainedLabels: Object.freeze([...labels].sort()),
        diagnostics: Object.freeze(diagnostics),
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

  /** Compatibility entry point; never hides an unclean remote drain. */
  async closeRemotes(): Promise<void> {
    const receipt = await this.drainOnQuit();
    if (!receipt.clean) {
      throw new Error(
        `terminal remote shutdown retained: ${receipt.retainedLabels.join(", ") || receipt.diagnostics.join(", ") || "unknown resource"}`,
      );
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
    let scope: Scope.CloseableScope;
    try {
      scope = await runAppPromise(
        Scope.fork(rootScope, ExecutionStrategy.sequential),
      );
    } catch (error) {
      const closed = await Promise.allSettled([
        runAppPromise(Scope.close(rootScope, Exit.void)),
      ]);
      if (closed[0]?.status === "rejected") {
        this.diagnostics.push(
          `dial:${hostId}:root-scope-close: ${closed[0].reason instanceof Error ? closed[0].reason.message : String(closed[0].reason)}`,
        );
      }
      throw error;
    }

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
                `no term control on ${hostId} — Vellum is not running there (open app or Settings → Deploy Remote)`,
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

      let client: TermControlClient;
      try {
        client = await TermControlClient.connect({
          socketPath: pair.localSocket,
          token: pair.token,
          timeoutMs: 12_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `cannot reach term control on ${hostId} (${msg}). Ensure Vellum Command is running on that Mac and ~/.vellum/term/control.sock exists`,
        );
      }

      const remoteEntry: RemoteEntry = {
        client,
        forward: pair.forward,
        endpoint,
        generation,
        scope,
        rootScope,
        leaseMap: new Map(),
        reverseLease: new Map(),
      };
      client.on("event", (payload: LocalHostEvent) => {
        this.emit("event", payload);
      });
      if (!admit()) {
        const receipt = await this.beginRemoteClose(hostId, remoteEntry);
        if (!receipt.client.closeObserved) {
          // This entry was never inserted into `remotes`, so the dial promise
          // is its final lifetime owner. Keep that promise in `inFlight` until
          // the exact socket-close witness instead of discarding an unclean
          // bounded receipt.
          await client.whenClosed();
        }
        if (!receipt.clean) {
          this.diagnostics.push(...receipt.diagnostics.map((item) => `dial:${hostId}:${item}`));
        }
        throw new Error("terminal router is stopping or host changed");
      }
      this.remotes.set(hostId, remoteEntry);
      return remoteEntry;
    } catch (err) {
      const closed = await Promise.allSettled([
        runAppPromise(Scope.close(rootScope, Exit.void)),
      ]);
      for (const outcome of closed) {
        if (outcome.status === "rejected") {
          this.diagnostics.push(
            `dial:${hostId}:scope-close: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
        }
      }
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

  private beginRemoteClose(
    hostId: string,
    entry: RemoteEntry,
  ): Promise<RemoteCloseReceipt> {
    if (entry.closeFlight !== undefined) return entry.closeFlight;
    let clientFlight: Promise<TermControlClientShutdownReceipt>;
    try {
      if (typeof entry.client.beginShutdown === "function") {
        entry.client.beginShutdown();
      } else {
        entry.client.close();
      }
      clientFlight = typeof entry.client.drainOnQuit === "function"
        ? entry.client.drainOnQuit()
        : Promise.resolve({
            clean: true,
            closeObserved: true,
            pendingRequests: 0,
            diagnostics: [],
          });
    } catch (error) {
      clientFlight = Promise.resolve({
        clean: false,
        closeObserved: false,
        pendingRequests: 0,
        diagnostics: [error instanceof Error ? error.message : String(error)],
      });
    }

    // Production entries always carry rootScope. The narrow fallback keeps
    // structural test doubles from accidentally invoking Effect with a forged
    // scope while real authorities remain fail-closed.
    const current = (async (): Promise<RemoteCloseReceipt> => {
      // Let the control socket obtain its exact close witness before retiring
      // the SSH forward. Closing both concurrently can manufacture ECONNRESET
      // and turn a clean local teardown into an ambiguous transport error.
      const [clientOutcome] = await Promise.allSettled([clientFlight]);
      const [scopeOutcome] = await Promise.allSettled([
        entry.rootScope === undefined
          ? Promise.resolve()
          : runAppPromise(Scope.close(entry.rootScope, Exit.void)),
      ]);
      const diagnostics: string[] = [];
      const client = clientOutcome.status === "fulfilled"
        ? clientOutcome.value
        : {
            clean: false,
            closeObserved: false,
            pendingRequests: 0,
            diagnostics: [
              clientOutcome.reason instanceof Error
                ? clientOutcome.reason.message
                : String(clientOutcome.reason),
            ],
          };
      diagnostics.push(...client.diagnostics.map((item) => `client: ${item}`));
      if (scopeOutcome.status === "rejected") {
        diagnostics.push(
          `scope: ${scopeOutcome.reason instanceof Error ? scopeOutcome.reason.message : String(scopeOutcome.reason)}`,
        );
      }
      const clean = client.clean && scopeOutcome.status === "fulfilled";
      const receipt: RemoteCloseReceipt = Object.freeze({
        clean,
        client,
        scopeClosed: scopeOutcome.status === "fulfilled",
        diagnostics: Object.freeze(diagnostics),
      });
      entry.closeReceipt = receipt;
      if (clean && this.remotes.get(hostId) === entry) this.remotes.delete(hostId);
      return receipt;
    })();
    entry.closeFlight = current;
    return current;
  }

  private async closeRemoteEntry(hostId: string, entry: RemoteEntry): Promise<void> {
    if (
      entry.closeReceipt?.clean === false &&
      entry.closeReceipt.scopeClosed
    ) {
      // Normal host-generation recovery must be able to re-observe a client
      // that closed just after its first bounded receipt, not only app quit.
      entry.closeFlight = undefined;
      entry.closeReceipt = undefined;
    }
    const receipt = await this.beginRemoteClose(hostId, entry);
    if (!receipt.clean) {
      throw new Error(
        `terminal remote ${hostId} close unclean: ${receipt.diagnostics.join(", ") || "unknown resource"}`,
      );
    }
  }
}
