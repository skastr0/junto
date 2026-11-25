import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { coreRunner } from "../core-runner";
import type {
  TerminalBeginNodeDeleteResult,
  TerminalFinishNodeDeleteOutcome,
  TerminalFinishNodeDeleteResult,
  TerminalNodeDeleteResource,
} from "@shared/ipc";
import type { TerminalRouter } from "./router";
import type { DeleteBindingUnprovenReason } from "@shared/terminal-delete";
import {
  makeMemoryTerminalNodeDeleteStore,
  type TerminalNodeDeleteStore,
} from "./node-delete-store";
import { scrubMessage } from "../../node/credentials/scrub";

/** The editor-side delete lease. The seat machine reads it as the dead-editor timing bound, never as a fence of its own. */
export const DELETE_LEASE_TTL_MS = 60_000;
const LEASE_TTL_MS = DELETE_LEASE_TTL_MS;
const MAX_BINDING_BYTES = 512;
const MAX_HOST_BYTES = 512;
const MAX_CANVAS_BYTES = 256;

type ResourceKey = Readonly<{
  bindingId: string;
  hostId: string;
  key: string;
  canvas?: string;
  seatId?: string;
  canvasSeq?: number;
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
    reason: DeleteBindingUnprovenReason;
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
  editorInstallationId: string;
  editorCanvasSeq: number;
  createdAt: number;
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

const safeSeq = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid canvasSeq");
  }
  return value;
};

/**
 * Main-owned exact terminal fence for node deletion.
 *
 * A create captures a key revision before any IPC await and must revalidate it
 * immediately before router dispatch. Beginning deletion increments that
 * revision and locks the key synchronously, so an older in-flight create can
 * neither appear after teardown nor cross the document commit.
 *
 * A remote delete hold is durable before it is a lock: the row write finishes,
 * then the in-memory fence is taken, then the seat is stopped and answered.
 * Rows are loaded before the terminal plane opens any path that can admit a
 * create, so a core restart cannot reopen the delete window.
 */
export class TerminalNodeDeleteService {
  private readonly locks = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly leases = new Map<string, ActiveLease>();
  /** Delete stops taken on this machine, keyed like locks but owned by no lease: they never expire on their own. */
  private readonly heldDeletes = new Map<string, HeldDelete>();
  /** A hold being written. It is not the durable lock yet, but it already fences creates so the row-first order leaves no gap. */
  private readonly pendingHolds = new Set<string>();

  private store: TerminalNodeDeleteStore;

