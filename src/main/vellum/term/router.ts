/**
 * Host-aware terminal authority router.
 * - local → LocalSessionHost (this process)
 * - remote hostId → TermControlClient via SSH unix-forward of ~/.vellum-command/term/control.sock
 *
 * Remote sessions are owned by the remote Vellum Command station; CC quit does not kill them.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Context, Effect, Exit, Scope } from "effect";
import {
  findHostById,
  hostsWithCapability,
  subscribeHostsSnapshot,
} from "../hosts/snapshot";
import { isLocalHost, TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import {
  isTermMaintenanceObservationId,
  TERM_REMOTE_SOCK_REL,
  type TermMaintenanceDenialReason,
  type TermMaintenanceEvidence,
  type TermMaintenanceQuiescenceEvidence,
} from "@shared/term-control";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import type { HostDirectorySnapshot } from "@shared/host-directory";
import {
  parseRemoteUnixSocketPath,
  parseHostSshRoute,
} from "../ssh/domain";
import { homeDirectoryLookup, oneShot, unixForward } from "../ssh/program";
import { remoteCat } from "../ssh/read-commands";
import type { SshForwardLease } from "../ssh/service";
import { SshTransport } from "../ssh/service";
import type {
  ControlLease,
  JournalEntry,
  LocalHostAgentSeatInput,
  LocalHostCreateInput,
  LocalHostEvent,
  LocalHostShutdownResult,
  LocalSessionHost,
  TerminalOpenInput,
} from "./local-host";
import { TermControlClient } from "./control-client";
import { readHostDirectory } from "./host-directory";
import type { TermControlClientShutdownReceipt } from "./control-client";

/**
 * Layered Effect runner for SSH/Scope work. Configured once by the process
 * entry (Electron `AppRuntime` or Node `RemoteRuntime`) so this module never
 * imports Electron's runtime graph.
 */
export type TerminalRouterLayeredRunner = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Promise<A>;

let configuredLayeredRunner: TerminalRouterLayeredRunner | undefined;

export const configureTerminalRouterLayeredRunner = (
  runner: TerminalRouterLayeredRunner,
): void => {
  configuredLayeredRunner = runner;
};

export const resetTerminalRouterLayeredRunnerForTests = (): void => {
  configuredLayeredRunner = undefined;
};

// Effects that need SshTransport / Scope from the process RootLayer.
const runLayered = async <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Promise<A> => {
  const runner = configuredLayeredRunner;
  if (runner === undefined) {
    throw new Error("terminal router layered runner is not configured");
  }
  return runner(effect);
};

/**
 * R=never Scope.make/close — empty Context is correct (no product services).
 * Do not route through the layered SSH runner: unit tests never configure it,
 * and Scope finalizers must still run on close/error paths.
 */
const runScopePromise = <A>(
  effect: Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromiseWith(Context.empty())(effect);

type RemoteEntry = {
  client: TermControlClient;
  forward: SshForwardLease;
  /** Registry endpoint used to establish this connection. */
  endpoint: string;
  /** Snapshot generation used to establish this connection. */
  generation: number;
  /** Forked Effect scope that owns the SSH forward finalizers. */
  scope: Scope.Closeable;
  /** Parent scope must be closed too; retaining only the child leaks authority. */
  rootScope: Scope.Closeable;
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
  /** Tests may lower, never raise, host-cut proof and route-retirement time. */
  readonly maintenanceDeadlineMs?: number;
}

declare const terminalRouterMaintenanceLeaseBrand: unique symbol;

export type TerminalRouterMaintenanceEvidence = TermMaintenanceQuiescenceEvidence;

/**
 * Opaque Command Center authority for one remote host's route-admission cut.
 * The release closure is bound to the exact in-process record; callers cannot
 * synthesize a lease or redirect it to another host.
 */
export type TerminalRouterMaintenanceLease = {
  readonly [terminalRouterMaintenanceLeaseBrand]: true;
  readonly evidence: TerminalRouterMaintenanceEvidence;
  readonly release: () => boolean;
};

export type TerminalRouterMaintenanceAcquireResult =
  | {
      readonly acquired: true;
      readonly evidence: TerminalRouterMaintenanceEvidence;
      readonly lease: TerminalRouterMaintenanceLease;
    }
  | {
      readonly acquired: false;
      readonly evidence: TermMaintenanceEvidence;
      readonly reason: TermMaintenanceDenialReason;
    };

type HostMaintenanceCut = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly generation: number;
  phase: "acquiring" | "held" | "poisoned" | "retired";
  lease?: TerminalRouterMaintenanceLease;
};

