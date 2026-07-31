/**
 * TTL cache for `tailscale status --json` → mesh host for remote service URLs.
 * Failure is soft: returns undefined so HostServiceMap falls back to SSH endpoint.
 */

import { runCli, type CliResult } from "../adapters/exec";
import { findHostById } from "./snapshot";
import {
  parseTailscaleStatusJson,
  resolveTailscaleHostForQuery,
  type TailscaleStatusSnapshot,
} from "@shared/tailscale-peers";

export type TailscaleStatusRunner = () => Promise<CliResult>;

const DEFAULT_TTL_MS = 5 * 60_000;

export interface TailscalePeerCacheOptions {
  readonly runStatus?: TailscaleStatusRunner;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class TailscalePeerCache {
  private snapshot: TailscaleStatusSnapshot | undefined;
  private fetchedAt = 0;
  private inflight: Promise<TailscaleStatusSnapshot | undefined> | undefined;
  private readonly runStatus: TailscaleStatusRunner;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: TailscalePeerCacheOptions = {}) {
    this.runStatus =
      opts.runStatus ??
      (() => runCli("tailscale", ["status", "--json"], 6_000));
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Sync peek of last good snapshot (may be stale). */
  peek(): TailscaleStatusSnapshot | undefined {
    return this.snapshot;
  }

  /**
   * Resolve MagicDNS/IPv4 for a Vellum Command host id. Uses cache when fresh;
   * refreshes in background when stale (returns last good immediately).
   */
  resolveHost(hostId: string): string | undefined {
    if (hostId === "local") return undefined;
    const host = findHostById(hostId);
    const sshEndpoint = host?.kind === "remote" ? host.sshEndpoint : undefined;
    const query = { hostId, sshEndpoint };

    const age = this.now() - this.fetchedAt;
    if (this.snapshot && age < this.ttlMs) {
      return resolveTailscaleHostForQuery(query, this.snapshot);
    }

    // Stale or empty: kick refresh; return last-known match if any.
    void this.refresh();
    if (this.snapshot) {
      return resolveTailscaleHostForQuery(query, this.snapshot);
    }
    return undefined;
  }

  /** Force refresh (tests / doctor). */
  async refresh(): Promise<TailscaleStatusSnapshot | undefined> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load()
      .then((snap) => {
        if (snap) {
          this.snapshot = snap;
          this.fetchedAt = this.now();
        }
        return snap;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async load(): Promise<TailscaleStatusSnapshot | undefined> {
    try {
      const result = await this.runStatus();
      if (!result.ok || !result.stdout.trim()) return undefined;
      const parsed = JSON.parse(result.stdout) as unknown;
      return parseTailscaleStatusJson(parsed);
    } catch {
      return undefined;
    }
  }
}

/** Process-wide cache shared by HerdrPlane service map. */
export const tailscalePeerCache = new TailscalePeerCache();