  constructor(
    private readonly router: TerminalRouter,
    store: TerminalNodeDeleteStore = makeMemoryTerminalNodeDeleteStore(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.store = store;
  }

  /** Test seam: a unit rig without the core's SQL service swaps the durable store. */
  useStoreForTest(store: TerminalNodeDeleteStore): void {
    this.store = store;
  }

  admitCreate(bindingId: unknown, hostId: unknown): TerminalCreateAdmission {
    this.gcExpired();
    const resource = this.resource({
      bindingId: safeField(bindingId, "bindingId", MAX_BINDING_BYTES),
      ...(typeof hostId === "string" ? { hostId } : {}),
    });
    if (this.createLocked(resource.key)) {
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
      this.createLocked(admission.key) ||
      (this.revisions.get(admission.key) ?? 0) !== admission.revision
    ) {
      throw new Error("terminal create was revoked by node deletion");
    }
  }

  /** Load durable holds before the plane opens any create path. Idempotent; the higher seq wins. */
  async loadHeldDeletes(): Promise<void> {
    const rows = await this.store.loadHeld();
    for (const row of rows) {
      const resource = this.resource({ bindingId: row.bindingId, hostId: this.router.thisMachineName() });
      const current = this.heldDeletes.get(resource.key);
      if (current !== undefined && current.editorCanvasSeq >= row.editorCanvasSeq) continue;
      const held = this.heldOf(resource, row);
      this.revisions.set(resource.key, (this.revisions.get(resource.key) ?? 0) + 1);
      this.heldDeletes.set(resource.key, held);
      this.locks.set(resource.key, "held-delete");
    }
  }

  /**
   * A delete stop arriving over the seats channel: the binding's create lock
   * is taken after its row is durable and held until the next installed copy
   * of its canvas decides. A retry keeps the larger seq; a replayed older Stop
   * never lowers it.
   */
  async holdDelete(
    bindingId: unknown,
    hostId: unknown,
    where: {
      readonly canvas: string;
      readonly seatId: string;
      readonly editorInstallationId: string;
      readonly editorCanvasSeq: number;
    },
  ): Promise<HeldDelete> {
    this.gcExpired();
    const resource = this.resource({
      bindingId: safeField(bindingId, "bindingId", MAX_BINDING_BYTES),
      ...(typeof hostId === "string" ? { hostId } : {}),
    });
    const row = Object.freeze({
      bindingId: resource.bindingId,
      canvasName: safeField(where.canvas, "canvas", MAX_CANVAS_BYTES),
      seatId: safeField(where.seatId, "seatId", MAX_CANVAS_BYTES),
      editorInstallationId: safeField(where.editorInstallationId, "editorInstallationId", MAX_CANVAS_BYTES),
      editorCanvasSeq: safeSeq(where.editorCanvasSeq),
      createdAt: this.now(),
    });
    this.pendingHolds.add(resource.key);
    try {
      const stored = await this.store.hold(row);
      const held = this.heldOf(resource, stored);
      this.revisions.set(resource.key, (this.revisions.get(resource.key) ?? 0) + 1);
      this.heldDeletes.set(resource.key, held);
      this.locks.set(resource.key, "held-delete");
      return held;
    } finally {
      this.pendingHolds.delete(resource.key);
    }
  }

  /** The copy of `canvas` installed: every held delete on it is decided by the caller. */
  heldDeletesFor(canvas: string): readonly HeldDelete[] {
    this.gcExpired();
    return [...this.heldDeletes.values()].filter((held) => held.canvas === canvas);
  }

  /** One held delete by its create-fence key. */
  heldDelete(key: string): HeldDelete | undefined {
    this.gcExpired();
    return this.heldDeletes.get(key);
  }

  /** One held delete by the binding identity callers already hold. */
  heldDeleteFor(bindingId: string, hostId: string): HeldDelete | undefined {
    try {
      return this.heldDelete(this.resource({ bindingId, hostId }).key);
    } catch {
      return undefined;
    }
  }

  /** Exact release by binding identity, for the seats channel's release request. */
  async releaseHeldDeleteFor(
    bindingId: string,
    hostId: string,
    expected: {
      readonly canvas: string;
      readonly seatId: string;
      readonly editorInstallationId: string;
      readonly editorCanvasSeq: number;
    },
  ): Promise<boolean> {
    return this.releaseHeldDelete(this.resource({ bindingId, hostId }).key, expected);
  }

  /**
   * Release one held delete. With `expected`, canvas, seat, editor and seq all
   * match exactly; a late release from an older attempt cannot free a retry's
   * hold. The durable row is deleted before the in-memory fence opens.
   */
  async releaseHeldDelete(
    key: string,
    expected?: {
      readonly canvas: string;
      readonly seatId: string;
      readonly editorInstallationId: string;
      readonly editorCanvasSeq: number;
    },
  ): Promise<boolean> {
    const held = this.heldDeletes.get(key);
    if (held === undefined) return false;
    if (
      expected !== undefined &&
      (held.canvas !== expected.canvas ||
        held.seatId !== expected.seatId ||
        held.editorInstallationId !== expected.editorInstallationId ||
        held.editorCanvasSeq !== expected.editorCanvasSeq)
    ) return false;
    await this.store.releaseHeld({
      bindingId: held.bindingId,
      canvasName: held.canvas,
      seatId: held.seatId,
      editorInstallationId: held.editorInstallationId,
      editorCanvasSeq: held.editorCanvasSeq,
      createdAt: held.createdAt,
    });
    this.heldDeletes.delete(key);
    if (this.locks.get(key) === "held-delete") this.locks.delete(key);
    return true;
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
      if (this.createLocked(resource.key)) {
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
      if (!this.router.isLocalHostId(resource.hostId)) {
        if (resource.canvas === undefined || resource.seatId === undefined || resource.canvasSeq === undefined) {
          return {
            ok: false,
            error: `terminal ${resource.bindingId} delete does not carry its canvas position and seq`,
          };
        }
      }
    }

    const id = `tdl-${randomBytes(12).toString("hex")}`;
    const lease: ActiveLease = {
      id,
      resources: Object.freeze(resources),
      owed: [],
      expiresAt: this.now() + LEASE_TTL_MS,
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
              resource.canvasSeq,
            ),
          } as const;
        } catch {
          return { resource, receipt: { kind: "refused" } as const };
        }
      }));
      const unstoppedRemote: Array<{
        bindingId: string;
        hostId: string;
        reason: DeleteBindingUnprovenReason;
      }> = [];
      const failedLocal: Array<{ bindingId: string; hostId: string }> = [];
      for (const { resource, receipt } of outcomes) {
        if (receipt.kind === "clean") continue;
        const reason = receipt.kind === "unproven" ? receipt.reason : "refused";
        await this.logLine("terminal delete refused", {
          seat: resource.seatId ?? resource.bindingId,
          canvas: resource.canvas ?? "",
          machine: resource.hostId ?? "",
          reason,
          ...(resource.canvasSeq === undefined ? {} : { seq: resource.canvasSeq }),
        });
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
        await this.abortRemoteHolds(id);
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
      if (lease.owed.length > 0) {
        const at = this.now();
        for (const owed of lease.owed) {
          const resource = resources.find((candidate) =>
            candidate.bindingId === owed.bindingId && candidate.hostId === owed.hostId);
          await this.logLine("terminal delete held", {
            seat: resource?.seatId ?? owed.bindingId,
            canvas: resource?.canvas ?? "",
            machine: owed.hostId,
            reason: owed.reason,
            ...(resource?.canvasSeq === undefined ? {} : { seq: resource.canvasSeq }),
          });
        }
        try {
          await this.store.writeOwed(lease.owed.flatMap((owed) => {
            const resource = resources.find((candidate) =>
              candidate.bindingId === owed.bindingId && candidate.hostId === owed.hostId);
            if (resource?.canvas === undefined || resource.seatId === undefined) return [];
            return [{
              leaseId: id,
              bindingId: owed.bindingId,
              machineName: owed.hostId,
              canvasName: resource.canvas,
              seatId: resource.seatId,
              reason: owed.reason,
              createdAt: at,
            }];
          }));
        } catch (error) {
          await this.abortRemoteHolds(id);
          this.release(id);
          return { ok: false, error: this.message(error) };
        }
      }
      const closeResults = outcomes.map(({ resource }) => Object.freeze({
        bindingId: resource.bindingId,
        hostId: resource.hostId,
        clean: true as const,
      }));
      const live = this.leases.get(id);
      if (live !== undefined) live.expiresAt = this.now() + LEASE_TTL_MS;
      return {
        ok: true,
        leaseId: id,
        closeResults: Object.freeze(closeResults),
      };
    } catch (error) {
      await this.abortRemoteHolds(id);
      this.release(id);
      return { ok: false, error: this.message(error) };
    }
  }

  async finishNodeDelete(
    leaseId: string,
    outcome: TerminalFinishNodeDeleteOutcome,
  ): Promise<TerminalFinishNodeDeleteResult> {
    this.gcExpired();
    const id = leaseId.trim();
    if (id.length === 0) return { ok: false, error: "invalid lease id" };
    const lease = this.leases.get(id);
    if (lease === undefined) return { ok: true };
    // The in-memory fence opens synchronously with the finish call: the
    // document's decision is what frees creates, never the trailing IO — the
    // durable owed rows and the seats-channel releases settle after.
    this.release(id);
    if (outcome === "aborted") {
      await this.abortRemoteHoldsOf(lease);
      await this.store.dropOwedLease(id).catch(() => undefined);
    }
    return { ok: true };
  }

  isLocked(bindingId: string, hostId?: string): boolean {
    this.gcExpired();
    try {
      return this.createLocked(this.resource({ bindingId, hostId }).key);
    } catch {
      return true;
    }
  }

  private heldOf(
    resource: ResourceKey,
    row: {
      readonly canvasName: string;
      readonly seatId: string;
      readonly editorInstallationId: string;
      readonly editorCanvasSeq: number;
      readonly createdAt: number;
    },
  ): HeldDelete {
    return Object.freeze({
      key: resource.key,
      bindingId: resource.bindingId,
      hostId: resource.hostId,
      canvas: row.canvasName,
      seatId: row.seatId,
      editorInstallationId: row.editorInstallationId,
      editorCanvasSeq: row.editorCanvasSeq,
      createdAt: row.createdAt,
    });
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
      ...(typeof input.canvas === "string" ? { canvas: safeField(input.canvas, "canvas", MAX_CANVAS_BYTES) } : {}),
      ...(typeof input.seatId === "string" ? { seatId: safeField(input.seatId, "seatId", MAX_CANVAS_BYTES) } : {}),
      ...(input.canvasSeq !== undefined ? { canvasSeq: safeSeq(input.canvasSeq) } : {}),
      ...(input.confirmedUnreachable === true
        ? { confirmedUnreachable: true as const }
        : {}),
    });
  }

  private createLocked(key: string): boolean {
    return this.locks.has(key) || this.pendingHolds.has(key);
  }

  /**
   * Best-effort abort notice for every remote Stop that may have landed. A
   * machine that cannot be reached keeps its durable hold until its copy or
   * the dead-editor timing rule decides; the attempt itself never rethrows.
   */
  private async abortRemoteHolds(id: string): Promise<void> {
    const lease = this.leases.get(id);
    if (lease === undefined) return;
    await this.abortRemoteHoldsOf(lease);
  }

  private async abortRemoteHoldsOf(lease: ActiveLease): Promise<void> {
    await Promise.all(lease.resources.map(async (resource) => {
      if (this.router.isLocalHostId(resource.hostId) || resource.canvasSeq === undefined) return;
      let released = false;
      try {
        released = await this.router.releaseDeletedBinding(resource.bindingId, resource.hostId, resource.canvasSeq);
      } catch {
        // Best effort: a machine that cannot be reached keeps its durable
        // hold until its copy or the dead-editor timing rule decides.
      }
      await this.logLine("terminal delete release", {
        seat: resource.seatId ?? resource.bindingId,
        canvas: resource.canvas ?? "",
        machine: resource.hostId ?? "",
        reason: "aborted",
        seq: resource.canvasSeq,
        released,
      });
    }));
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
    const now = this.now();
    for (const [id, lease] of [...this.leases]) {
      if (now >= lease.expiresAt) this.release(id);
    }
  }

  /**
   * One log line for one delete decision, through the core's own runtime so
   * the row lands in core.jsonl. Best effort only: logging never breaks a
   * delete flow, and a test without a core running logs nothing.
   */
  private logLine(message: string, annotations: Record<string, string | number | boolean>): Promise<void> {
    return coreRunner.runPromise(
      (Effect.logInfo(message) as Effect.Effect<void, never, never>).pipe(Effect.annotateLogs(annotations)),
    ).then(() => undefined, () => undefined);
  }

  /** A thrown error as the deleting seat reads it: scrubbed, one line, at most 1 KiB. */
  private message(error: unknown): string {
    return scrubMessage(error instanceof Error ? error.message : String(error)) || "terminal delete failed";
  }
}