const ROUTER_SHUTDOWN_DEADLINE_MS = 3_000;
const ROUTER_MAINTENANCE_DEADLINE_MS = 20_000;

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
    {
      readonly endpoint: string;
      readonly promise: Promise<RemoteEntry>;
      readonly maintenanceCut?: HostMaintenanceCut;
    }
  >();
  /** Every dial remains visible until its scope has settled, even if superseded. */
  private readonly inFlight = new Set<Promise<RemoteEntry>>();
  /** Host provenance lets one maintenance cut drain only its target's dials. */
  private readonly inFlightHosts = new Map<Promise<RemoteEntry>, string>();
  /** Command Center cuts outlive target sockets and Remote process restarts. */
  private readonly maintenanceCuts = new Map<string, HostMaintenanceCut>();
  /** Once shutdown begins, this router cannot acquire another remote authority. */
  private quiescing = false;
  private unsubscribed = false;
  private generation = 0;
  private readonly unsubscribeHosts: () => void;
  private readonly shutdownDeadlineMs: number;
  private readonly maintenanceDeadlineMs: number;
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
    this.maintenanceDeadlineMs = boundedRuntimeValue(
      runtime.maintenanceDeadlineMs,
      ROUTER_MAINTENANCE_DEADLINE_MS,
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

  private assertSessionAdmission(hostId?: string): void {
    if (this.quiescing) throw new Error("terminal router is stopping");
    if (hostId !== undefined && this.maintenanceCuts.has(hostId)) {
      throw new Error("terminal route admission closed for maintenance");
    }
  }

  private routeAdmissionOpen(
    hostId: string,
    maintenanceCut?: HostMaintenanceCut,
  ): boolean {
    if (this.quiescing) return false;
    const current = this.maintenanceCuts.get(hostId);
    if (current === undefined) return maintenanceCut === undefined;
    return current === maintenanceCut && current.phase === "acquiring";
  }

  private assertRouteAdmission(
    hostId: string,
    maintenanceCut?: HostMaintenanceCut,
  ): void {
    if (!this.routeAdmissionOpen(hostId, maintenanceCut)) {
      throw new Error(
        this.quiescing
          ? "terminal router is stopping"
          : "terminal route admission closed for maintenance",
      );
    }
  }

  isLocalHostId(hostId: string | undefined | null): boolean {
    if (hostId === undefined || hostId === null || hostId.trim() === "") return true;
    const host = findHostById(hostId.trim());
    return host !== undefined && isLocalHost(host);
  }

  /** Resolve the target host and take the session-admission cut for it. */
  private admitSessionHost(input: { readonly hostId?: string }): string {
    const hostId = input.hostId?.trim() || "local";
    this.assertSessionAdmission(hostId);
    return hostId;
  }

  /** Open a geography terminal on its host. */
  async create(
    input: LocalHostCreateInput & { hostId?: string },
  ): Promise<TerminalSessionSummary> {
    const hostId = this.admitSessionHost(input);
    return this.isLocalHostId(hostId)
      ? this.local.create({ ...input, hostId: "local" })
      : this.createRemote(hostId, input);
  }

  /**
   * Open the actor seat on its host. A station's terminal protocol carries no
   * seat, so a station-hosted seat runs its planned argv as a plain terminal
   * generation; station-aware seats are product work tracked in
   * `managed-terminal-plan.md`.
   */
  async createAgentSeat(
    input: LocalHostAgentSeatInput & { hostId?: string },
  ): Promise<TerminalSessionSummary> {
    const hostId = this.admitSessionHost(input);
    if (!this.isLocalHostId(hostId)) {
      return this.createRemote(hostId, input);
    }
    const summary = this.local.createAgentSeat({ ...input, hostId: "local" });
    // exitWitness.then is always a microtask — even when the child already
    // died during spawn. Flush one turn so resume fail-open can replace the
    // binding before the renderer latches create's summary as final.
    await Promise.resolve();
    return this.local.get(input.bindingId.trim()) ?? summary;
  }

  private async createRemote(
    hostId: string,
    input: TerminalOpenInput & { launch?: TerminalLaunch },
  ): Promise<TerminalSessionSummary> {
    const client = await this.ensureRemoteClient(hostId);
    this.assertRouteAdmission(hostId);
    const summary = await client.create({
      bindingId: input.bindingId,
      launch: input.launch,
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
    const normalizedHostId = hostId?.trim();
    if (normalizedHostId && this.maintenanceCuts.has(normalizedHostId)) return [];
    if (!hostId || this.isLocalHostId(hostId)) return this.local.list();
    try {
      const c = await this.ensureRemoteClient(hostId);
      this.assertRouteAdmission(hostId);
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

  async readDirectory(
    hostId: string | undefined,
    path?: string,
  ): Promise<HostDirectorySnapshot> {
    const normalizedHostId = hostId?.trim();
    if (!normalizedHostId || this.isLocalHostId(normalizedHostId)) {
      return readHostDirectory(path);
    }
    const client = await this.ensureRemoteClient(normalizedHostId);
    this.assertRouteAdmission(normalizedHostId);
    return client.readDirectory(path);
  }

  async get(
    bindingId: string,
    hostId?: string,
  ): Promise<TerminalSessionSummary | undefined> {
    const normalizedHostId = hostId?.trim();
    if (normalizedHostId && this.maintenanceCuts.has(normalizedHostId)) {
      return undefined;
    }
    if (!hostId || this.isLocalHostId(hostId)) return this.local.get(bindingId);
    try {
      const c = await this.ensureRemoteClient(hostId);
      this.assertRouteAdmission(hostId);
      const s = await c.get(bindingId);
      return s ? { ...s, hostId } : undefined;
    } catch {
      return undefined;
    }
  }

  async kill(bindingId: string, hostId?: string): Promise<boolean> {
    if (this.quiescing) return false;
    const normalizedHostId = hostId?.trim();
    if (normalizedHostId && this.maintenanceCuts.has(normalizedHostId)) return false;
    if (!hostId || this.isLocalHostId(hostId)) return this.local.kill(bindingId);
    try {
      const c = await this.ensureRemoteClient(hostId);
      this.assertRouteAdmission(hostId);
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
    const normalizedHostId = hostId?.trim() || "local";
    this.assertSessionAdmission(normalizedHostId);
    if (!hostId || this.isLocalHostId(hostId)) {
      this.local.bindCanvas(bindingId, ref);
      return;
    }
    const c = await this.ensureRemoteClient(hostId);
    this.assertRouteAdmission(hostId);
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
    if (this.maintenanceCuts.has(hostId)) {
      return {
        ok: false,
        message: "terminal route admission closed for maintenance",
      };
    }
    if (this.isLocalHostId(hostId)) {
      return await this.local.attach(input);
    }
    try {
      const entry = await this.ensureRemoteEntry(hostId);
      this.assertRouteAdmission(hostId);
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
    const normalizedHostId = hostId?.trim();
    if (normalizedHostId && this.maintenanceCuts.has(normalizedHostId)) return false;
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
    const normalizedHostId = hostId?.trim();
    if (normalizedHostId && this.maintenanceCuts.has(normalizedHostId)) return false;
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

  /**
   * Upgrade path: reserve the durable Command Center cut, obtain the target
   * station's exact zero-session maintenance witness, then retire the entire
   * route/forward before returning package-mutation authority.
   */
  async acquireRemoteHostMaintenance(
    hostIdInput: string,
  ): Promise<TerminalRouterMaintenanceAcquireResult> {
    const cut = this.reserveMaintenanceCut(hostIdInput);
    let routeRetirementRequired = false;
    let routeRetirementStarted = false;
    try {
      const entry = await this.ensureRemoteEntry(cut.hostId, cut);
      // A lost response may mean the target acquired its socket-bound cut.
      // From this point onward the route must be retired before our CC cut can
      // be removed or an error returned.
      routeRetirementRequired = true;
      const admission = await entry.client.acquireMaintenance();
      if (!admission.acquired) {
        routeRetirementRequired = false;
        this.releaseMaintenanceCut(cut);
        return admission;
      }
      if (
        admission.evidence.activeTerminalSessions !== 0 ||
        !isTermMaintenanceObservationId(admission.evidence.observationId)
      ) {
        throw new Error("terminal maintenance proof was invalid");
      }

      routeRetirementStarted = true;
      await this.retireRemoteHostRoute(cut);
      routeRetirementRequired = false;
      this.assertMaintenanceTargetCurrent(cut);
      const evidence = Object.freeze({
        activeTerminalSessions: 0 as const,
        observationId: admission.evidence.observationId,
      });
      const lease = this.holdMaintenanceCut(cut, evidence);
      return { acquired: true, evidence, lease };
    } catch (error) {
      if (routeRetirementRequired && !routeRetirementStarted) {
        try {
          routeRetirementStarted = true;
          await this.retireRemoteHostRoute(cut);
          routeRetirementRequired = false;
        } catch {
          // Do not reopen a host when a target-side maintenance response or
          // route close remains ambiguous. Shutdown can still drain it.
          cut.phase = "poisoned";
        }
      }
      if (routeRetirementRequired) cut.phase = "poisoned";
      else this.releaseMaintenanceCut(cut);
      throw error instanceof Error
        ? error
        : new Error("terminal route maintenance failed");
    }
  }

  private reserveMaintenanceCut(hostIdInput: string): HostMaintenanceCut {
    const hostId = hostIdInput.trim();
    if (this.quiescing) throw new Error("terminal router is stopping");
    if (hostId.length === 0 || this.maintenanceCuts.has(hostId)) {
      throw new Error("terminal route maintenance unavailable");
    }
    const host = findHostById(hostId);
    if (!host || host.kind !== "remote" || !host.sshEndpoint) {
      throw new Error("terminal route maintenance requires a remote host");
    }
    const cut: HostMaintenanceCut = {
      hostId,
      endpoint: host.sshEndpoint,
      generation: this.generation,
      phase: "acquiring",
    };
    this.maintenanceCuts.set(hostId, cut);
    return cut;
  }

  private assertMaintenanceTargetCurrent(cut: HostMaintenanceCut): void {
    if (
      this.quiescing ||
      this.maintenanceCuts.get(cut.hostId) !== cut ||
      cut.phase !== "acquiring"
    ) {
      throw new Error("terminal route maintenance was revoked");
    }
    const current = findHostById(cut.hostId);
    if (
      current?.kind !== "remote" ||
      current.sshEndpoint !== cut.endpoint ||
      this.generation !== cut.generation
    ) {
      throw new Error("terminal route maintenance target changed");
    }
  }

  private holdMaintenanceCut(
    cut: HostMaintenanceCut,
    evidence: TerminalRouterMaintenanceEvidence,
  ): TerminalRouterMaintenanceLease {
    this.assertMaintenanceTargetCurrent(cut);
    let lease!: TerminalRouterMaintenanceLease;
    lease = Object.freeze({
      evidence,
      release: () =>
        cut.lease === lease && this.releaseMaintenanceCut(cut),
    }) as TerminalRouterMaintenanceLease;
    cut.phase = "held";
    cut.lease = lease;
    return lease;
  }

  private releaseMaintenanceCut(cut: HostMaintenanceCut): boolean {
    if (this.maintenanceCuts.get(cut.hostId) !== cut) return false;
    this.maintenanceCuts.delete(cut.hostId);
    cut.phase = "retired";
    cut.lease = undefined;
    return true;
  }

  /**
   * Fixed-point target-only drain. It closes clients and SSH-forward scopes,
   * never remote sessions. Superseded dials remain visible until their own
   * cleanup settles.
   */
  private async retireRemoteHostRoute(cut: HostMaintenanceCut): Promise<void> {
    const deadline = performance.now() + this.maintenanceDeadlineMs;
    for (;;) {
      if (
        this.quiescing ||
        this.maintenanceCuts.get(cut.hostId) !== cut
      ) {
        throw new Error("terminal route maintenance was revoked");
      }
      // A pre-cut dial captured this map slot in its admission predicate.
      // Removing the slot makes that predicate fail before it can publish.
      this.connecting.delete(cut.hostId);
      const work: Promise<unknown>[] = [];
      const entry = this.remotes.get(cut.hostId);
      if (entry !== undefined) {
        work.push(this.closeRemoteEntry(cut.hostId, entry));
      }
      for (const [flight, hostId] of this.inFlightHosts) {
        if (hostId === cut.hostId) work.push(flight);
      }
      if (
        work.length === 0 &&
        this.remotes.get(cut.hostId) === undefined &&
        ![...this.inFlightHosts.values()].includes(cut.hostId)
      ) {
        return;
      }
      const outcome = await allSettledBefore(work, deadline);
      if (outcome.timedOut || performance.now() >= deadline) {
        throw new Error("terminal remote route retirement timed out");
      }
      await wait(Math.min(5, Math.max(0, deadline - performance.now())));
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
    for (const cut of this.maintenanceCuts.values()) {
      cut.phase = "retired";
      cut.lease = undefined;
    }
    this.maintenanceCuts.clear();
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

  private async ensureRemoteEntry(
    hostId: string,
    maintenanceCut?: HostMaintenanceCut,
  ): Promise<RemoteEntry> {
    this.assertRouteAdmission(hostId, maintenanceCut);
    const host = findHostById(hostId);
    if (!host || host.kind !== "remote" || !host.sshEndpoint) {
      const stale = this.remotes.get(hostId);
      if (stale) await this.closeRemoteEntry(hostId, stale);
      throw new Error(`host ${hostId} is not a remote SSH endpoint`);
    }
    const endpoint = host.sshEndpoint;
    const existing = this.remotes.get(hostId);
    if (existing) {
      if (existing.endpoint === endpoint && existing.generation === this.generation) {
        this.assertRouteAdmission(hostId, maintenanceCut);
        return existing;
      }
      await this.closeRemoteEntry(hostId, existing);
      this.assertRouteAdmission(hostId, maintenanceCut);
    }
    const inflight = this.connecting.get(hostId);
    if (
      inflight?.endpoint === endpoint &&
      inflight.maintenanceCut === maintenanceCut
    ) {
      return inflight.promise;
    }
    if (inflight) this.connecting.delete(hostId);

    let promise!: Promise<RemoteEntry>;
    const generation = this.generation;
    const dialing = this.connectRemote(hostId, endpoint, generation, () =>
      this.routeAdmissionOpen(hostId, maintenanceCut) &&
      this.connecting.get(hostId)?.promise === promise &&
      findHostById(hostId)?.kind === "remote" &&
      findHostById(hostId)?.sshEndpoint === endpoint &&
      generation === this.generation,
    );
    promise = dialing.finally(() => {
      this.inFlight.delete(promise);
      this.inFlightHosts.delete(promise);
    });
    this.inFlight.add(promise);
    this.inFlightHosts.set(promise, hostId);
    this.connecting.set(hostId, {
      endpoint,
      promise,
      ...(maintenanceCut === undefined ? {} : { maintenanceCut }),
    });
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
    const rootScope = await runScopePromise(Scope.make());
    let scope: Scope.Closeable;
    try {
      scope = await runScopePromise(
        Scope.fork(rootScope, "sequential"),
      );
    } catch (error) {
      const closed = await Promise.allSettled([
        runScopePromise(Scope.close(rootScope, Exit.void)),
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
          const host = findHostById(hostId);
          if (!host || host.kind !== "remote" || host.sshEndpoint !== endpoint) {
            return yield* Effect.fail(
              new Error(`host ${hostId} SSH route changed before dial`),
            );
          }
          const sshEndpoint = yield* parseHostSshRoute(host);
          const homeResult = yield* ssh.run(homeDirectoryLookup(sshEndpoint));
          const home = homeResult.stdout.trim() || ".";
          const remoteSock = yield* parseRemoteUnixSocketPath(
            join(home, TERM_REMOTE_SOCK_REL),
          );
          const forward = yield* ssh
            .forward(unixForward(sshEndpoint, remoteSock))
            .pipe(Scope.provide(scope));
          const tokenCmd = yield* remoteCat(
            join(home, ".vellum-command", "term", "token"),
          );
          const tokenRes = yield* ssh.run(
            oneShot(sshEndpoint, tokenCmd, { budget: "short" }),
          );
          const token = tokenRes.stdout.trim();
          if (!token) {
            return yield* Effect.fail(
              new Error(
                `no term control on ${hostId} — Vellum Command is not running there (open app or Settings → Deploy Remote)`,
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
          `cannot reach term control on ${hostId} (${msg}). Ensure Vellum Command is running on that Mac and ~/.vellum-command/term/control.sock exists`,
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
        runScopePromise(Scope.close(rootScope, Exit.void)),
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
    if (this.maintenanceCuts.has(hostId)) {
      await this.closeRemoteEntry(hostId, entry).catch(() => undefined);
      return undefined;
    }
    const host = findHostById(hostId);
    if (
      host?.kind === "remote" &&
      host.sshEndpoint === entry.endpoint &&
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

    const current = (async (): Promise<RemoteCloseReceipt> => {
      // Let the control socket obtain its exact close witness before retiring
      // the SSH forward. Closing both concurrently can manufacture ECONNRESET
      // and turn a clean local teardown into an ambiguous transport error.
      const [clientOutcome] = await Promise.allSettled([clientFlight]);
      const [scopeOutcome] = await Promise.allSettled([
        runScopePromise(Scope.close(entry.rootScope, Exit.void)),
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
