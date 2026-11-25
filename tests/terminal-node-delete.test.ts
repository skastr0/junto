import { describe, expect, it, vi } from "vitest";
import { Effect, Logger, References } from "effect";
import { installCoreRunner } from "../src/core/core-runner";
import { TerminalNodeDeleteService } from "../src/core/term/node-delete";
import type { DeleteBindingReceipt, TerminalRouter } from "../src/core/term/router";

const makeRouter = (
  deleteBinding: (bindingId: string, hostId?: string, deleteSeq?: number) => Promise<DeleteBindingReceipt>,
): { router: TerminalRouter; releaseDeletedBinding: ReturnType<typeof vi.fn> } => {
  const releaseDeletedBinding = vi.fn(async () => true);
  const router = {
    thisMachineName: () => "workbench",
    isLocalHostId: (hostId: string | undefined | null) =>
      hostId === undefined || hostId === null || hostId.trim() === "" ||
      hostId === "workbench",
    deleteBinding,
    releaseDeletedBinding,
  } as unknown as TerminalRouter;
  return { router, releaseDeletedBinding };
};

const remoteResource = {
  bindingId: "remote-seat",
  hostId: "mac-mini",
  canvas: "factory",
  seatId: "seat-a",
  canvasSeq: 3,
} as const;

describe("terminal node-delete fence", () => {
  it("invalidates an older in-flight create before awaiting exact teardown", async () => {
    let finishStop!: (receipt: DeleteBindingReceipt) => void;
    const deleteBinding = vi.fn(
      () => new Promise<DeleteBindingReceipt>((resolve) => {
        finishStop = resolve;
      }),
    );
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);
    const admittedBeforeDelete = service.admitCreate("binding-a", "workbench");

    const begin = service.beginNodeDelete([
      { bindingId: "binding-a", hostId: "workbench" },
    ]);

    expect(service.isLocked("binding-a", "workbench")).toBe(true);
    expect(() => service.assertCreate(admittedBeforeDelete)).toThrow(
      /revoked by node deletion/u,
    );
    expect(() => service.admitCreate("binding-a", "workbench")).toThrow(
      /deletion is in progress/u,
    );
    expect(deleteBinding).toHaveBeenCalledWith("binding-a", "workbench", undefined);

    finishStop({ kind: "clean" });
    const lease = await begin;
    expect(lease).toMatchObject({ ok: true });
    if (!lease.ok) throw new Error(lease.error);
    expect(service.isLocked("binding-a", "workbench")).toBe(true);
    expect(await service.finishNodeDelete(lease.leaseId, "committed")).toEqual({
      ok: true,
    });
    expect(service.isLocked("binding-a", "workbench")).toBe(false);
    expect(() => service.assertCreate(admittedBeforeDelete)).toThrow(
      /revoked by node deletion/u,
    );
    const admittedAfterDelete = service.admitCreate("binding-a", "workbench");
    expect(() => service.assertCreate(admittedAfterDelete)).not.toThrow();
  });

  it("fails closed and releases the lease when exact cleanup is unproven", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "refused" }) as const);
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const result = await service.beginNodeDelete([
      { bindingId: "binding-dirty", hostId: "workbench" },
    ]);

    expect(result).toEqual({
      ok: false,
      error:
        "terminal binding-dirty did not produce an exact clean teardown receipt",
      failedLocal: [{ bindingId: "binding-dirty", hostId: "workbench" }],
    });
    expect(service.isLocked("binding-dirty", "workbench")).toBe(false);
    const admitted = service.admitCreate("binding-dirty", "workbench");
    expect(() => service.assertCreate(admitted)).not.toThrow();
  });

  it("retains every sibling lock until all teardown receipts settle", async () => {
    let finishSlow!: (receipt: DeleteBindingReceipt) => void;
    const deleteBinding = vi.fn((bindingId: string) =>
      bindingId === "fast-dirty"
        ? Promise.resolve({ kind: "refused" } as const)
        : new Promise<DeleteBindingReceipt>((resolve) => {
            finishSlow = resolve;
          })
    );
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const begin = service.beginNodeDelete([
      { bindingId: "fast-dirty", hostId: "workbench" },
      { bindingId: "slow-clean", hostId: "workbench" },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.isLocked("fast-dirty", "workbench")).toBe(true);
    expect(service.isLocked("slow-clean", "workbench")).toBe(true);

    finishSlow({ kind: "clean" });
    await expect(begin).resolves.toMatchObject({ ok: false });
    expect(service.isLocked("fast-dirty", "workbench")).toBe(false);
    expect(service.isLocked("slow-clean", "workbench")).toBe(false);
  });

  it("reports a remote stop unproven, then admits the confirmed re-call, keeping the canvas fields", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "unproven", reason: "unreachable" } as const));
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const first = await service.beginNodeDelete([remoteResource]);
    expect(first).toEqual({
      ok: false,
      error: "terminal remote-seat stop could not be proven",
      unstoppedRemote: [{ bindingId: "remote-seat", hostId: "mac-mini", reason: "unreachable" }],
    });
    expect(deleteBinding).toHaveBeenCalledWith("remote-seat", "mac-mini", 3);

    const second = await service.beginNodeDelete([{ ...remoteResource, confirmedUnreachable: true }]);
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error(second.error);
    expect(await service.finishNodeDelete(second.leaseId, "committed")).toEqual({ ok: true });
  });

  it("refuses a remote delete that does not carry its canvas position and seq", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "clean" }) as const);
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    for (const resource of [
      { bindingId: "remote-seat", hostId: "mac-mini" },
      { bindingId: "remote-seat", hostId: "mac-mini", canvas: "factory", seatId: "seat-a" },
      { bindingId: "remote-seat", hostId: "mac-mini", canvasSeq: 3 },
    ]) {
      const result = await service.beginNodeDelete([resource]);
      expect(result).toMatchObject({ ok: false });
      expect(deleteBinding).not.toHaveBeenCalled();
    }
  });

  it("refuses the operator's confirmed marker on a local binding", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "clean" } as const));
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const result = await service.beginNodeDelete([
      { bindingId: "local-seat", hostId: "workbench", confirmedUnreachable: true },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect(deleteBinding).not.toHaveBeenCalled();
  });

  it("deduplicates the same machine but refuses another machine's teardown receipt", async () => {
    const deleteBinding = vi.fn(async (_bindingId: string, hostId?: string) =>
      hostId === "workbench" ? ({ kind: "clean" } as const) : ({ kind: "refused" } as const)
    );
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const local = await service.beginNodeDelete([
      { bindingId: "same", hostId: "workbench" },
      { bindingId: "same", hostId: "workbench" },
    ]);
    expect(local.ok).toBe(true);
    expect(deleteBinding).toHaveBeenCalledTimes(1);
    if (local.ok) await service.finishNodeDelete(local.leaseId, "aborted");

    const remote = await service.beginNodeDelete([
      { ...remoteResource, bindingId: "same", hostId: "remote-a" },
    ]);
    expect(remote).toMatchObject({ ok: false });
    expect(deleteBinding).toHaveBeenLastCalledWith("same", "remote-a", 3);
  });

  it("an abort after a clean remote stop sends the seats-channel release with the held seq", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "clean" }) as const);
    const { router, releaseDeletedBinding } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const began = await service.beginNodeDelete([remoteResource]);
    if (!began.ok) throw new Error(began.error);
    await service.finishNodeDelete(began.leaseId, "aborted");

    expect(releaseDeletedBinding).toHaveBeenCalledWith("remote-seat", "mac-mini", 3);
  });

  it("a confirmed re-call of a mixed delete re-stops the local binding, which answers clean again", async () => {
    // Local teardown is idempotent at the router: an absent session is the
    // clean receipt (local-host deleteBinding returns true when no record is
    // left), so the re-stop of the first call's already-stopped local binding
    // never aborts the confirmed delete as failedLocal.
    const stops = new Map<string, number>();
    const deleteBinding = vi.fn(async (bindingId: string, hostId?: string) => {
      stops.set(`${hostId}\0${bindingId}`, (stops.get(`${hostId}\0${bindingId}`) ?? 0) + 1);
      if (hostId === "mac-mini") return { kind: "unproven", reason: "unreachable" } as const;
      // A local binding already stopped answers clean again, exactly as the
      // local host answers for a record that is gone.
      return { kind: "clean" } as const;
    });
    const { router, releaseDeletedBinding } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const first = await service.beginNodeDelete([
      { bindingId: "local-seat", hostId: "workbench" },
      remoteResource,
    ]);
    expect(first).toEqual({
      ok: false,
      error: "terminal remote-seat stop could not be proven",
      unstoppedRemote: [{ bindingId: "remote-seat", hostId: "mac-mini", reason: "unreachable" }],
    });
    // The local stop is not reported as a failure, and the abort release for
    // the remote hold the first stop may have taken is already stated.
    expect(first.ok ? undefined : (first as { failedLocal?: unknown }).failedLocal).toBeUndefined();
    expect(releaseDeletedBinding).toHaveBeenCalledWith("remote-seat", "mac-mini", 3);

    const second = await service.beginNodeDelete([
      { bindingId: "local-seat", hostId: "workbench" },
      { ...remoteResource, confirmedUnreachable: true },
    ]);
    expect(second).toMatchObject({ ok: true });
    expect(stops.get("workbench\0local-seat")).toBe(2);
    if (!second.ok) throw new Error(second.error);
    expect(await service.finishNodeDelete(second.leaseId, "committed")).toEqual({ ok: true });
  });

  it("a failed begin after an unproven remote stop also states the abort", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "unproven", reason: "timeout" } as const));
    const { router, releaseDeletedBinding } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const result = await service.beginNodeDelete([remoteResource]);
    expect(result).toMatchObject({ ok: false });
    expect(releaseDeletedBinding).toHaveBeenCalledWith("remote-seat", "mac-mini", 3);
  });
});

