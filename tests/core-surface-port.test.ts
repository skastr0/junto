import { expect, it, vi } from "vitest";
import { openCoreSurface } from "../src/core/ops/term-surface";
import { coreSurfacePlane, type PortedCoreMessage } from "../src/app/core-process/main-side/term-surface";
import { SURFACE_OPENED } from "../src/contract/core/channels";
import { termPlane } from "../src/core/term/plane";

// Plan B: a view's surface port rides from main to the core's plane, which says whether it opened.
it("carries a surface port to the core's plane, answers whether it opened, and closes it by its lease", async () => {
  const pushes = new Map<string, (payload: unknown) => void>();
  const opened: Array<[string, bigint | undefined]> = [];
  const open = vi.spyOn(termPlane.host, "openSurface").mockImplementation((lease, port, options) => {
    if (lease.mode !== "control") {
      port.close();
      return undefined;
    }
    opened.push([lease.leaseId, options?.read]);
    return () => undefined;
  });
  const close = vi.spyOn(termPlane.host, "closeSurface").mockImplementation(() => undefined);
  const plane = coreSurfacePlane({
    // The core process's side, as entry.ts runs it on the transferred port.
    postSurface: (message: PortedCoreMessage, port) => {
      if (message.kind !== "surfaceOpen") return false;
      queueMicrotask(() => openCoreSurface(message, port as { close: () => void }, (channel, payload) => pushes.get(channel)?.(payload)));
      return true;
    },
    onPush: (channel, listener) => (pushes.set(channel, listener), () => pushes.delete(channel)),
    // What the core's TermSurfaceClose handler does (ops/term-ipc.ts).
    closeSurface: async (lease) => termPlane.host.closeSurface(lease),
  });
  try {
    const port = { close: vi.fn() };
    const lease = { leaseId: "l1", bindingId: "b", epoch: "e", mode: "control" } as never;
    const stop = await plane.open(lease, port, 7n);
    expect(stop).toBeDefined();
    expect(opened).toEqual([["l1", 7n]]);
    stop!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledExactlyOnceWith(lease);

    const observePort = { close: vi.fn() };
    expect(await plane.open({ leaseId: "l2", bindingId: "b", epoch: "e", mode: "observe" } as never, observePort)).toBeUndefined();
    expect(observePort.close).toHaveBeenCalledOnce();

    const noCore = coreSurfacePlane({ postSurface: () => false, onPush: () => () => undefined, closeSurface: async () => undefined });
    const unsent = { close: vi.fn() };
    expect(await noCore.open(lease, unsent)).toBeUndefined();
    expect(unsent.close).toHaveBeenCalledOnce();
    expect(pushes.has(SURFACE_OPENED)).toBe(true);
  } finally {
    open.mockRestore();
    close.mockRestore();
  }
});
