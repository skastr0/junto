/**
 * Host-scoped Tailscale Serve / SVC catalog.
 * Fetches `tailscale serve status --json` on the host (local or SSH shell hop).
 * Soft-fail; TTL cache; no per-card polling.
 */

import type { CliResult } from "../adapters/exec";
import {
  listNamedServices,
  parseTailscaleServeStatus,
  preferredPublicUrlForLocalPorts,
  type TailscaleServeCatalog,
  type TailscaleServeEntry,
} from "@shared/tailscale-serve";
import {
  awaitHerdrPromiseFixedPoint,
  cleanHerdrComponentReceipt,
  herdrComponentReceipt,
  type HerdrComponentShutdownReceipt,
  validateHerdrShutdownTimeout,
} from "../herdr/shutdown";

export type ServeStatusRunner = (hostId: string) => Promise<CliResult>;

const DEFAULT_TTL_MS = 3 * 60_000;

export interface HostServeCatalogOptions {
  readonly runServeStatus?: ServeStatusRunner;
  /** Resolve machine MagicDNS/IP for TCP-forward public URLs. */
  readonly resolveHostBase?: (hostId: string) => string | undefined;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly shutdownDrainTimeoutMs?: number;
}

export class HostServeCatalog {
  private readonly cache = new Map<string, TailscaleServeCatalog>();
  private readonly inflight = new Map<string, Promise<TailscaleServeCatalog>>();
  private readonly runServeStatus?: ServeStatusRunner;
  private readonly resolveHostBase?: (hostId: string) => string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly shutdownDrainTimeoutMs: number;
  private shuttingDown = false;
  private drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  private cleanShutdownReceipt: HerdrComponentShutdownReceipt | undefined;

  constructor(opts: HostServeCatalogOptions = {}) {
    this.runServeStatus = opts.runServeStatus;
    this.resolveHostBase = opts.resolveHostBase;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.shutdownDrainTimeoutMs = validateHerdrShutdownTimeout(
      opts.shutdownDrainTimeoutMs,
      2_000,
    );
  }

  get(hostId: string): TailscaleServeCatalog | undefined {
    return this.cache.get(hostId);
  }

  listServices(hostId: string): ReadonlyArray<TailscaleServeEntry> {
    const cat = this.cache.get(hostId);
    return cat ? listNamedServices(cat) : [];
  }

  /**
   * Prefer SVC/web public URL for local LISTEN ports on this host.
   * Uses last-known catalog; kicks background refresh when stale.
   */
  preferredUrl(
    hostId: string,
    localPorts: ReadonlyArray<number>,
  ): { readonly url: string; readonly entry: TailscaleServeEntry } | undefined {
    const cat = this.cache.get(hostId);
    const age = cat?.fetchedAt !== undefined ? this.now() - cat.fetchedAt : Infinity;
    if (!this.shuttingDown && (!cat || age > this.ttlMs)) {
      void this.refresh(hostId);
    }
    return preferredPublicUrlForLocalPorts(cat, localPorts);
  }

  async refresh(hostId: string): Promise<TailscaleServeCatalog> {
    if (this.shuttingDown) {
      return this.cache.get(hostId) ?? {
        hostId,
        entries: [],
        fetchedAt: this.now(),
        error: "Herdr Serve catalog is shutting down",
      };
    }
    const existing = this.inflight.get(hostId);
    if (existing) return existing;

    const job = this.load(hostId).finally(() => {
      this.inflight.delete(hostId);
    });
    this.inflight.set(hostId, job);
    return job;
  }

  /** Permanently refuse new host status work before any asynchronous drain. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Wait for every refresh admitted before beginShutdown(). A timeout leaves
   * the exact refresh promises in `inflight` and returns an unclean receipt;
   * a later call can prove convergence after those operations really settle.
   */
  drainOnQuit(): Promise<HerdrComponentShutdownReceipt> {
    this.beginShutdown();
    if (this.cleanShutdownReceipt) return Promise.resolve(this.cleanShutdownReceipt);
    if (this.drainFlight) return this.drainFlight;
    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      const settled = await awaitHerdrPromiseFixedPoint(
        () => [...this.inflight.values()],
        this.shutdownDrainTimeoutMs,
      );
      const receipt = settled && this.inflight.size === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(this.inflight.size, [{
            code: "serve-refresh-retained",
            message: `${this.inflight.size} Serve catalog refresh operation(s) did not settle before shutdown timeout`,
          }]);
      if (receipt.clean) this.cleanShutdownReceipt = receipt;
      return receipt;
    })();
    this.drainFlight = flight;
    void flight.finally(() => {
      if (this.drainFlight === flight) this.drainFlight = undefined;
    });
    return flight;
  }

  /** Sync peek or empty; does not block on network. */
  peekOrEmpty(hostId: string): TailscaleServeCatalog {
    return this.cache.get(hostId) ?? { hostId, entries: [] };
  }

  private async load(hostId: string): Promise<TailscaleServeCatalog> {
    if (!this.runServeStatus) {
      const empty = { hostId, entries: [] as const, fetchedAt: this.now() };
      this.cache.set(hostId, empty);
      return empty;
    }
    try {
      const result = await this.runServeStatus(hostId);
      if (!result.ok || !result.stdout.trim()) {
        const failed: TailscaleServeCatalog = {
          hostId,
          entries: this.cache.get(hostId)?.entries ?? [],
          fetchedAt: this.now(),
          error: result.error ?? "serve status empty",
        };
        // Keep prior entries on soft fail
        if ((this.cache.get(hostId)?.entries.length ?? 0) > 0) {
          const prior = this.cache.get(hostId)!;
          const sticky = {
            ...prior,
            fetchedAt: this.now(),
            error: failed.error,
          };
          this.cache.set(hostId, sticky);
          return sticky;
        }
        this.cache.set(hostId, failed);
        return failed;
      }
      const parsed = JSON.parse(result.stdout) as unknown;
      const catalog = parseTailscaleServeStatus(parsed, {
        hostId,
        hostBase: this.resolveHostBase?.(hostId),
      });
      const stamped: TailscaleServeCatalog = {
        ...catalog,
        fetchedAt: this.now(),
      };
      this.cache.set(hostId, stamped);
      return stamped;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prior = this.cache.get(hostId);
      const failed: TailscaleServeCatalog = {
        hostId,
        entries: prior?.entries ?? [],
        fetchedAt: this.now(),
        error: message,
      };
      this.cache.set(hostId, failed);
      return failed;
    }
  }
}
