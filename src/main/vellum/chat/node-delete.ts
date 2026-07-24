/**
 * Main-owned delete lease for agent-node deletion (Cut 6).
 *
 * Replaces renderer-driven key-only admit/release tombstones with a single
 * lease that: locks agent keys, admits chatOpen tombstones, starts verified
 * close, and releases only on finish(committed|aborted) or TTL.
 *
 * Residual: unclean close ledger remains key-scoped on ChatService (sticky
 * until clean open), not generation-keyed. Lease fence is generation-safe for
 * the delete path via tombstone + lock; uncleanCloses generation ledger is
 * deferred hardening.
 */

import type { ChatService } from "./service";

export type NodeDeleteResource = {
  readonly kind: "agent";
  readonly agentKey: string;
};

export type NodeDeleteCloseResult = {
  readonly agentKey: string;
  readonly ok: boolean;
  readonly clean: boolean;
};

export type BeginNodeDeleteResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly closeResults: ReadonlyArray<NodeDeleteCloseResult>;
    }
  | { readonly ok: false; readonly error: string };

export type FinishNodeDeleteOutcome = "committed" | "aborted";

export type FinishNodeDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

interface ActiveLease {
  readonly leaseId: string;
  readonly agentKeys: ReadonlyArray<string>;
  expiresAt: number;
}

const LEASE_TTL_MS = 60_000;

const uniqueAgentKeys = (
  resources: ReadonlyArray<NodeDeleteResource>,
): string[] => {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "agent") continue;
    const key = resource.agentKey.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
};

export class NodeDeleteService {
  private readonly leases = new Map<string, ActiveLease>();
  /** agentKey → leaseId holding the exclusive delete lock */
  private readonly locks = new Map<string, string>();
  private seq = 0;

  constructor(private readonly chat: ChatService) {}

  /**
   * Mint a delete lease: lock keys, admit tombstones, await chatClose.
   * Caller must finish(committed|aborted) after document commit or abort.
   */
  async beginNodeDelete(
    resources: ReadonlyArray<NodeDeleteResource>,
  ): Promise<BeginNodeDeleteResult> {
    this.gcExpired();
    const agentKeys = uniqueAgentKeys(resources);
    if (agentKeys.length === 0) {
      return { ok: false, error: "no agent resources to delete" };
    }

    for (const key of agentKeys) {
      const holder = this.locks.get(key);
      if (holder !== undefined) {
        return {
          ok: false,
          error: `agent ${key} already has an active delete lease`,
        };
      }
    }

    const admitted: string[] = [];
    for (const key of agentKeys) {
      const result = this.chat.admitDeleteTombstone(key);
      if (!result.ok) {
        for (const prior of admitted) this.chat.releaseDeleteTombstone(prior);
        return { ok: false, error: result.error };
      }
      admitted.push(key);
    }

    const leaseId = `ndl-${++this.seq}-${Date.now().toString(36)}`;
    const lease: ActiveLease = {
      leaseId,
      agentKeys: admitted,
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
    this.leases.set(leaseId, lease);
    for (const key of admitted) this.locks.set(key, leaseId);

    try {
      const closeResults = await Promise.all(
        admitted.map(async (agentKey): Promise<NodeDeleteCloseResult> => {
          const result = await this.chat.chatClose(agentKey);
          return {
            agentKey,
            ok: result.ok,
            clean: result.clean,
          };
        }),
      );
      // Refresh TTL after close so long teardowns don't expire mid-commit.
      const live = this.leases.get(leaseId);
      if (live !== undefined) {
        live.expiresAt = Date.now() + LEASE_TTL_MS;
      }
      return { ok: true, leaseId, closeResults };
    } catch (error) {
      this.releaseLease(leaseId);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Release locks and tombstones. Both outcomes free the fence; outcome is
   * retained for callers/audit (document committed vs aborted).
   */
  finishNodeDelete(
    leaseId: string,
    _outcome: FinishNodeDeleteOutcome,
  ): FinishNodeDeleteResult {
    this.gcExpired();
    const id = leaseId.trim();
    if (id.length === 0) return { ok: false, error: "invalid lease id" };
    // Idempotent: unknown/expired lease is a no-op success (TTL may have run).
    if (!this.leases.has(id)) return { ok: true };
    this.releaseLease(id);
    return { ok: true };
  }

  /** Test seam: whether an agent key is locked by an active lease. */
  isLocked(agentKey: string): boolean {
    this.gcExpired();
    return this.locks.has(agentKey.trim());
  }

  /** Test seam: active lease count after GC. */
  activeLeaseCount(): number {
    this.gcExpired();
    return this.leases.size;
  }

  private releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return;
    for (const key of lease.agentKeys) {
      this.chat.releaseDeleteTombstone(key);
      if (this.locks.get(key) === leaseId) this.locks.delete(key);
    }
    this.leases.delete(leaseId);
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [id, lease] of [...this.leases]) {
      if (now >= lease.expiresAt) this.releaseLease(id);
    }
  }
}
