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

export type ServeStatusRunner = (hostId: string) => Promise<CliResult>;

const DEFAULT_TTL_MS = 3 * 60_000;

export interface HostServeCatalogOptions {
  readonly runServeStatus?: ServeStatusRunner;
  /** Resolve machine MagicDNS/IP for TCP-forward public URLs. */
  readonly resolveHostBase?: (hostId: string) => string | undefined;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class HostServeCatalog {
  private readonly cache = new Map<string, TailscaleServeCatalog>();
  private readonly inflight = new Map<string, Promise<TailscaleServeCatalog>>();
  private readonly runServeStatus?: ServeStatusRunner;
  private readonly resolveHostBase?: (hostId: string) => string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: HostServeCatalogOptions = {}) {
    this.runServeStatus = opts.runServeStatus;
    this.resolveHostBase = opts.resolveHostBase;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
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
    if (!cat || age > this.ttlMs) {
      void this.refresh(hostId);
    }
    return preferredPublicUrlForLocalPorts(cat, localPorts);
  }

  async refresh(hostId: string): Promise<TailscaleServeCatalog> {
    const existing = this.inflight.get(hostId);
    if (existing) return existing;

    const job = this.load(hostId).finally(() => {
      this.inflight.delete(hostId);
    });
    this.inflight.set(hostId, job);
    return job;
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
