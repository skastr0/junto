/**
 * Host-scoped Herdr service map: process → LISTEN ports → reachable URL.
 *
 * Cards never SSH. They read cache. Probes go through a rate-limited queue:
 *   intent  > change > ambient
 * with a few host commands per tick so hundreds of nodes stay linear.
 *
 * No herdr patches. LISTEN resolution is a host side-channel (lsof) via an
 * injectable shell runner (local spawn or existing SSH hop).
 */

import type { CliResult } from "../adapters/exec";
import { findHostById } from "../hosts/snapshot";
import {
  enqueueServiceProbe,
  interestLevel,
  parseLsofListen,
  portsFromCmdlineHints,
  processIdentityChanged,
  processIdentityKey,
  projectService,
  resolveHostBase,
  takeQueueForHost,
  type HerdrServicePort,
  type HerdrServicePriority,
  type HerdrServiceProcess,
  type HerdrServiceProjection,
  type HerdrServiceQueueItem,
  type HostReachability,
} from "@shared/herdr-service-map";

export type HostShellRunner = (
  hostId: string,
  argv: ReadonlyArray<string>,
  timeoutMs?: number,
) => Promise<CliResult>;

export type ProcessInfoFetcher = (
  hostId: string,
  session: string | null | undefined,
  paneId: string,
) => Promise<ReadonlyArray<HerdrServiceProcess>>;

export interface HerdrServiceMapOptions {
  readonly shell?: HostShellRunner;
  readonly fetchProcesses?: ProcessInfoFetcher;
  /** Max probe jobs per host per drain tick. Default 2. */
  readonly batchPerTick?: number;
  /** Minimum ms between drain ticks per host. Default 10_000. */
  readonly tickIntervalMs?: number;
  readonly now?: () => number;
  /** Resolve Tailscale/mesh override for a host id (optional). */
  readonly resolveTailscaleHost?: (hostId: string) => string | undefined;
}

const cacheKey = (
  hostId: string,
  session: string | null | undefined,
  paneId: string,
): string => `${hostId}\0${session ?? ""}\0${paneId}`;

export class HerdrServiceMap {
  private queue: ReadonlyArray<HerdrServiceQueueItem> = [];
  private readonly cache = new Map<string, HerdrServiceProjection>();
  private readonly hostTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hostRunning = new Set<string>();
  /** Hosts that need an immediate re-drain after the current one (intent cut-line). */
  private readonly intentKick = new Set<string>();
  private readonly listeners = new Set<(proj: HerdrServiceProjection) => void>();
  private batchPerTick: number;
  private tickIntervalMs: number;
  private now: () => number;
  private shell?: HostShellRunner;
  private fetchProcesses?: ProcessInfoFetcher;
  private resolveTailscaleHost?: (hostId: string) => string | undefined;
  private stopped = false;

  constructor(opts: HerdrServiceMapOptions = {}) {
    this.shell = opts.shell;
    this.fetchProcesses = opts.fetchProcesses;
    this.batchPerTick = opts.batchPerTick ?? 2;
    this.tickIntervalMs = opts.tickIntervalMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.resolveTailscaleHost = opts.resolveTailscaleHost;
  }

  /** Late-bind runners from HerdrPlane once transports exist. */
  applyConfig(opts: HerdrServiceMapOptions): void {
    if (opts.shell) this.shell = opts.shell;
    if (opts.fetchProcesses) this.fetchProcesses = opts.fetchProcesses;
    if (opts.resolveTailscaleHost) this.resolveTailscaleHost = opts.resolveTailscaleHost;
    if (opts.batchPerTick !== undefined) this.batchPerTick = opts.batchPerTick;
    if (opts.tickIntervalMs !== undefined) this.tickIntervalMs = opts.tickIntervalMs;
    if (opts.now) this.now = opts.now;
  }

  onChange(listener: (proj: HerdrServiceProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.hostTimers.values()) clearTimeout(t);
    this.hostTimers.clear();
  }

  get(
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ): HerdrServiceProjection | undefined {
    return this.cache.get(cacheKey(hostId, session, paneId));
  }

  listForHost(hostId: string): ReadonlyArray<HerdrServiceProjection> {
    const out: HerdrServiceProjection[] = [];
    for (const proj of this.cache.values()) {
      if (proj.hostId === hostId) out.push(proj);
    }
    return out;
  }

