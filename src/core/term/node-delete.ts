import { randomBytes } from "node:crypto";
import type {
  TerminalBeginNodeDeleteResult,
  TerminalFinishNodeDeleteOutcome,
  TerminalFinishNodeDeleteResult,
  TerminalNodeDeleteResource,
} from "@shared/ipc";
import type { TerminalRouter } from "./router";
import { scrubMessage } from "../../node/credentials/scrub";

const LEASE_TTL_MS = 60_000;
const MAX_BINDING_BYTES = 512;
const MAX_HOST_BYTES = 512;

type ResourceKey = Readonly<{
  bindingId: string;
  hostId: string;
  key: string;
  /** The operator confirmed this remote binding's delete while its stop was unproven. */
  confirmedUnreachable?: true;
}>;

type ActiveLease = {
  readonly id: string;
  readonly resources: readonly ResourceKey[];
  /**
   * Remote stops admitted on the operator's confirm: the owed finish, a
   * stored fact settled when the seat's machine next installs a copy
   * without the node. Never marked stopped; history is kept.
   */
  readonly owed: Array<{
    bindingId: string;
    hostId: string;
    reason: "refused" | "epoch-changed" | "unreachable" | "timeout";
  }>;
  expiresAt: number;
};

export type TerminalCreateAdmission = Readonly<{
  key: string;
  revision: number;
}>;

/** A delete stop this machine holds until the next installed copy decides. */
export type HeldDelete = Readonly<{
  key: string;
  bindingId: string;
  hostId: string;
  canvas: string;
  seatId: string;
}>;

