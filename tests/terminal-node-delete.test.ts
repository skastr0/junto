import { describe, expect, it, vi } from "vitest";
import { TerminalNodeDeleteService } from "../src/main/vellum-command/term/node-delete";
import type { TerminalRouter } from "../src/main/vellum-command/term/router";

const makeRouter = (
  deleteBinding: (bindingId: string, hostId?: string) => Promise<boolean>,
): TerminalRouter => ({
  isLocalHostId: (hostId: string | undefined | null) =>
    hostId === undefined || hostId === null || hostId.trim() === "" ||
    hostId === "local" || hostId === "cc-local",
  deleteBinding,
}) as unknown as TerminalRouter;

describe("terminal node-delete fence", () => {
  it("invalidates an older in-flight create before awaiting exact teardown", async () => {
    let finishStop!: (clean: boolean) => void;
    const deleteBinding = vi.fn(
      () => new Promise<boolean>((resolve) => {
        finishStop = resolve;
      }),
    );
    const service = new TerminalNodeDeleteService(makeRouter(deleteBinding));
    const admittedBeforeDelete = service.admitCreate("binding-a", "cc-local");

    const begin = service.beginNodeDelete([
      { bindingId: "binding-a", hostId: "local" },
    ]);

    expect(service.isLocked("binding-a", "cc-local")).toBe(true);
    expect(() => service.assertCreate(admittedBeforeDelete)).toThrow(
      /revoked by node deletion/u,
    );
    expect(() => service.admitCreate("binding-a", "local")).toThrow(
      /deletion is in progress/u,
    );
    expect(deleteBinding).toHaveBeenCalledWith("binding-a", "local");

    finishStop(true);
    const lease = await begin;
    expect(lease).toMatchObject({ ok: true });
    if (!lease.ok) throw new Error(lease.error);
    expect(service.isLocked("binding-a", "local")).toBe(true);
    expect(service.finishNodeDelete(lease.leaseId, "committed")).toEqual({
      ok: true,
    });
    expect(service.isLocked("binding-a", "local")).toBe(false);
    expect(() => service.assertCreate(admittedBeforeDelete)).toThrow(
      /revoked by node deletion/u,
    );
    const admittedAfterDelete = service.admitCreate("binding-a", "local");
    expect(() => service.assertCreate(admittedAfterDelete)).not.toThrow();
  });

  it("fails closed and releases the lease when exact cleanup is unproven", async () => {
    const deleteBinding = vi.fn(async () => false);
    const service = new TerminalNodeDeleteService(makeRouter(deleteBinding));

    const result = await service.beginNodeDelete([
      { bindingId: "binding-dirty", hostId: "local" },
    ]);

    expect(result).toEqual({
      ok: false,
      error:
        "terminal binding-dirty did not produce an exact clean teardown receipt",
    });
    expect(service.isLocked("binding-dirty", "local")).toBe(false);
    const admitted = service.admitCreate("binding-dirty", "local");
    expect(() => service.assertCreate(admitted)).not.toThrow();
  });

  it("retains every sibling lock until all teardown receipts settle", async () => {
    let finishSlow!: (clean: boolean) => void;
    const deleteBinding = vi.fn((bindingId: string) =>
      bindingId === "fast-dirty"
        ? Promise.resolve(false)
        : new Promise<boolean>((resolve) => {
            finishSlow = resolve;
          })
    );
    const service = new TerminalNodeDeleteService(makeRouter(deleteBinding));

    const begin = service.beginNodeDelete([
      { bindingId: "fast-dirty", hostId: "local" },
      { bindingId: "slow-clean", hostId: "local" },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.isLocked("fast-dirty", "local")).toBe(true);
    expect(service.isLocked("slow-clean", "local")).toBe(true);

    finishSlow(true);
    await expect(begin).resolves.toMatchObject({ ok: false });
    expect(service.isLocked("fast-dirty", "local")).toBe(false);
    expect(service.isLocked("slow-clean", "local")).toBe(false);
  });

  it("deduplicates local host aliases but refuses a Remote teardown receipt", async () => {
    const deleteBinding = vi.fn(async (_bindingId: string, hostId?: string) =>
      hostId === "local"
    );
    const service = new TerminalNodeDeleteService(makeRouter(deleteBinding));

    const local = await service.beginNodeDelete([
      { bindingId: "same", hostId: "local" },
      { bindingId: "same", hostId: "cc-local" },
    ]);
    expect(local.ok).toBe(true);
    expect(deleteBinding).toHaveBeenCalledTimes(1);
    if (local.ok) service.finishNodeDelete(local.leaseId, "aborted");

    const remote = await service.beginNodeDelete([
      { bindingId: "same", hostId: "remote-a" },
    ]);
    expect(remote).toMatchObject({ ok: false });
    expect(deleteBinding).toHaveBeenLastCalledWith("same", "remote-a");
  });
});