  /**
   * Observe processes from getPaneMeta / mirror without forcing a probe.
   * Enqueues change-priority when identity flips and interest is non-none;
   * ambient only for strong interest that has never been checked.
   */
  observeProcesses(input: {
    readonly hostId: string;
    readonly session?: string | null;
    readonly paneId: string;
    readonly processes?: ReadonlyArray<HerdrServiceProcess>;
  }): void {
    if (this.stopped || !input.paneId) return;
    // Mirror-fresh getPaneMeta omits processes by design — absent ≠ empty shell.
    // Never wipe ports/url on undefined payload.
    if (input.processes === undefined) return;

    const key = cacheKey(input.hostId, input.session, input.paneId);
    const level = interestLevel(input.processes);
    const prev = this.cache.get(key);
    const changed = processIdentityChanged(prev?.processes, input.processes);

    if (level === "none") {
      const skipped = projectService({
        hostId: input.hostId,
        session: input.session,
        paneId: input.paneId,
        processes: input.processes,
        hostBase: prev?.hostBase ?? this.hostBase(input.hostId),
        checkedAt: prev?.checkedAt,
        ports: undefined,
        now: this.now(),
      });
      this.write(skipped);
      return;
    }

    // Keep process snapshot on projection without wiping ports until re-probe.
    if (prev) {
      this.write({
        ...prev,
        processes: input.processes,
        interesting: true,
      });
    } else {
      this.write(
        projectService({
          hostId: input.hostId,
          session: input.session,
          paneId: input.paneId,
          processes: input.processes,
          hostBase: this.hostBase(input.hostId),
          pending: false,
          now: this.now(),
        }),
      );
    }

    if (changed && prev?.processes !== undefined) {
      this.enqueue({
        hostId: input.hostId,
        session: input.session,
        paneId: input.paneId,
        priority: "change",
        processes: input.processes,
      });
      return;
    }

    // First sight of strong interest → ambient (don't stampede on weak nvim).
    if (level === "strong" && (prev?.checkedAt === undefined || prev.health === "unknown")) {
      this.enqueue({
        hostId: input.hostId,
        session: input.session,
        paneId: input.paneId,
        priority: "ambient",
        processes: input.processes,
      });
    }
  }

  /** Intent: open terminal, Sync, wire page edge. Cuts the line. */
  requestProbe(input: {
    readonly hostId: string;
    readonly session?: string | null;
    readonly paneId: string;
    readonly priority?: HerdrServicePriority;
    readonly processes?: ReadonlyArray<HerdrServiceProcess>;
  }): HerdrServiceProjection {
    const priority = input.priority ?? "intent";
    const existing = this.get(input.hostId, input.session, input.paneId);
    // Keep last live projection painted while intent revalidates — no "port…" flash.
    const showPending = !(existing?.health === "live" || existing?.health === "stale");
    const pending = projectService({
      hostId: input.hostId,
      session: input.session,
      paneId: input.paneId,
      processes: input.processes ?? existing?.processes,
      ports: existing?.ports,
      hostBase: existing?.hostBase ?? this.hostBase(input.hostId),
      checkedAt: existing?.checkedAt,
      pending: showPending,
      priority,
      now: this.now(),
    });
    this.write(pending);
    this.enqueue({
      hostId: input.hostId,
      session: input.session,
      paneId: input.paneId,
      priority,
      processes: input.processes ?? existing?.processes,
    });
    // Intent drains ASAP (0 delay); if a drain is mid-flight, re-arm 0 after it.
    if (priority === "intent") {
      this.intentKick.add(input.hostId);
      this.scheduleHost(input.hostId, 0);
    }
    return pending;
  }

  /** Test / forced single drain without waiting for timer. */
  async drainHostNow(hostId: string): Promise<void> {
    await this.drainHost(hostId);
  }

  // --- internals ------------------------------------------------------------

  private hostBase(hostId: string): string | undefined {
    const host = findHostById(hostId);
    const reach: HostReachability = {
      hostId,
      kind: host?.kind === "remote" ? "remote" : "local",
      endpoint: host?.kind === "remote" ? host.endpoint : undefined,
      tailscaleHost: this.resolveTailscaleHost?.(hostId),
    };
    return resolveHostBase(reach);
  }

  private enqueue(item: Omit<HerdrServiceQueueItem, "enqueuedAt"> & { enqueuedAt?: number }): void {
    this.queue = enqueueServiceProbe(this.queue, {
      ...item,
      enqueuedAt: item.enqueuedAt ?? this.now(),
    });
    this.scheduleHost(item.hostId, this.tickIntervalMs);
  }

  private scheduleHost(hostId: string, delayMs: number): void {
    if (this.stopped) return;
    if (this.hostTimers.has(hostId)) {
      // Already scheduled; intent uses 0 — reschedule if faster.
      if (delayMs > 0) return;
      clearTimeout(this.hostTimers.get(hostId));
      this.hostTimers.delete(hostId);
    }
    const timer = setTimeout(() => {
      this.hostTimers.delete(hostId);
      void this.drainHost(hostId);
    }, delayMs);
    this.hostTimers.set(hostId, timer);
  }