const safeField = (value: unknown, label: string, maxBytes: number): string => {
  if (typeof value !== "string") throw new Error(`${label} required`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
};

/**
 * Main-owned exact terminal fence for node deletion.
 *
 * A create captures a key revision before any IPC await and must revalidate it
 * immediately before router dispatch. Beginning deletion increments that
 * revision and locks the key synchronously, so an older in-flight create can
 * neither appear after teardown nor cross the document commit.
 */
export class TerminalNodeDeleteService {
  private readonly locks = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly leases = new Map<string, ActiveLease>();
  /** Delete stops taken on this machine, keyed like locks but owned by no lease: they never expire on their own. */
  private readonly heldDeletes = new Map<string, HeldDelete>();

  constructor(private readonly router: TerminalRouter) {}

  admitCreate(bindingId: unknown, hostId: unknown): TerminalCreateAdmission {
    this.gcExpired();
    const resource = this.resource({
      bindingId: safeField(bindingId, "bindingId", MAX_BINDING_BYTES),
      ...(typeof hostId === "string" ? { hostId } : {}),
    });
    if (this.locks.has(resource.key)) {
      throw new Error("terminal node deletion is in progress");
    }
    return Object.freeze({
      key: resource.key,
      revision: this.revisions.get(resource.key) ?? 0,
    });
  }

  assertCreate(admission: TerminalCreateAdmission): void {
    this.gcExpired();
    if (
      this.locks.has(admission.key) ||
      (this.revisions.get(admission.key) ?? 0) !== admission.revision
    ) {
      throw new Error("terminal create was revoked by node deletion");
    }
  }

  /**
   * A delete stop arriving over the seats channel: the binding's create lock
   * is taken now and held until the next installed copy of its canvas decides.
   * The lock rides the same key space as a delete lease, so admitCreate and
   * assertCreate refuse creates exactly as they do mid-delete; unlike a lease
   * it has no expiry, because the copy that decides may be hours away.
   */
  holdDelete(
    bindingId: unknown,
    hostId: unknown,
    where: { readonly canvas: string; readonly seatId: string },
  ): HeldDelete {
    this.gcExpired();
    const resource = this.resource({
      bindingId: safeField(bindingId, "bindingId", MAX_BINDING_BYTES),
      ...(typeof hostId === "string" ? { hostId } : {}),
    });
    this.revisions.set(resource.key, (this.revisions.get(resource.key) ?? 0) + 1);
    const held: HeldDelete = Object.freeze({
      key: resource.key,
      bindingId: resource.bindingId,
      hostId: resource.hostId,
      canvas: safeField(where.canvas, "canvas", MAX_HOST_BYTES),
      seatId: safeField(where.seatId, "seatId", MAX_HOST_BYTES),
    });
    this.heldDeletes.set(resource.key, held);
    this.locks.set(resource.key, "held-delete");
    return held;
  }

  /** The copy of `canvas` installed: every held delete on it is decided by the caller. */
  heldDeletesFor(canvas: string): readonly HeldDelete[] {
    this.gcExpired();
    return [...this.heldDeletes.values()].filter((held) => held.canvas === canvas);
  }

  /** Release one held delete once its canvas's copy has decided. */
  releaseHeldDelete(key: string): void {
    const held = this.heldDeletes.get(key);
    if (held === undefined) return;
    this.heldDeletes.delete(key);
    if (this.locks.get(key) === "held-delete") this.locks.delete(key);
  }

  async beginNodeDelete(
    input: ReadonlyArray<TerminalNodeDeleteResource>,
  ): Promise<TerminalBeginNodeDeleteResult> {
    this.gcExpired();
    let resources: ResourceKey[];
    try {
      const unique = new Map<string, ResourceKey>();
      for (const candidate of input) {
        const resource = this.resource(candidate);
        unique.set(resource.key, resource);
      }
      resources = [...unique.values()];
    } catch (error) {
      return { ok: false, error: this.message(error) };
    }
    if (resources.length === 0) {
      return { ok: false, error: "no terminal resources to delete" };
    }
    for (const resource of resources) {
      if (this.locks.has(resource.key)) {
        return {
          ok: false,
          error: `terminal ${resource.bindingId} already has an active delete lease`,
        };
      }
      // The confirm marker exists only for a host that is not this machine;
      // a local binding stays clean or refused, nothing else.
      if (
        resource.confirmedUnreachable === true &&
        this.router.isLocalHostId(resource.hostId)
      ) {
        return {
          ok: false,
          error: `terminal ${resource.bindingId} is on this machine; an unreachable confirm does not apply`,
        };
      }
    }

    const id = `tdl-${randomBytes(12).toString("hex")}`;
    const lease: ActiveLease = {
      id,
      resources: Object.freeze(resources),
      owed: [],
      expiresAt: Date.now() + LEASE_TTL_MS,
    };
    this.leases.set(id, lease);
    for (const resource of resources) {
      this.revisions.set(
        resource.key,
        (this.revisions.get(resource.key) ?? 0) + 1,
      );
      this.locks.set(resource.key, id);
    }

    try {
      // Keep every key locked until every exact teardown settles. A fast Remote
      // refusal must not release a sibling local key while its owned receipt is
      // still pending.
      const outcomes = await Promise.all(resources.map(async (resource) => {
        try {
          return {
            resource,
            receipt: await this.router.deleteBinding(
              resource.bindingId,
              resource.hostId,
            ),
          } as const;
        } catch {
          return { resource, receipt: { kind: "refused" } as const };
        }
      }));
      const unstoppedRemote: Array<{
        bindingId: string;
        hostId: string;
        reason: "refused" | "epoch-changed" | "unreachable" | "timeout";
      }> = [];
      const failedLocal: Array<{ bindingId: string; hostId: string }> = [];
      for (const { resource, receipt } of outcomes) {
        if (receipt.kind === "clean") continue;
        const reason = receipt.kind === "unproven" ? receipt.reason : "refused";
        if (resource.confirmedUnreachable === true) {
          // The operator confirmed this delete while the stop was unproven:
          // admitted, and the finish it is owed is a stored fact.
          lease.owed.push({
            bindingId: resource.bindingId,
            hostId: resource.hostId,
            reason,
          });
        } else if (this.router.isLocalHostId(resource.hostId)) {
          failedLocal.push({
            bindingId: resource.bindingId,
            hostId: resource.hostId,
          });
        } else {
          unstoppedRemote.push({
            bindingId: resource.bindingId,
            hostId: resource.hostId,
            reason,
          });
        }
      }
      if (failedLocal.length > 0 || unstoppedRemote.length > 0) {
        this.release(id);
        return {
          ok: false,
          error: failedLocal.length > 0
            ? `terminal ${failedLocal[0].bindingId} did not produce an exact clean teardown receipt`
            : `terminal ${unstoppedRemote[0].bindingId} stop could not be proven`,
          ...(unstoppedRemote.length > 0
            ? { unstoppedRemote: Object.freeze(unstoppedRemote) }
            : {}),
          ...(failedLocal.length > 0
            ? { failedLocal: Object.freeze(failedLocal) }
            : {}),
        };
      }
      const closeResults = outcomes.map(({ resource }) => Object.freeze({
        bindingId: resource.bindingId,
        hostId: resource.hostId,
        clean: true as const,
      }));
      const live = this.leases.get(id);
      if (live !== undefined) live.expiresAt = Date.now() + LEASE_TTL_MS;
      return {
        ok: true,
        leaseId: id,
        closeResults: Object.freeze(closeResults),
      };
    } catch (error) {
      this.release(id);
      return { ok: false, error: this.message(error) };
    }
  }

  finishNodeDelete(
    leaseId: string,
    _outcome: TerminalFinishNodeDeleteOutcome,
  ): TerminalFinishNodeDeleteResult {
    this.gcExpired();
    const id = leaseId.trim();
    if (id.length === 0) return { ok: false, error: "invalid lease id" };
    if (!this.leases.has(id)) return { ok: true };
    this.release(id);
    return { ok: true };
  }

  isLocked(bindingId: string, hostId?: string): boolean {
    this.gcExpired();
    try {
      return this.locks.has(this.resource({ bindingId, hostId }).key);
    } catch {
      return true;
    }
  }

  private resource(input: TerminalNodeDeleteResource): ResourceKey {
    const bindingId = safeField(
      input.bindingId,
      "bindingId",
      MAX_BINDING_BYTES,
    );
    const requestedHost = typeof input.hostId === "string" && input.hostId.trim()
      ? safeField(input.hostId, "hostId", MAX_HOST_BYTES)
      : this.router.thisMachineName();
    const hostId = requestedHost;
    return Object.freeze({
      bindingId,
      hostId,
      key: JSON.stringify([hostId, bindingId]),
      ...(input.confirmedUnreachable === true
        ? { confirmedUnreachable: true as const }
        : {}),
    });
  }

  private release(id: string): void {
    const lease = this.leases.get(id);
    if (lease === undefined) return;
    for (const resource of lease.resources) {
      if (this.locks.get(resource.key) === id) this.locks.delete(resource.key);
    }
    this.leases.delete(id);
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [id, lease] of [...this.leases]) {
      if (now >= lease.expiresAt) this.release(id);
    }
  }

  /** A thrown error as the deleting seat reads it: scrubbed, one line, at most 1 KiB. */
  private message(error: unknown): string {
    return scrubMessage(error instanceof Error ? error.message : String(error)) || "terminal delete failed";
  }
}