describe("terminal node-delete holds", () => {
  const where = {
    canvas: "factory",
    seatId: "seat-a",
    editorInstallationId: "editor-one",
    editorCanvasSeq: 5,
  };

  it("a hold fences creates until its exact release, and a mismatched release frees nothing", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "clean" }) as const);
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    const held = await service.holdDelete("binding-a", "workbench", where);
    expect(held.editorCanvasSeq).toBe(5);
    expect(service.isLocked("binding-a", "workbench")).toBe(true);
    expect(() => service.admitCreate("binding-a", "workbench")).toThrow(/deletion is in progress/u);

    // A late release from a first attempt does not free a retry's hold.
    expect(await service.releaseHeldDelete(held.key, { ...where, editorCanvasSeq: 4 })).toBe(false);
    expect(service.isLocked("binding-a", "workbench")).toBe(true);
    // Another editor's release never matches.
    expect(await service.releaseHeldDelete(held.key, { ...where, editorInstallationId: "editor-two" })).toBe(false);
    expect(service.isLocked("binding-a", "workbench")).toBe(true);

    expect(await service.releaseHeldDelete(held.key, where)).toBe(true);
    expect(service.isLocked("binding-a", "workbench")).toBe(false);
    // Idempotent: the hold is gone, a repeat matches nothing.
    expect(await service.releaseHeldDelete(held.key, where)).toBe(false);
  });

  it("a retry keeps the larger seq and a replayed older stop never lowers it", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "clean" }) as const);
    const { router } = makeRouter(deleteBinding);
    const service = new TerminalNodeDeleteService(router);

    await service.holdDelete("binding-a", "workbench", where);
    const retry = await service.holdDelete("binding-a", "workbench", { ...where, editorCanvasSeq: 9 });
    expect(retry.editorCanvasSeq).toBe(9);
    const replay = await service.holdDelete("binding-a", "workbench", { ...where, editorCanvasSeq: 4 });
    expect(replay.editorCanvasSeq).toBe(9);
    const held = service.heldDeleteFor("binding-a", "workbench");
    expect(held?.editorCanvasSeq).toBe(9);
  });

  it("durable holds load before the first create admission, fencing it", async () => {
    const deleteBinding = vi.fn(async () => ({ kind: "clean" }) as const);
    const { router } = makeRouter(deleteBinding);
    const { makeMemoryTerminalNodeDeleteStore } = await import("../src/core/term/node-delete-store");
    const store = makeMemoryTerminalNodeDeleteStore();
    const writer = new TerminalNodeDeleteService(router, store);
    await writer.holdDelete("binding-a", "workbench", where);

    // The restarted core: memory is empty, the row is not.
    const restarted = new TerminalNodeDeleteService(router, store);
    expect(restarted.isLocked("binding-a", "workbench")).toBe(false);
    await restarted.loadHeldDeletes();
    expect(restarted.isLocked("binding-a", "workbench")).toBe(true);
    expect(() => restarted.admitCreate("binding-a", "workbench")).toThrow(/deletion is in progress/u);
    expect(restarted.heldDeletesFor("factory")).toHaveLength(1);
    expect(restarted.heldDeletesFor("factory")[0]).toMatchObject({
      seatId: "seat-a", editorCanvasSeq: 5,
    });
  });

  describe("one log line for every refused, held or released delete", () => {
    type Row = { readonly message: string; readonly annotations: Record<string, unknown> };
    const withCapturedLogs = async (run: () => Promise<void>): Promise<Row[]> => {
      const rows: Row[] = [];
      const capture = Logger.make((entry) => {
        rows.push({
          message: Array.isArray(entry.message) ? entry.message.map(String).join(" ") : String(entry.message),
          annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
        });
      });
      const uninstall = installCoreRunner({
        runPromise: (effect) =>
          Effect.runPromise(
            Effect.withLogger(effect as Effect.Effect<unknown, unknown, never>, capture),
          ) as Promise<never>,
      });
      try {
        await run();
      } finally {
        uninstall();
      }
      return rows;
    };

    it("a refused remote stop logs its seat, machine, reason and seq, and the abort logs its release", async () => {
      const deleteBinding = vi.fn(async () => ({ kind: "unproven", reason: "unreachable" }) as const);
      const { router } = makeRouter(deleteBinding);
      const { makeMemoryTerminalNodeDeleteStore } = await import("../src/core/term/node-delete-store");
      const service = new TerminalNodeDeleteService(router, makeMemoryTerminalNodeDeleteStore());

      const rows = await withCapturedLogs(async () => {
        const result = await service.beginNodeDelete([remoteResource]);
        expect(result.ok).toBe(false);
      });

      const refused = rows.find((row) => row.message === "terminal delete refused");
      expect(refused).toBeDefined();
      expect(refused!.annotations).toMatchObject({
        seat: "seat-a", canvas: "factory", machine: "mac-mini", reason: "unreachable", seq: 3,
      });
      const release = rows.find((row) => row.message === "terminal delete release");
      expect(release).toBeDefined();
      expect(release!.annotations).toMatchObject({
        seat: "seat-a", machine: "mac-mini", reason: "aborted", seq: 3,
      });
      // Nothing paths or secrets carry: the values are names and numbers only.
      for (const row of rows) {
        for (const value of Object.values(row.annotations)) {
          expect(typeof value === "string" ? value : "").not.toMatch(/[\/]/);
        }
      }
    });

    it("a confirmed unreachable delete logs the hold it owes", async () => {
      const deleteBinding = vi.fn(async () => ({ kind: "unproven", reason: "unreachable" }) as const);
      const { router } = makeRouter(deleteBinding);
      const { makeMemoryTerminalNodeDeleteStore } = await import("../src/core/term/node-delete-store");
      const service = new TerminalNodeDeleteService(router, makeMemoryTerminalNodeDeleteStore());

      const rows = await withCapturedLogs(async () => {
        const result = await service.beginNodeDelete([{ ...remoteResource, confirmedUnreachable: true }]);
        expect(result.ok).toBe(true);
      });

      const held = rows.find((row) => row.message === "terminal delete held");
      expect(held).toBeDefined();
      expect(held!.annotations).toMatchObject({
        seat: "seat-a", canvas: "factory", machine: "mac-mini", reason: "unreachable", seq: 3,
      });
    });
  });

});