  private async drainHost(hostId: string): Promise<void> {
    if (this.stopped || this.hostRunning.has(hostId)) return;
    this.hostRunning.add(hostId);
    try {
      const { taken, rest } = takeQueueForHost(this.queue, hostId, this.batchPerTick);
      this.queue = rest;
      for (const item of taken) {
        await this.probeOne(item);
      }
      // More work for this host?
      if (this.queue.some((q) => q.hostId === hostId)) {
        const asap = this.intentKick.has(hostId);
        this.intentKick.delete(hostId);
        this.scheduleHost(hostId, asap ? 0 : this.tickIntervalMs);
      } else {
        this.intentKick.delete(hostId);
      }
    } finally {
      this.hostRunning.delete(hostId);
      // Intent arrived mid-drain: schedule immediate follow-up.
      if (this.intentKick.has(hostId) && this.queue.some((q) => q.hostId === hostId)) {
        this.intentKick.delete(hostId);
        this.scheduleHost(hostId, 0);
      }
    }
  }

  private async probeOne(item: HerdrServiceQueueItem): Promise<void> {
    const hostBase = this.hostBase(item.hostId);
    let processes = item.processes;
    if ((!processes || processes.length === 0) && this.fetchProcesses) {
      try {
        processes = await this.fetchProcesses(item.hostId, item.session, item.paneId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.write(
          projectService({
            hostId: item.hostId,
            session: item.session,
            paneId: item.paneId,
            processes,
            hostBase,
            pending: false,
            error: message,
            checkedAt: this.now(),
            now: this.now(),
          }),
        );
        return;
      }
    }

    const level = interestLevel(processes);
    if (level === "none") {
      this.write(
        projectService({
          hostId: item.hostId,
          session: item.session,
          paneId: item.paneId,
          processes,
          hostBase,
          checkedAt: this.now(),
          now: this.now(),
        }),
      );
      return;
    }

    const pids = (processes ?? [])
      .map((p) => p.pid)
      .filter((p): p is number => typeof p === "number" && p > 0);

    let ports: ReadonlyArray<HerdrServicePort> = [];
    let error: string | undefined;
    let transportFailed = false;
    if (pids.length > 0 && this.shell) {
      try {
        ports = await this.resolveListenPorts(item.hostId, pids);
      } catch (err) {
        transportFailed = true;
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (!transportFailed && ports.length === 0) {
      ports = portsFromCmdlineHints(processes);
    }

    // Transport/SSH failure must not paint live→dead: keep prior ports/url.
    if (transportFailed) {
      const prev = this.get(item.hostId, item.session, item.paneId);
      this.write(
        projectService({
          hostId: item.hostId,
          session: item.session,
          paneId: item.paneId,
          processes,
          ports: prev?.ports ?? portsFromCmdlineHints(processes),
          hostBase: prev?.hostBase ?? hostBase,
          checkedAt: prev?.checkedAt,
          pending: false,
          error,
          priority: item.priority,
          now: this.now(),
        }),
      );
      return;
    }

    this.write(
      projectService({
        hostId: item.hostId,
        session: item.session,
        paneId: item.paneId,
        processes,
        ports,
        hostBase,
        checkedAt: this.now(),
        pending: false,
        error,
        priority: item.priority,
        now: this.now(),
      }),
    );
  }

  private async resolveListenPorts(
    hostId: string,
    pids: ReadonlyArray<number>,
  ): Promise<ReadonlyArray<HerdrServicePort>> {
    if (!this.shell || pids.length === 0) return [];
    // Sequential per-pane probe (batchPerTick limits how many run per tick).
    const pidList = pids.join(",");
    const result = await this.shell(
      hostId,
      ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pidList],
      8_000,
    );
    if (!result.ok) {
      // Transport/SSH failures carry `error`. Empty lsof (no LISTEN) often
      // exits 1 with empty stdout and no error — treat as no ports.
      if (result.error) throw new Error(result.error);
      return [];
    }
    return parseLsofListen(result.stdout, pids);
  }

  private write(proj: HerdrServiceProjection): void {
    const key = cacheKey(proj.hostId, proj.session, proj.paneId);
    const prev = this.cache.get(key);
    if (prev && servicePaintEqual(prev, proj)) return;
    this.cache.set(key, proj);
    for (const listener of this.listeners) {
      try {
        listener(proj);
      } catch {
        // listeners must not break the map
      }
    }
  }
}

const servicePaintEqual = (a: HerdrServiceProjection, b: HerdrServiceProjection): boolean =>
  a.health === b.health &&
  a.url === b.url &&
  a.hostBase === b.hostBase &&
  a.error === b.error &&
  a.interesting === b.interesting &&
  a.checkedAt === b.checkedAt &&
  processIdentityKey(a.processes) === processIdentityKey(b.processes) &&
  (a.ports ?? []).map((p) => p.port).join(",") === (b.ports ?? []).map((p) => p.port).join(",");


/**
 * Configure an existing map's runners after construction (plane injects
 * host shell + process-info fetch once SSH/herdr transports are live).
 */
export const configureHerdrServiceMap = (
  map: HerdrServiceMap,
  opts: HerdrServiceMapOptions,
): void => {
  // Reconstruct by mutating private fields via a narrow apply API.
  map.applyConfig(opts);
};
