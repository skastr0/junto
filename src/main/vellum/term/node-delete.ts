import { randomBytes } from "node:crypto";
import type {
  TerminalBeginNodeDeleteResult,
  TerminalFinishNodeDeleteOutcome,
  TerminalFinishNodeDeleteResult,
  TerminalNodeDeleteResource,
} from "@shared/ipc";
import type { TerminalRouter } from "./router";

const LEASE_TTL_MS = 60_000;
const MAX_BINDING_BYTES = 512;
const MAX_HOST_BYTES = 512;

type ResourceKey = Readonly<{
  bindingId: string;
  hostId: string;
  key: string;
}>;

type ActiveLease = {
  readonly id: string;
  readonly resources: readonly ResourceKey[];
  expiresAt: number;
};

export type TerminalCreateAdmission = Readonly<{
  key: string;
  revision: number;
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
    }

    const id = `tdl-${randomBytes(12).toString("hex")}`;
    const lease: ActiveLease = {
      id,
      resources: Object.freeze(resources),
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
            clean: await this.router.deleteBinding(
              resource.bindingId,
              resource.hostId,
            ),
          } as const;
        } catch (error) {
          return { resource, clean: false as const, error };
        }
      }));
      const failed = outcomes.find((outcome) => !outcome.clean);
      if (failed !== undefined) {
        throw new Error(
          `terminal ${failed.resource.bindingId} did not produce an exact clean teardown receipt`,
        );
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
      : "local";
    const hostId = this.router.isLocalHostId(requestedHost)
      ? "local"
      : requestedHost;
    return Object.freeze({
      bindingId,
      hostId,
      key: JSON.stringify([hostId, bindingId]),
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

  private message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  }
}
